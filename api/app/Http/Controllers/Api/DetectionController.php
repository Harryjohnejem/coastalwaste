<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionImage;
use App\Models\DetectionLog;
use App\Models\MissedDetectionReport;
use App\Models\SystemSetting;
use App\Models\User;
use App\Support\DashboardCache;
use App\Support\DatasetAttribution;
use App\Support\DetectionNotifier;
use App\Support\WasteClassifier;
use App\Support\WastePresence;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class DetectionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $limit = min((int) $request->query('limit', 50), 200);

        $detections = Detection::query()
            ->with(['camera:id,camera_code', 'classification:id,waste_type,category_id', 'classification.category:id,category_name', 'latestImage', 'latestLog'])
            ->where('status', '!=', 'Ignored')
            ->notMovedToReview()
            ->when($request->filled('status'), function ($query) use ($request) {
                $query->where('status', (string) $request->query('status'));
            })
            ->when($request->filled('camera_id'), function ($query) use ($request) {
                $code = (string) $request->query('camera_id');
                $cameraId = Camera::query()->where('camera_code', $code)->value('id');
                $query->where('camera_id', $cameraId ?: 0);
            })
            ->orderByDesc('detected_at')
            ->limit($limit)
            ->get()
            ->map(fn (Detection $detection) => $detection->toApiArray());

        return response()->json($detections);
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
            'detections.*.left' => ['nullable', 'numeric'],
            'detections.*.top' => ['nullable', 'numeric'],
            'detections.*.width' => ['nullable', 'numeric'],
            'detections.*.height' => ['nullable', 'numeric'],
            'detections.*.histogram' => ['nullable', 'array', 'max:32'],
            'detections.*.histogram.*' => ['numeric'],
            'status_updates' => ['nullable', 'array'],
            'status_updates.*.detection_id' => ['required', 'integer'],
            'status_updates.*.status' => ['required', 'in:Present,Confirmed Cleaned'],
            'status_updates.*.last_seen_at' => ['nullable', 'date'],
            'status_updates.*.reason' => ['nullable', 'string', 'max:64'],
            'status_updates.*.class' => ['nullable', 'string', 'max:120'],
        ]);

        $cameraCode = $data['camera_id'];
        $boxes = $data['boxes'] ?? [];

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

        $camera = Camera::query()->where('camera_code', $cameraCode)->first();
        if (! $camera && ! empty($data['detections'])) {
            return response()->json(['message' => 'Camera not found.'], 422);
        }
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

                $created = false;
                if (! $existing) {
                    // Merged Local 1 + Local 2 YOLO model: do not invent which subset
                    // "caused" this prediction. Camera code remains the detection source.
                    $attribution = DatasetAttribution::forMergedModelLiveDetection();
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
                $this->storeSnapshot($existing, $row['snapshot'] ?? null);

                return [$existing, $created];
            });

            [$detection, $wasCreated] = $result;

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
        }

        if ($createdNew || $cleaned) {
            DashboardCache::flush();
        }

        return response()->json([
            'ok' => true,
            'boxes' => count($boxes),
            'logged' => count($created),
            'saved_tracks' => $savedTracks,
            'detections' => $created,
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

        DashboardCache::flush();

        return response()->json(['deleted' => true, 'id' => $id]);
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
                DashboardCache::flush();
            }

            return response()->json($existing->load(['camera', 'annotations'])->toApiArray());
        }

        $detection->loadMissing(['camera', 'images', 'logs', 'observations']);
        $image = $detection->images->sortByDesc('id')->first();
        if (! $image || ! Storage::disk('public')->exists($image->image_path)) {
            return response()->json([
                'message' => 'This detection has no snapshot to review.',
            ], 422);
        }

        $ext = pathinfo((string) $image->image_path, PATHINFO_EXTENSION) ?: 'jpg';
        $name = (string) Str::uuid().'.'.$ext;
        $path = 'missed-detections/'.$name;
        if (! Storage::disk('public')->copy($image->image_path, $path)) {
            return response()->json([
                'message' => 'The snapshot could not be copied into review.',
            ], 422);
        }

        $label = (string) ($detection->logs->sortByDesc('id')->first()?->raw_label
            ?: $detection->classification?->waste_type
            ?: 'Unrecognized');
        $detection->update(['moved_to_review' => true]);

        $report = MissedDetectionReport::query()->create([
            'user_id' => $user->id,
            'camera_id' => $detection->camera_id,
            'source_detection_id' => $detection->id,
            'description' => trim(
                "Moved from detection #{$detection->id}. Original class: {$label}."
                ." Confidence {$detection->confidence}."
                .' Label it for the training dataset, or reject it.'
            ),
            'proposal_label' => $label,
            'image_path' => $path,
            'image_name' => $image->image_name ?: $name,
            'status' => MissedDetectionReport::PENDING,
            'include_in_export' => false,
        ]);

        DashboardCache::flush();

        return response()->json($report->load(['camera', 'annotations'])->toApiArray(), 201);
    }

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }

    private function detectionEnabled(): bool
    {
        return (bool) Cache::remember('settings:detection_enabled', 3, function () {
            $stored = SystemSetting::getDefault();
            $detection = is_array($stored['detection'] ?? null) ? $stored['detection'] : [];
            if (! array_key_exists('enabled', $detection)) {
                return true;
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
}
