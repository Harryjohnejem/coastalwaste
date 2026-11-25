<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionImage;
use App\Models\DetectionLog;
use App\Models\DetectionObservation;
use App\Models\MissedDetectionAnnotation;
use App\Models\MissedDetectionReport;
use App\Models\SystemSetting;
use App\Models\User;
use App\Support\DashboardCache;
use App\Support\DatasetAttribution;
use App\Support\DatasetClasses;
use App\Support\DetectionNotifier;
use App\Support\WasteClassifier;
use App\Support\WasteClassMap;
use App\Support\WasteLoad;
use App\Support\WastePresence;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class DetectionController extends Controller
{
    /** Waste Detections saves a live detection only at this confidence or higher. */
    public const WASTE_DETECTION_MIN_CONFIDENCE = 80.0;

    public function index(Request $request): JsonResponse
    {
        WastePresence::sweepStale();
        $limit = min(max((int) $request->query('limit', 50), 1), 1000);
        $perClass = $request->boolean('per_class');
        $filtered = $request->filled('status') || $request->filled('camera_id');
        $cacheKey = $filtered ? null : DashboardCache::detectionsKey($limit, $perClass);
        if ($cacheKey) {
            $cached = Cache::get($cacheKey);
            if (is_array($cached)) {
                return response()->json($cached);
            }
        }

        $ids = $this->limitedDetectionIds($request, $limit, $perClass);
        $detections = $ids === []
            ? []
            : Detection::query()
                ->with(['camera:id,camera_code', 'classification:id,waste_type,category_id', 'classification.category:id,category_name', 'latestImage', 'latestLog'])
                ->whereIn('id', $ids)
                ->orderByDesc('detected_at')
                ->orderByDesc('id')
                ->get()
                ->map(fn (Detection $detection) => $detection->toApiArray())
                ->values()
                ->all();

        if ($cacheKey) {
            Cache::put($cacheKey, $detections, DashboardCache::TTL_SECONDS);
        }

        return response()->json($detections);
    }

    /**
     * Newest hits overall, or the newest hits of each waste class.
     *
     * @return list<int>
     */
    private function limitedDetectionIds(Request $request, int $limit, bool $perClass): array
    {
        $query = Detection::query()
            ->where('status', '!=', 'Ignored')
            ->notMovedToReview()
            ->when($request->filled('status'), function ($inner) use ($request) {
                $inner->where('status', (string) $request->query('status'));
            })
            ->when($request->filled('camera_id'), function ($inner) use ($request) {
                $code = (string) $request->query('camera_id');
                $cameraId = Camera::query()->where('camera_code', $code)->value('id');
                $inner->where('camera_id', $cameraId ?: 0);
            });

        if (! $perClass) {
            return $query
                ->orderByDesc('detected_at')
                ->orderByDesc('id')
                ->limit($limit)
                ->pluck('id')
                ->map(fn ($id) => (int) $id)
                ->all();
        }

        $ranked = (clone $query)
            ->select('detections.id')
            ->selectRaw('ROW_NUMBER() OVER (PARTITION BY COALESCE(detections.classification_id, 0) ORDER BY detections.detected_at DESC, detections.id DESC) as hit_rank');

        return DB::query()
            ->fromSub($ranked, 'ranked_hits')
            ->where('hit_rank', '<=', $limit)
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->all();
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['nullable', 'string', 'max:32'],
            'class' => ['required', 'string', 'max:120'],
            'confidence' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'count' => ['nullable', 'integer', 'min:1', 'max:999'],
            'sector' => ['nullable', 'string', 'max:120'],
            'location' => ['nullable', 'string', 'max:120'],
            'severity' => ['nullable', 'string', 'max:32'],
            'subtitle' => ['nullable', 'string', 'max:255'],
        ]);

        $camera = isset($data['camera_id'])
            ? Camera::query()->where('camera_code', $data['camera_id'])->first()
            : null;

        if (! $camera) {
            return response()->json(['message' => 'Camera not found.'], 422);
        }

        $classification = WasteClassifier::resolve($data['class']);

        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => WasteClassifier::confidencePercent(
                isset($data['confidence']) ? (float) $data['confidence'] : null
            ),
            'quantity' => $data['count'] ?? 1,
            'location' => $data['location'] ?? $data['sector'] ?? $camera->monitoring_location,
            'detected_at' => now(),
            'status' => 'Detected',
        ]);

        DetectionNotifier::notifyNewDetection($detection);
        DashboardCache::flush();

        return response()->json(
            $detection->fresh(['camera', 'classification.category', 'latestImage', 'latestLog'])
                ->toApiArray(),
            201,
        );
    }

    public function live(Request $request): JsonResponse
    {
        $cameraId = (string) $request->query('camera_id', 'CAM-01');
        $payload = Cache::get($this->overlayKey($cameraId), [
            'camera_id' => $cameraId,
            'boxes' => [],
            'inference_ms' => null,
            'model' => null,
            'updated_at' => null,
        ]);

        return response()->json($payload)->header('Cache-Control', 'no-store');
    }

    public function ingestLive(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['required', 'string', 'max:32'],
            'boxes' => ['nullable', 'array'],
            'boxes.*.id' => ['nullable', 'string'],
            'boxes.*.class' => ['required_with:boxes', 'string'],
            'boxes.*.confidence' => ['nullable', 'numeric'],
            'boxes.*.left' => ['nullable', 'numeric'],
            'boxes.*.top' => ['nullable', 'numeric'],
            'boxes.*.width' => ['nullable', 'numeric'],
            'boxes.*.height' => ['nullable', 'numeric'],
            'boxes.*.severity' => ['nullable', 'string'],
            'boxes.*.variant' => ['nullable', 'string'],
            'boxes.*.track_id' => ['nullable', 'integer'],
            'boxes.*.confirmed' => ['nullable', 'boolean'],
            'boxes.*.frames' => ['nullable', 'integer'],
            'inference_ms' => ['nullable', 'integer'],
            'model' => ['nullable', 'string', 'max:2000'],
            'tracker_session' => ['nullable', 'string', 'max:64'],
            'detections' => ['nullable', 'array'],
            'detections.*.class' => ['required_with:detections', 'string'],
            'detections.*.confidence' => ['nullable', 'numeric'],
            'detections.*.count' => ['nullable', 'integer'],
            'detections.*.severity' => ['nullable', 'string'],
            'detections.*.sector' => ['nullable', 'string'],
            'detections.*.subtitle' => ['nullable', 'string'],
            'detections.*.frame_id' => ['nullable', 'integer'],
            'detections.*.snapshot' => ['nullable', 'string', 'max:12000000'],
            'detections.*.review_snapshot' => ['nullable', 'string', 'max:12000000'],
            'detections.*.review_only' => ['nullable', 'boolean'],
            'detections.*.left' => ['nullable', 'numeric'],
            'detections.*.top' => ['nullable', 'numeric'],
            'detections.*.width' => ['nullable', 'numeric'],
            'detections.*.height' => ['nullable', 'numeric'],
            'detections.*.histogram' => ['nullable', 'array', 'max:32'],
            'detections.*.histogram.*' => ['numeric'],
            'status_updates' => ['nullable', 'array'],
            'status_updates.*.detection_id' => ['required', 'integer'],
            'status_updates.*.status' => ['required', 'in:Present,No Longer Visible,Confirmed Cleaned'],
            'status_updates.*.last_seen_at' => ['nullable', 'date'],
            'status_updates.*.reason' => ['nullable', 'string', 'max:64'],
            'status_updates.*.class' => ['nullable', 'string', 'max:120'],
            'visible_detection_ids' => ['nullable', 'array'],
            'visible_detection_ids.*' => ['integer'],
        ]);

        $cameraCode = $data['camera_id'];
        $boxes = $data['boxes'] ?? [];
        $camera = Camera::query()->where('camera_code', $cameraCode)->first();
        if (! $camera && ! empty($data['detections'])) {
            return response()->json(['message' => 'Camera not found.'], 422);
        }

        if (! $this->detectionEnabled()) {
            Cache::put($this->overlayKey($cameraCode), [
                'camera_id' => $cameraCode,
                'boxes' => [],
                'inference_ms' => null,
                'model' => $data['model'] ?? null,
                'updated_at' => now()->toIso8601String(),
                'paused' => true,
            ], now()->addSeconds(30));

            return response()->json([
                'logged' => 0,
                'detections' => [],
                'paused' => true,
            ]);
        }

        Cache::put($this->overlayKey($cameraCode), [
            'camera_id' => $cameraCode,
            'boxes' => $boxes,
            'inference_ms' => $data['inference_ms'] ?? null,
            'model' => $data['model'] ?? 'YOLO · waste',
            'updated_at' => now()->toIso8601String(),
        ], now()->addSeconds(30));

        if ($camera) {
            $heartbeatKey = 'camera:heartbeat:'.$camera->id;
            if (! Cache::has($heartbeatKey)) {
                $camera->update([
                    'status' => 'Online',
                    'last_seen' => now(),
                ]);
                Cache::put($heartbeatKey, 1, 8);
            }
        }

        $created = [];
        $reviews = [];
        $createdNew = false;
        $savedTracks = [];
        $modelName = $data['model'] ?? 'YOLO';
        $trackerSession = $data['tracker_session'] ?? null;
        $inferenceMs = $data['inference_ms'] ?? null;
        $incoming = $data['detections'] ?? [];

        foreach ($incoming as $row) {
            if (! $camera) {
                break;
            }

            $trackId = null;
            if (preg_match('/Track\s+(\d+)/', (string) ($row['subtitle'] ?? ''), $trackMatch)) {
                $trackId = (int) $trackMatch[1];
            }

            $datasetClass = \App\Support\DatasetClasses::match((string) ($row['class'] ?? ''));
            if ($datasetClass === null) {
                continue;
            }
            $row['class'] = $datasetClass;

            $classification = WasteClassifier::resolve($row['class']);
            $confidence = WasteClassifier::confidencePercent(
                isset($row['confidence']) ? (float) $row['confidence'] : null
            );

            // Waste Detections keeps only sure, zoomed snapshots (80% and up).
            // Anything lower goes to Detection Reviews only, as the full frame.
            if (! empty($row['review_only']) || $confidence < self::WASTE_DETECTION_MIN_CONFIDENCE) {
                // Only 60-79% (Settings > Detection > Review confidence) is saved for review.
                if ($confidence < $this->reviewConfidenceFloor()) {
                    continue;
                }
                $review = $this->createLiveReview($camera, $row, $confidence, $row['review_snapshot'] ?? null, null);
                $reviews[] = [
                    'id' => $review?->id,
                    'subtitle' => $trackId !== null ? 'Track '.$trackId : ($row['subtitle'] ?? null),
                ];

                continue;
            }

            /** @var array{0: Detection, 1: bool} $result */
            $result = DB::transaction(function () use ($camera, $row, $trackId, $classification, $confidence, $modelName, $trackerSession, $inferenceMs) {
                // Each camera keeps its own record. Appearance alone does not
                // merge a sighting from a different camera into this one.
                $existing = null;
                if ($trackId !== null) {
                    $existingQuery = DetectionLog::query()
                        ->where('frame_number', $trackId)
                        ->whereHas('detection', function ($query) use ($camera) {
                            $query->where('camera_id', $camera->id);
                        });
                    if ($trackerSession) {
                        $existingQuery->where('model_version', $trackerSession);
                    } else {
                        $existingQuery->where('created_at', '>=', now()->subSeconds(8));
                    }
                    $existing = $existingQuery->orderByDesc('id')->first()?->detection;
                }
                if ($existing === null) {
                    $existing = WastePresence::findSameCameraOverlap($camera, $row);
                }

                $created = false;
                if ($existing) {
                    $updates = ['last_seen_at' => now()];
                    if ($confidence > (float) $existing->confidence) {
                        $updates['confidence'] = $confidence;
                    }
                    $existing->update($updates);
                    if ($trackId !== null) {
                        DetectionLog::query()->updateOrCreate(
                            [
                                'detection_id' => $existing->id,
                                'frame_number' => $trackId,
                                'model_version' => $trackerSession,
                            ],
                            [
                                'model_name' => $modelName,
                                'raw_label' => $row['class'],
                                'confidence' => $confidence,
                                'processing_time_ms' => $inferenceMs,
                                'created_at' => now(),
                            ],
                        );
                    }
                } else {
                    // The dataset and model the cameras use right now (set by Deploy/Rollback).
                    $attribution = DatasetAttribution::forLiveModel();
                    $existing = Detection::query()->create([
                        'camera_id' => $camera->id,
                        'classification_id' => $classification->id,
                        'confidence' => $confidence,
                        'quantity' => $row['count'] ?? 1,
                        'location' => $row['sector'] ?? $camera->monitoring_location,
                        'detected_at' => now(),
                        'last_seen_at' => now(),
                        'object_key' => (string) Str::uuid(),
                        'status' => 'Present',
                        'training_dataset' => $attribution['training_dataset'],
                        'training_model' => $attribution['training_model'],
                        'dataset_attribution' => $attribution['dataset_attribution'],
                    ]);

                    DetectionLog::query()->create([
                        'detection_id' => $existing->id,
                        'frame_number' => $trackId,
                        'model_name' => $modelName,
                        'model_version' => $trackerSession,
                        'raw_label' => $row['class'],
                        'confidence' => $confidence,
                        'processing_time_ms' => $inferenceMs,
                        'created_at' => now(),
                    ]);
                    $created = true;
                }

                WastePresence::rememberObservation($existing, $camera, $row, $trackId, $trackerSession);

                return [$existing, $created];
            });

            [$detection, $wasCreated] = $result;
            $this->storeSnapshot($detection, $row['snapshot'] ?? null);
            // 80% and up is saved in Waste Detections only. Detection Reviews is
            // filled automatically with 60-79% only (an admin can still use
            // "Move to Review" on any record).

            if ($wasCreated) {
                DetectionNotifier::notifyNewDetection($detection);
            }

            if ($trackId !== null && $detection->id) {
                $savedTracks[] = $trackId;
            }
            $created[] = [
                'id' => $detection->id,
                'subtitle' => $trackId !== null ? 'Track '.$trackId : ($row['subtitle'] ?? null),
            ];
            if ($wasCreated) {
                $createdNew = true;
            }
        }

        $presence = [];
        $cleaned = false;
        if ($camera) {
            foreach ($data['status_updates'] ?? [] as $update) {
                $result = WastePresence::applyStatus($camera, $update);
                if ($result === 'cleaned') {
                    $cleaned = true;
                }
                $presence[] = [
                    'detection_id' => $update['detection_id'] ?? null,
                    'result' => $result,
                ];
            }
            if (array_key_exists('visible_detection_ids', $data)) {
                $expired = WastePresence::syncVisible(
                    $camera,
                    array_values($data['visible_detection_ids'] ?? []),
                );
                if ($expired > 0) {
                    $cleaned = true;
                }
            }
        }

        if ($createdNew || $cleaned) {
            DashboardCache::flush();
            $this->rememberDetectionsList();
        }
        // Every frame refreshes the cleanup threshold, so the dashboard banner
        // reads a ready answer instead of counting again on each poll.
        WasteLoad::check();

        return response()->json([
            'ok' => true,
            'boxes' => count($boxes),
            'logged' => count($created),
            'saved_tracks' => $savedTracks,
            'detections' => $created,
            'reviews' => $reviews,
            'presence' => $presence,
        ]);
    }

    public function destroy(Request $request, Detection $detection): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            abort(403);
        }

        $id = $detection->id;
        $paths = $detection->images()->pluck('image_path')->filter()->all();

        DB::transaction(function () use ($detection) {
            $detection->observations()->delete();
            $detection->images()->delete();
            $detection->logs()->delete();
            $detection->delete();
        });

        foreach ($paths as $path) {
            $stillUsed = DetectionImage::query()->where('image_path', $path)->exists()
                || MissedDetectionReport::query()->where('image_path', $path)->exists();
            if (! $stillUsed) {
                Storage::disk('public')->delete($path);
            }
        }

        $this->forgetDetectionFromFeed($id);

        return response()->json(['deleted' => true, 'id' => $id]);
    }

    /**
     * Delete many detections in one request and one transaction. The UI used
     * to send one DELETE per row, each waiting behind other requests.
     */
    public function destroyMany(Request $request): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            abort(403);
        }
        $data = $request->validate([
            'ids' => ['required', 'array', 'min:1', 'max:1000'],
            'ids.*' => ['integer'],
        ]);
        $ids = Detection::query()->whereIn('id', $data['ids'])->pluck('id')->map(fn ($id) => (int) $id)->all();
        if ($ids === []) {
            return response()->json(['deleted' => 0, 'ids' => []]);
        }
        $paths = DetectionImage::query()->whereIn('detection_id', $ids)->pluck('image_path')->filter()->unique()->all();

        DB::transaction(function () use ($ids) {
            DetectionObservation::query()->whereIn('detection_id', $ids)->delete();
            DetectionImage::query()->whereIn('detection_id', $ids)->delete();
            DetectionLog::query()->whereIn('detection_id', $ids)->delete();
            Detection::query()->whereIn('id', $ids)->delete();
        });

        if ($paths !== []) {
            $kept = DetectionImage::query()->whereIn('image_path', $paths)->pluck('image_path')
                ->merge(MissedDetectionReport::query()->whereIn('image_path', $paths)->pluck('image_path'))
                ->flip();
            $unused = array_values(array_filter($paths, fn ($path) => ! $kept->has($path)));
            if ($unused !== []) {
                Storage::disk('public')->delete($unused);
            }
        }

        $this->forgetDetectionsFromFeed($ids);

        return response()->json(['deleted' => count($ids), 'ids' => $ids]);
    }

    public function moveToReview(Request $request, Detection $detection): JsonResponse
    {
        $user = $request->user();
        if (! $this->isAdmin($user)) {
            abort(403);
        }

        $existing = MissedDetectionReport::query()
            ->where('source_detection_id', $detection->id)
            ->latest('id')
            ->first();
        if ($existing) {
            if (! $detection->moved_to_review) {
                $detection->update(['moved_to_review' => true]);
                $this->forgetDetectionFromFeed($detection->id);
            }

            return response()->json($existing->load(['camera', 'annotations'])->toApiArray());
        }

        $report = $this->createReviewFromDetection($detection, (int) $user->id, 'Moved from', 'moved_from_detection');
        if (is_string($report)) {
            return response()->json(['message' => $report], 422);
        }
        $detection->update(['moved_to_review' => true]);

        $this->forgetDetectionFromFeed($detection->id);

        return response()->json($report->fresh()->load(['camera', 'annotations'])->toApiArray(), 201);
    }

    /**
     * Copy a saved detection (snapshot + box) into Detection Reviews.
     * Returns the review, or an error message when there is no usable snapshot.
     */
    private function createReviewFromDetection(
        Detection $detection,
        int $userId,
        string $verb,
        string $reason,
    ): MissedDetectionReport|string {
        $detection->loadMissing(['camera', 'images', 'logs', 'observations', 'classification', 'latestObservation']);
        $image = $detection->images->sortByDesc('id')->first();
        if (! $image || ! Storage::disk('public')->exists($image->image_path)) {
            return 'This detection has no snapshot to review.';
        }

        $ext = pathinfo((string) $image->image_path, PATHINFO_EXTENSION) ?: 'jpg';
        $name = (string) Str::uuid().'.'.$ext;
        $path = 'missed-detections/'.$name;
        if (! Storage::disk('public')->copy($image->image_path, $path)) {
            return 'The snapshot could not be copied into review.';
        }

        $label = (string) ($detection->logs->sortByDesc('id')->first()?->raw_label
            ?: $detection->classification?->waste_type
            ?: 'Unrecognized');

        $report = MissedDetectionReport::query()->create([
            'user_id' => $userId,
            'camera_id' => $detection->camera_id,
            'source_detection_id' => $detection->id,
            'description' => trim(
                "{$verb} detection #{$detection->id}. Original class: {$label}."
                ." Confidence {$detection->confidence}."
                .' Label it for the training dataset, or reject it.'
            ),
            'proposal_label' => $label,
            'original_prediction' => $label,
            'original_prediction_confidence' => $detection->confidence,
            'image_path' => $path,
            'image_name' => $image->image_name ?: $name,
            'status' => MissedDetectionReport::PENDING,
            'include_in_export' => false,
        ]);
        $original = $report->modelOverlay();
        $report->update([
            'original_prediction' => $original['prediction'] ?: $label,
            'original_prediction_confidence' => $original['prediction_confidence'],
            'original_model_boxes' => $original['model_boxes'],
        ]);
        $this->copyDetectionBoxToReview($report, $detection, $label, $reason);

        return $report;
    }

    /**
     * Every saved live detection is copied into Detection Reviews once, as
     * soon as its snapshot exists. It stays in Waste Detections. A review the
     * user deletes is not created again (auto_reviewed_at is kept).
     */
    private function autoQueueReview(Detection $detection): void
    {
        if ($detection->auto_reviewed_at !== null || ! $detection->images()->exists()) {
            return;
        }
        $already = MissedDetectionReport::query()->where('source_detection_id', $detection->id)->exists();
        if (! $already) {
            $ownerId = $this->reviewOwnerId();
            if ($ownerId === null) {
                return;
            }
            try {
                $result = $this->createReviewFromDetection($detection, $ownerId, 'Auto-captured from', 'auto_captured');
            } catch (\Throwable $e) {
                report($e);

                return;
            }
            if (is_string($result)) {
                return;
            }
        }
        $detection->forceFill(['auto_reviewed_at' => now()])->save();
    }

    /**
     * Save one full livestream frame into Detection Reviews with the AI box on it.
     * The box is a percent of the full frame, so it lines up with this image.
     */
    private function createLiveReview(
        Camera $camera,
        array $row,
        float $confidence,
        ?string $frame,
        ?int $sourceDetectionId,
    ): ?MissedDetectionReport {
        if (! is_string($frame) || $frame === '') {
            return null;
        }
        // Automatic reviews are only for the uncertain band: review floor (60%) up to 79%.
        if ($confidence >= self::WASTE_DETECTION_MIN_CONFIDENCE || $confidence < $this->reviewConfidenceFloor()) {
            return null;
        }
        $binary = base64_decode($frame, true);
        if ($binary === false || $binary === '') {
            return null;
        }
        $ownerId = $this->reviewOwnerId();
        if ($ownerId === null) {
            return null;
        }

        $name = (string) Str::uuid().'.jpg';
        $path = 'missed-detections/'.$name;
        if (Storage::disk('public')->put($path, $binary) !== true) {
            return null;
        }

        $label = (string) ($row['class'] ?? 'Unrecognized');
        $className = DatasetClasses::match($label) ?: $label;
        $report = MissedDetectionReport::query()->create([
            'user_id' => $ownerId,
            'camera_id' => $camera->id,
            'source_detection_id' => $sourceDetectionId,
            'description' => trim(
                'Auto-captured full frame from '.$camera->camera_code.'. Original class: '.$label.'.'
                .' Confidence '.$confidence.'.'
                .' Label it for the training dataset, or reject it.'
            ),
            'proposal_label' => $className,
            'original_prediction' => $label,
            'original_prediction_confidence' => round($confidence / 100, 4),
            'image_path' => $path,
            'image_name' => $name,
            'status' => MissedDetectionReport::PENDING,
            'include_in_export' => false,
        ]);

        $box = $this->percentBox($row['left'] ?? null, $row['top'] ?? null, $row['width'] ?? null, $row['height'] ?? null);
        $classIndex = WasteClassMap::index($className);
        if ($box !== null && $classIndex !== null) {
            MissedDetectionAnnotation::query()->create([
                'report_id' => $report->id,
                'class_name' => $className,
                'class_index' => $classIndex,
                ...$box,
            ]);
        }
        $report->update([
            'original_model_boxes' => $box !== null ? [['class_name' => $className, ...$box, 'source' => 'model', 'confidence' => round($confidence / 100, 4)]] : [],
            'proposal' => $box !== null ? [
                'label' => $className,
                'reason' => 'auto_captured',
                'confidence' => round($confidence / 100, 4),
                ...$box,
            ] : null,
        ]);

        return $report;
    }

    /** @return array{x:float,y:float,width:float,height:float}|null */
    private function percentBox(mixed $left, mixed $top, mixed $width, mixed $height): ?array
    {
        if ($width === null || $height === null) {
            return null;
        }
        $scale = (float) $width > 1 ? 100.0 : 1.0;
        $x = max(0.0, min(1.0, ((float) $left) / $scale));
        $y = max(0.0, min(1.0, ((float) $top) / $scale));
        $w = max(0.0, min(1.0 - $x, ((float) $width) / $scale));
        $h = max(0.0, min(1.0 - $y, ((float) $height) / $scale));
        if ($w <= 0 || $h <= 0) {
            return null;
        }

        return ['x' => round($x, 6), 'y' => round($y, 6), 'width' => round($w, 6), 'height' => round($h, 6)];
    }

    /** Reviews need an owner; live captures belong to the first admin account. */
    private function reviewOwnerId(): ?int
    {
        $id = Cache::remember('review:auto-owner', 300, function () {
            return User::query()->where('role', 'Admin')->orderBy('id')->value('id')
                ?? User::query()->orderBy('id')->value('id');
        });

        return $id !== null ? (int) $id : null;
    }

    private function copyDetectionBoxToReview(MissedDetectionReport $report, Detection $detection, string $label, string $reason = 'moved_from_detection'): void
    {
        $className = DatasetClasses::match($label) ?: $label;
        $classIndex = WasteClassMap::index($className);
        if ($classIndex === null) {
            return;
        }

        $observation = $detection->latestObservation
            ?: $detection->observations()->orderByDesc('id')->first();
        if (! $observation || $observation->box_width === null || $observation->box_height === null) {
            return;
        }

        $scale = (float) $observation->box_width > 1 ? 100.0 : 1.0;
        $x = max(0.0, min(1.0, ((float) $observation->box_left) / $scale));
        $y = max(0.0, min(1.0, ((float) $observation->box_top) / $scale));
        $width = max(0.0, min(1.0 - $x, ((float) $observation->box_width) / $scale));
        $height = max(0.0, min(1.0 - $y, ((float) $observation->box_height) / $scale));
        if ($width <= 0 || $height <= 0) {
            return;
        }

        MissedDetectionAnnotation::query()->create([
            'report_id' => $report->id,
            'class_name' => $className,
            'class_index' => $classIndex,
            'x' => round($x, 6),
            'y' => round($y, 6),
            'width' => round($width, 6),
            'height' => round($height, 6),
        ]);

        $confidence = $detection->confidence;
        if ($confidence !== null && (float) $confidence > 1) {
            $confidence = round(((float) $confidence) / 100, 4);
        }
        $report->update([
            'proposal_label' => $className,
            'proposal' => [
                'label' => $className,
                'reason' => $reason,
                'confidence' => $confidence,
                'x' => round($x, 6),
                'y' => round($y, 6),
                'width' => round($width, 6),
                'height' => round($height, 6),
            ],
        ]);
    }

    /**
     * Mark records as physically cleaned. Only the Barangay Sanitary Inspector
     * or an administrator; who and when are stored. Never automatic.
     */
    public function verifyCleaning(Request $request): JsonResponse
    {
        $user = $request->user();
        if (! $this->canVerifyCleaning($user)) {
            return response()->json(['message' => 'Only the Barangay Sanitary Inspector or an administrator can verify cleaning.'], 403);
        }
        $data = $request->validate([
            'ids' => ['required', 'array', 'min:1', 'max:1000'],
            'ids.*' => ['integer'],
        ]);
        $now = now();
        $rows = Detection::query()->whereIn('id', $data['ids'])
            ->whereNotIn('status', [Detection::IGNORED, Detection::VERIFIED])
            ->get();
        foreach ($rows as $detection) {
            $detection->status = Detection::VERIFIED;
            $detection->cleaning_verified_by = $user->id;
            $detection->cleaning_verified_at = $now;
            $detection->removed_at = $detection->removed_at ?? $now;
            $detection->save();
        }
        DashboardCache::flush();
        $this->rememberDetectionsList();

        return response()->json([
            'verified' => $rows->pluck('id')->values(),
            'verified_by' => $user->name,
            'verified_at' => $now->format('Y-m-d H:i:s'),
        ]);
    }

    private function canVerifyCleaning(?User $user): bool
    {
        $role = strtolower(trim((string) $user?->role));

        return $user !== null && in_array($role, ['admin', 'administrator', 'inspector', 'sanitary inspector', 'barangay sanitary inspector'], true);
    }

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }

    /** Lowest score saved to Detection Reviews, in percent (default 60). */
    private function reviewConfidenceFloor(): float
    {
        return (float) Cache::remember('settings:review_floor', 3, function () {
            $value = SystemSetting::getDefault()['detection']['review_confidence'] ?? 0.60;
            $value = is_numeric($value) ? (float) $value : 0.60;
            if ($value <= 1.0) {
                $value *= 100;
            }

            return max(25.0, min(79.0, $value));
        });
    }

    private function detectionEnabled(): bool
    {
        return (bool) Cache::remember('settings:detection_enabled', 3, function () {
            $stored = SystemSetting::getDefault();
            $detection = is_array($stored['detection'] ?? null) ? $stored['detection'] : [];
            if (! array_key_exists('enabled', $detection)) {
                return false;
            }

            return filter_var($detection['enabled'], FILTER_VALIDATE_BOOLEAN);
        });
    }

    private function storeSnapshot(Detection $detection, ?string $snapshot): void
    {
        if (! is_string($snapshot) || $snapshot === '') {
            return;
        }
        if ($detection->relationLoaded('latestImage') ? $detection->latestImage : $detection->images()->exists()) {
            return;
        }

        $binary = base64_decode($snapshot, true);
        if ($binary === false || $binary === '') {
            throw new \RuntimeException('Detection snapshot could not be decoded.');
        }

        $name = 'det-'.$detection->id.'-'.Str::lower(Str::random(8)).'.jpg';
        $path = 'detections/'.$name;
        $stored = Storage::disk('public')->put($path, $binary);
        if ($stored !== true) {
            return;
        }

        DetectionImage::query()->create([
            'detection_id' => $detection->id,
            'image_path' => $path,
            'image_name' => $name,
            'captured_at' => $detection->detected_at ?? now(),
        ]);
    }

    private function overlayKey(string $cameraId): string
    {
        return 'live_overlay:'.$cameraId;
    }

    /** Drop one record from the shared list without rebuilding every row. */
    private function forgetDetectionFromFeed(int $id): void
    {
        $this->forgetDetectionsFromFeed([$id]);
    }

    /**
     * @param  list<int>  $ids
     */
    private function forgetDetectionsFromFeed(array $ids): void
    {
        $gone = array_flip(array_map('intval', $ids));
        DashboardCache::flush();
        $disk = Storage::disk('public');
        if (! $disk->exists('detections-feed.json')) {
            return;
        }
        $decoded = json_decode((string) $disk->get('detections-feed.json'), true);
        if (! is_array($decoded)) {
            return;
        }
        $rows = array_values(array_filter(
            $decoded,
            fn ($row) => is_array($row) && ! isset($gone[(int) ($row['id'] ?? 0)]),
        ));
        $disk->put('detections-feed.json', json_encode($rows, JSON_UNESCAPED_SLASHES));
        Cache::put(DashboardCache::detectionsKey(200), $rows, 30);
        Cache::put(DashboardCache::detectionsKey(50), array_slice($rows, 0, 50), 30);
    }

    /** Shared file cache so the UI process can list records without waiting on ingest. */
    private function rememberDetectionsList(): void
    {
        $rows = Detection::query()
            ->with(['camera:id,camera_code', 'classification:id,waste_type,category_id', 'classification.category:id,category_name', 'latestImage', 'latestLog'])
            ->where('status', '!=', 'Ignored')
            ->notMovedToReview()
            ->orderByDesc('detected_at')
            ->limit(200)
            ->get()
            ->map(fn (Detection $detection) => $detection->toApiArray())
            ->values()
            ->all();

        Cache::put(DashboardCache::detectionsKey(200), $rows, 30);
        Cache::put(DashboardCache::detectionsKey(50), array_slice($rows, 0, 50), 30);
        Storage::disk('public')->put(
            'detections-feed.json',
            json_encode($rows, JSON_UNESCAPED_SLASHES),
        );
    }
}
