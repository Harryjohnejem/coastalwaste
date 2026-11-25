<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\TrainingJobItem;
use App\Models\TrainingJob;
use App\Models\User;
use App\Support\DatasetClasses;
use App\Support\ReviewDataset;
use App\Support\StoredZip;
use App\Support\WasteClassMap;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

class MissedDetectionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        if ($request->boolean('class_counts')) {
            $limit = min(1000, max(1, (int) $request->query('per_page', 50)));

            return response()->json([
                'limit' => $limit,
                'classes' => $this->classHitCounts($request, $limit),
            ]);
        }

        if ($request->boolean('ids_only')) {
            if ($request->boolean('per_class')) {
                $limit = min(1000, max(1, (int) $request->query('per_page', 50)));
                $ids = $this->cappedReviewIds($request, $limit);

                return response()->json([
                    'ids' => $ids,
                    'total' => count($ids),
                ]);
            }
            $query = MissedDetectionReport::query()->orderByDesc('id');
            $this->applyReviewFilters($query, $request);
            $ids = $query->pluck('id')->map(fn ($id) => (int) $id)->values();

            return response()->json([
                'ids' => $ids,
                'total' => $ids->count(),
            ]);
        }

        $counted = MissedDetectionReport::query()
            ->select('status', DB::raw('COUNT(*) as aggregate'))
            ->groupBy('status')
            ->pluck('aggregate', 'status');
        $counts = [];
        foreach ([
            MissedDetectionReport::PENDING,
            MissedDetectionReport::VERIFIED,
            MissedDetectionReport::CORRECTED,
            MissedDetectionReport::APPROVED,
            MissedDetectionReport::REJECTED,
            MissedDetectionReport::EXPORTED,
        ] as $status) {
            $counts[$status] = (int) ($counted[$status] ?? 0);
        }
        // Not yet trained: samples from a finished training run start over at zero.
        $trained = \App\Support\TrainingSamplePlan::trainedReportIds();
        $counts['training_eligible'] = (int) MissedDetectionReport::query()
            ->whereIn('status', [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED])
            ->where('include_in_export', true)
            ->when($trained !== [], fn ($q) => $q->whereNotIn('id', $trained))
            ->count();

        $query = MissedDetectionReport::query()
            ->with(['camera', 'annotations', 'sourceDetection.classification', 'sourceDetection.latestObservation'])
            ->orderByDesc('id');
        $this->applyReviewFilters($query, $request);

        $perPage = min(1000, max(1, (int) $request->query('per_page', 10)));
        if ($request->boolean('per_class')) {
            // per_page caps hits per class; page_size splits the capped list into pages.
            $ids = $this->cappedReviewIds($request, $perPage);
            $total = count($ids);
            $pageSize = min(1000, max(1, (int) $request->query('page_size', max(1, $total))));
            $lastPage = max(1, (int) ceil($total / $pageSize));
            $currentPage = min($lastPage, max(1, (int) $request->query('page', 1)));
            $pageIds = array_slice($ids, ($currentPage - 1) * $pageSize, $pageSize);
            $reports = $pageIds === []
                ? collect()
                : MissedDetectionReport::query()
                    ->with(['camera', 'annotations', 'sourceDetection.classification', 'sourceDetection.latestObservation'])
                    ->whereIn('id', $pageIds)
                    ->orderByDesc('id')
                    ->get();

            return response()->json([
                'data' => $reports->map(fn (MissedDetectionReport $report) => $report->toApiArray())->values(),
                'counts' => $counts,
                'meta' => [
                    'page' => $currentPage,
                    'per_page' => $pageSize,
                    'total' => $total,
                    'last_page' => $lastPage,
                ],
            ]);
        }
        $page = $query->paginate($perPage);

        return response()->json([
            'data' => $page->getCollection()->map(fn (MissedDetectionReport $report) => $report->toApiArray())->values(),
            'counts' => $counts,
            'meta' => [
                'page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'last_page' => $page->lastPage(),
            ],
        ]);
    }

    public function classes(): JsonResponse
    {
        $classes = [];
        foreach (WasteClassMap::classes() as $index => $name) {
            $classes[] = ['index' => $index, 'name' => $name];
        }

        return response()->json($classes);
    }

    /**
     * Detector-only. An object outside the 14 CCTV classes becomes a pending
     * review report. It does not create a live detection.
     */
    public function proposeUnfamiliar(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['required', 'string', 'max:32'],
            'label' => ['required', 'string', 'max:120'],
            'reason' => ['nullable', 'in:unfamiliar,uncertain,low_confidence'],
            'confidence' => ['nullable', 'numeric', 'between:0,1'],
            'image' => ['required', 'file', 'mimes:jpg,jpeg,png,webp', 'max:8192'],
            'x' => ['required', 'numeric', 'between:0,1'],
            'y' => ['required', 'numeric', 'between:0,1'],
            'width' => ['required', 'numeric', 'between:0,1'],
            'height' => ['required', 'numeric', 'between:0,1'],
        ]);

        $label = trim($data['label']);
        $reason = $data['reason'] ?? 'unfamiliar';
        if ($reason === 'low_confidence') {
            return response()->json([
                'queued' => false,
                'message' => 'Low-confidence classes stay in Detections. An admin moves a possible mistake to Detection Reviews.',
            ]);
        }
        // unfamiliar still cannot reuse a class the live model already has.
        if ($reason !== 'uncertain') {
            foreach (\App\Support\ClassRegistry::live() as $name) {
                if (strcasecmp($name, $label) === 0) {
                    return response()->json([
                        'message' => 'That class is already in the live model.',
                    ], 422);
                }
            }
        }
        $x = (float) $data['x'];
        $y = (float) $data['y'];
        $w = (float) $data['width'];
        $h = (float) $data['height'];
        if ($w <= 0 || $h <= 0 || $x + $w > 1.000001 || $y + $h > 1.000001) {
            return response()->json(['message' => 'The proposal box is outside the image.'], 422);
        }

        $camera = Camera::query()->where('camera_code', $data['camera_id'])->first();
        if (! $camera) {
            return response()->json(['message' => 'Camera not found.'], 422);
        }
        $admin = User::query()->whereRaw('LOWER(role) = ?', ['admin'])->orderBy('id')->first();
        if (! $admin) {
            return response()->json(['message' => 'No administrator is available to own the report.'], 422);
        }

        $existing = $this->recentProposal(
            (int) $camera->id,
            $label,
            $x,
            $y,
            $w,
            $h,
        );
        if ($existing) {
            return response()->json($existing->load(['camera', 'annotations'])->toApiArray());
        }

        $stored = $this->storeImage($request, null);
        if ($stored instanceof JsonResponse) {
            return $stored;
        }

        $confidence = isset($data['confidence']) ? round((float) $data['confidence'], 4) : null;
        $report = MissedDetectionReport::query()->create([
            'user_id' => $admin->id,
            'camera_id' => $camera->id,
            'description' => $this->proposalDescription($reason, $label, $confidence),
            'proposal_label' => $label,
            'original_prediction' => $label,
            'original_prediction_confidence' => isset($data['confidence']) ? round((float) $data['confidence'], 4) : null,
            'original_model_boxes' => [[
                'class_name' => $label,
                'x' => round($x, 6),
                'y' => round($y, 6),
                'width' => round($w, 6),
                'height' => round($h, 6),
                'source' => $reason === 'low_confidence' ? 'model' : 'proposal',
                'confidence' => isset($data['confidence']) ? round((float) $data['confidence'], 4) : null,
            ]],
            'proposal' => [
                'label' => $label,
                'reason' => $reason,
                'confidence' => $confidence,
                'x' => round($x, 6),
                'y' => round($y, 6),
                'width' => round($w, 6),
                'height' => round($h, 6),
            ],
            'image_path' => $stored['path'],
            'image_name' => $stored['name'],
            'status' => MissedDetectionReport::PENDING,
        ]);
        $this->seedProposalBox($report, $label, $x, $y, $w, $h);

        return response()->json($report->fresh()->load(['camera', 'annotations'])->toApiArray(), 201);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['required', 'string', 'max:32'],
            'description' => ['required', 'string', 'max:1000'],
            'image' => ['nullable', 'file', 'mimes:jpg,jpeg,png,webp', 'max:8192'],
            'detection_id' => ['nullable', 'integer'],
            'annotations' => ['nullable', 'array', 'max:40'],
            'annotations.*.class_name' => ['required_with:annotations', 'string', 'max:120'],
            'annotations.*.x' => ['required_with:annotations', 'numeric', 'between:0,1'],
            'annotations.*.y' => ['required_with:annotations', 'numeric', 'between:0,1'],
            'annotations.*.width' => ['required_with:annotations', 'numeric', 'between:0,1'],
            'annotations.*.height' => ['required_with:annotations', 'numeric', 'between:0,1'],
        ]);

        if (! $request->hasFile('image') && empty($data['detection_id'])) {
            return response()->json([
                'message' => 'Upload an image or choose an existing detection frame.',
            ], 422);
        }

        $camera = Camera::query()->where('camera_code', $data['camera_id'])->first();
        if (! $camera) {
            return response()->json(['message' => 'Camera not found.'], 422);
        }

        $stored = $this->storeImage($request, $data['detection_id'] ?? null);
        if ($stored instanceof JsonResponse) {
            return $stored;
        }

        $boxes = $this->normalizeBoxes($data['annotations'] ?? []);
        if ($boxes instanceof JsonResponse) {
            Storage::disk('public')->delete($stored['path']);

            return $boxes;
        }

        $report = DB::transaction(function () use ($request, $camera, $stored, $data, $boxes) {
            $report = MissedDetectionReport::query()->create([
                'user_id' => $request->user()->id,
                'camera_id' => $camera->id,
                'source_detection_id' => $data['detection_id'] ?? null,
                'description' => $data['description'],
                'image_path' => $stored['path'],
                'image_name' => $stored['name'],
                'status' => MissedDetectionReport::PENDING,
            ]);
            $this->replaceBoxes($report, $boxes);

            return $report->load(['camera', 'annotations']);
        });

        return response()->json($report->toApiArray(), 201);
    }

    public function updateAnnotations(Request $request, MissedDetectionReport $missedDetection): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can correct a review.'], 403);
        }

        $data = $request->validate([
            'annotations' => ['required', 'array', 'max:40'],
            'annotations.*.class_name' => ['required', 'string', 'max:120'],
            'annotations.*.x' => ['required', 'numeric', 'between:0,1'],
            'annotations.*.y' => ['required', 'numeric', 'between:0,1'],
            'annotations.*.width' => ['required', 'numeric', 'between:0,1'],
            'annotations.*.height' => ['required', 'numeric', 'between:0,1'],
        ]);

        $boxes = $this->normalizeBoxes($data['annotations']);
        if ($boxes instanceof JsonResponse) {
            return $boxes;
        }

        $updated = DB::transaction(function () use ($missedDetection, $boxes, $request) {
            $query = MissedDetectionReport::query()->whereKey($missedDetection->id);
            if (DB::getDriverName() !== 'sqlite') $query->lockForUpdate();
            $report = $query->firstOrFail();
            $editableStatus = in_array($report->status, [
                MissedDetectionReport::PENDING,
                MissedDetectionReport::VERIFIED,
                MissedDetectionReport::CORRECTED,
                MissedDetectionReport::APPROVED,
            ], true);
            $hasTrainingSnapshot = $this->hasImmutableTrainingSnapshot((int) $report->id);
            if (! $editableStatus || $report->status === MissedDetectionReport::EXPORTED || $hasTrainingSnapshot || $report->training_job_id !== null) {
                return response()->json(['message' => 'This review is locked by its approval or training history.'], 422);
            }
            $this->replaceBoxes($report, $boxes);
            $report->update([
                'status' => MissedDetectionReport::CORRECTED,
                'include_in_export' => false,
                'corrected_by' => $request->user()->id,
                'corrected_at' => now(),
                'approved_by' => null,
                'approved_at' => null,
            ]);

            return $report;
        });
        if ($updated instanceof JsonResponse) return $updated;

        return response()->json($updated->fresh()->load(['camera', 'annotations'])->toApiArray());
    }

    public function review(Request $request, MissedDetectionReport $missedDetection): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can review detections.'], 403);
        }

        $data = $request->validate([
            'decision' => ['required', 'in:corrected,verified,approved,rejected'],
            'include_in_export' => ['sometimes', 'boolean'],
            'rejection_note' => ['nullable', 'string', 'max:500'],
        ]);

        $updated = DB::transaction(function () use ($request, $missedDetection, $data) {
            $locked = MissedDetectionReport::query()->whereKey($missedDetection->id);
            if (DB::getDriverName() !== 'sqlite') {
                $locked->lockForUpdate();
            }
            $report = $locked->firstOrFail();

            if ($report->status === MissedDetectionReport::APPROVED && $data['decision'] === 'approved' && array_key_exists('include_in_export', $data)) {
                if ($report->training_job_id !== null || $this->hasImmutableTrainingSnapshot((int) $report->id)) {
                    return response()->json(['message' => 'This review is already part of an immutable training snapshot.'], 422);
                }
                $report->update([
                    'include_in_export' => (bool) $data['include_in_export'],
                ]);

                return $report;
            }

            if ($report->status === MissedDetectionReport::APPROVED && $data['decision'] === 'corrected') {
                if ($report->training_job_id !== null || $this->hasImmutableTrainingSnapshot((int) $report->id)) {
                    return response()->json(['message' => 'This review is part of an immutable training snapshot and cannot be revoked.'], 422);
                }
                $report->update([
                    'status' => MissedDetectionReport::CORRECTED,
                    'include_in_export' => false,
                    'corrected_by' => $request->user()->id,
                    'corrected_at' => now(),
                    'approved_by' => null,
                    'approved_at' => null,
                    'reviewed_by' => $request->user()->id,
                    'reviewed_at' => now(),
                ]);

                return $report;
            }

            if (in_array($report->status, [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED], true)) {
                return response()->json([
                    'message' => $report->status === MissedDetectionReport::EXPORTED
                        ? 'This report is already exported.'
                        : 'This report is already approved.',
                ], 422);
            }

            if ($data['decision'] === 'rejected') {
                if (! in_array($report->status, [
                    MissedDetectionReport::PENDING,
                    MissedDetectionReport::VERIFIED,
                    MissedDetectionReport::CORRECTED,
                    MissedDetectionReport::REJECTED,
                ], true)) {
                    return response()->json(['message' => 'This report can no longer be rejected.'], 422);
                }
                $report->update([
                    'status' => MissedDetectionReport::REJECTED,
                    'include_in_export' => false,
                    'reviewed_by' => $request->user()->id,
                    'reviewed_at' => now(),
                    'rejection_note' => $data['rejection_note'] ?? $report->rejection_note,
                ]);

                return $report;
            }

            if (in_array($data['decision'], ['verified', 'corrected'], true)
                && ! in_array($report->status, [MissedDetectionReport::PENDING, MissedDetectionReport::VERIFIED, MissedDetectionReport::CORRECTED], true)) {
                return response()->json(['message' => 'Only a pending or corrected report can be marked corrected.'], 422);
            }
            if ($data['decision'] === 'approved' && ! in_array($report->status, [MissedDetectionReport::PENDING, MissedDetectionReport::VERIFIED, MissedDetectionReport::CORRECTED], true)) {
                return response()->json(['message' => 'Only a pending or verified report can be approved.'], 422);
            }

            $invalid = $this->annotationProblem($report);
            if ($invalid) {
                return $invalid;
            }

            $report->update([
                'status' => in_array($data['decision'], ['verified', 'corrected'], true)
                    ? MissedDetectionReport::CORRECTED
                    : MissedDetectionReport::APPROVED,
                'include_in_export' => $data['decision'] === 'approved' && (bool) ($data['include_in_export'] ?? false),
                'reviewed_by' => $request->user()->id,
                'reviewed_at' => now(),
                'corrected_by' => in_array($data['decision'], ['verified', 'corrected'], true) ? $request->user()->id : $report->corrected_by,
                'corrected_at' => in_array($data['decision'], ['verified', 'corrected'], true) ? now() : $report->corrected_at,
                'approved_by' => $data['decision'] === 'approved' ? $request->user()->id : null,
                'approved_at' => $data['decision'] === 'approved' ? now() : null,
                'rejection_note' => null,
            ]);

            return $report;
        });

        if ($updated instanceof JsonResponse) {
            return $updated;
        }

        return response()->json($updated->fresh()->load(['camera', 'annotations', 'sourceDetection.classification', 'sourceDetection.observations'])->toApiArray());
    }

    public function destroyMany(Request $request): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can delete a review.'], 403);
        }
        $data = $request->validate([
            'ids' => ['required', 'array', 'min:1', 'max:1000'],
            'ids.*' => ['integer'],
        ]);
        $reports = MissedDetectionReport::query()->whereIn('id', $data['ids'])->get();
        $busy = $this->reviewIdsInActiveTraining();
        $deleted = [];
        $kept = [];
        foreach ($reports as $report) {
            // Approved and exported reviews can be deleted too, except while a
            // training job is still uploading or training with them.
            if (isset($busy[(int) $report->id])) {
                $kept[] = (int) $report->id;
                continue;
            }
            if ($report->image_path) {
                Storage::disk('public')->delete($report->image_path);
                \App\Support\ReviewThumbnail::delete($report->image_path);
            }
            $deleted[] = (int) $report->id;
            $report->delete();
        }

        return response()->json([
            'deleted' => $deleted,
            'kept' => $kept,
        ]);
    }

    /** @return array<int, true> review ids used by a training job that is still running */
    private function reviewIdsInActiveTraining(): array
    {
        $ids = \App\Models\TrainingJobItem::query()
            ->whereHas('trainingJob', fn ($query) => $query->whereIn('status', \App\Models\TrainingJob::ACTIVE))
            ->pluck('report_id');

        return array_fill_keys($ids->map(fn ($id) => (int) $id)->all(), true);
    }

    public function destroy(Request $request, MissedDetectionReport $missedDetection): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can delete a review.'], 403);
        }
        if (isset($this->reviewIdsInActiveTraining()[(int) $missedDetection->id])) {
            return response()->json(['message' => 'This review is in a training job that is still running. Delete it after the job finishes.'], 422);
        }
        if ($missedDetection->image_path) {
            Storage::disk('public')->delete($missedDetection->image_path);
            \App\Support\ReviewThumbnail::delete($missedDetection->image_path);
        }
        $id = $missedDetection->id;
        $missedDetection->delete();

        return response()->json(['deleted' => true, 'id' => $id]);
    }

    public function export(): BinaryFileResponse|JsonResponse
    {
        $user = request()->user();
        if (! $this->isAdmin($user)) {
            return response()->json(['message' => 'Only an administrator can export the dataset.'], 403);
        }

        $dataset = ReviewDataset::collectExportable();
        if ($dataset['issues'] !== []) {
            return response()->json([
                'message' => 'Export stopped. Fix these approved reports before downloading.',
                'issues' => $dataset['issues'],
            ], 422);
        }
        if ($dataset['items'] === []) {
            return response()->json(['message' => 'There are no reviews marked for export.'], 422);
        }

        $tmp = tempnam(sys_get_temp_dir(), 'missed-yolo-');
        $zipPath = $tmp.'.zip';
        @unlink($tmp);

        $files = [];
        $used = [];
        foreach ($dataset['items'] as $row) {
            $base = 'missed-'.$row['report_id'];
            if (isset($used[$base])) {
                return response()->json(['message' => 'Duplicate export filename.'], 422);
            }
            $used[$base] = true;
            $ext = strtolower(pathinfo($row['filename'], PATHINFO_EXTENSION) ?: 'jpg');
            $split = ($row['split'] ?? 'train') === 'valid' ? 'val' : ($row['split'] ?? 'train');
            $files["images/{$split}/{$base}.{$ext}"] = $row['bytes'];
            $files["labels/{$split}/{$base}.txt"] = $row['yolo'];
            if (count($dataset['items']) === 1) {
                $files["images/val/{$base}.{$ext}"] = $row['bytes'];
                $files["labels/val/{$base}.txt"] = $row['yolo'];
            }
        }
        $files['data.yaml'] = WasteClassMap::yaml();

        try {
            StoredZip::write($zipPath, $files);
        } catch (\Throwable) {
            @unlink($zipPath);

            return response()->json(['message' => 'Could not create the dataset archive.'], 500);
        }

        DB::transaction(function () use ($dataset) {
            MissedDetectionReport::query()
                ->whereIn('id', array_column($dataset['items'], 'report_id'))
                ->update([
                    'status' => MissedDetectionReport::EXPORTED,
                    'updated_at' => now(),
                ]);
            MissedDetectionReport::syncAnnotationStatus(array_column($dataset['items'], 'report_id'));
        });

        return response()->download($zipPath, 'approved-waste-dataset.zip')->deleteFileAfterSend(true);
    }

    private function annotationProblem(MissedDetectionReport $report): ?JsonResponse
    {
        $report->load('annotations');
        if ($report->annotations->isEmpty()) {
            return response()->json([
                'message' => 'Add at least one valid bounding box before approval.',
            ], 422);
        }
        foreach ($report->annotations as $box) {
            if ($box->toYoloLine() === null) {
                return response()->json([
                    'message' => 'A bounding box or class is invalid.',
                ], 422);
            }
        }

        return null;
    }

    private function rankedClassHits(Request $request)
    {
        $filtered = MissedDetectionReport::query()->select('detection_reviews.id');
        $this->applyReviewFilters($filtered, $request);

        $pairs = DB::query()
            ->fromSub($filtered, 'filtered')
            ->leftJoin('detection_review_annotations as annotations', 'annotations.report_id', '=', 'filtered.id')
            ->leftJoin('detection_reviews as reports', 'reports.id', '=', 'filtered.id')
            ->select('filtered.id')
            ->selectRaw("COALESCE(NULLIF(annotations.class_name, ''), NULLIF(reports.proposal_label, ''), 'Unclassified') as class_name")
            ->distinct();

        return DB::query()
            ->fromSub($pairs, 'class_hits')
            ->select('id', 'class_name')
            ->selectRaw('ROW_NUMBER() OVER (PARTITION BY class_name ORDER BY id DESC) as hit_rank');
    }

    /**
     * Newest reviews for each waste class. A review with two classes counts once in each.
     *
     * @return list<int>
     */
    private function cappedReviewIds(Request $request, int $limit): array
    {
        return DB::query()
            ->fromSub($this->rankedClassHits($request), 'ranked_hits')
            ->where('hit_rank', '<=', $limit)
            ->distinct()
            ->orderByDesc('id')
            ->pluck('id')
            ->map(fn ($id) => (int) $id)
            ->all();
    }

    /**
     * How many reviews of each class are inside the hits-per-class cap.
     *
     * @return list<array{name: string, count: int}>
     */
    private function classHitCounts(Request $request, int $limit): array
    {
        return DB::query()
            ->fromSub($this->rankedClassHits($request), 'ranked_hits')
            ->where('hit_rank', '<=', $limit)
            ->where('class_name', '!=', 'Unclassified')
            ->select('class_name')
            ->selectRaw('COUNT(DISTINCT id) as total')
            ->groupBy('class_name')
            ->orderBy('class_name')
            ->get()
            ->map(fn ($row) => [
                'name' => (string) $row->class_name,
                'count' => (int) $row->total,
            ])
            ->values()
            ->all();
    }

    private function applyReviewFilters($query, Request $request): void
    {
        if ($request->query('for_training') === '1') {
            $trained = \App\Support\TrainingSamplePlan::trainedReportIds();
            $query->whereIn('status', [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED])
                ->where('include_in_export', true)
                ->when($trained !== [], fn ($q) => $q->whereNotIn('id', $trained));
        } elseif ($status = $request->query('status')) {
            $query->where('status', $status);
        }
        if ($camera = $request->query('camera_id')) {
            $query->whereHas('camera', fn ($q) => $q->where('camera_code', $camera));
        }
        if ($class = $request->query('class_name')) {
            $query->where(function ($inner) use ($class) {
                $inner->whereHas('annotations', fn ($q) => $q->where('class_name', $class))
                    ->orWhere('proposal_label', $class);
            });
        }
        if ($from = $request->query('from')) {
            $query->whereDate('created_at', '>=', $from);
        }
        if ($to = $request->query('to')) {
            $query->whereDate('created_at', '<=', $to);
        }
        if ($request->filled('min_confidence') || $request->filled('max_confidence')) {
            $min = $request->filled('min_confidence') ? (float) $request->query('min_confidence') : null;
            $max = $request->filled('max_confidence') ? (float) $request->query('max_confidence') : null;
            $query->where(function ($inner) use ($min, $max) {
                $inner->where(function ($proposal) use ($min, $max) {
                    $proposal->whereNotNull('proposal_label');
                    if ($min !== null) {
                        $proposal->where('proposal->confidence', '>=', $min);
                    }
                    if ($max !== null) {
                        $proposal->where('proposal->confidence', '<', $max);
                    }
                })->orWhereHas('sourceDetection', function ($det) use ($min, $max) {
                    $det->where(function ($scaled) use ($min, $max) {
                        $scaled->where('confidence', '<=', 1);
                        if ($min !== null) {
                            $scaled->where('confidence', '>=', $min);
                        }
                        if ($max !== null) {
                            $scaled->where('confidence', '<', $max);
                        }
                    })->orWhere(function ($percent) use ($min, $max) {
                        $percent->where('confidence', '>', 1);
                        if ($min !== null) {
                            $percent->where('confidence', '>=', $min * 100);
                        }
                        if ($max !== null) {
                            $percent->where('confidence', '<', $max * 100);
                        }
                    });
                });
            });
        }

        $search = trim((string) $request->query('q', ''));
        $search = preg_replace('/^(?:review|no\.?|#)\s*/i', '', $search) ?? $search;
        if ($search !== '') {
            $query->where(function ($inner) use ($search) {
                $inner->where('description', 'like', '%'.$search.'%')
                    ->orWhere('proposal_label', 'like', '%'.$search.'%')
                    ->orWhereHas('camera', function ($camera) use ($search) {
                        $camera->where('camera_name', 'like', '%'.$search.'%')
                            ->orWhere('camera_code', 'like', '%'.$search.'%');
                    })
                    ->orWhereHas('annotations', fn ($box) => $box->where('class_name', 'like', '%'.$search.'%'));
                if (ctype_digit($search)) {
                    $inner->orWhere('id', (int) $search);
                }
            });
        }
    }

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }

    private function hasImmutableTrainingSnapshot(int $reportId): bool
    {
        return TrainingJobItem::query()
            ->where('report_id', $reportId)
            ->whereHas('job', fn ($query) => $query
                ->whereNotNull('dataset_version')
                ->orWhereIn('status', TrainingJob::ACTIVE))
            ->exists();
    }

    /**
     * @param  array<int, array<string, mixed>>  $annotations
     * @return array<int, array<string, mixed>>|JsonResponse
     */
    private function normalizeBoxes(array $annotations): array|JsonResponse
    {
        $boxes = [];
        foreach ($annotations as $index => $box) {
            $name = WasteClassMap::canonical((string) ($box['class_name'] ?? ''));
            $classIndex = $name === null ? null : WasteClassMap::index($name);
            if ($classIndex === null || $name === null) {
                return response()->json([
                    'message' => "Unknown waste class on box ".($index + 1).'.',
                ], 422);
            }
            $x = (float) $box['x'];
            $y = (float) $box['y'];
            $w = (float) $box['width'];
            $h = (float) $box['height'];
            if ($w <= 0 || $h <= 0 || $x + $w > 1.000001 || $y + $h > 1.000001) {
                return response()->json([
                    'message' => 'A bounding box is outside the image.',
                ], 422);
            }
            $boxes[] = [
                'class_name' => $name,
                'class_index' => $classIndex,
                'x' => round($x, 6),
                'y' => round($y, 6),
                'width' => round($w, 6),
                'height' => round($h, 6),
            ];
        }

        return $boxes;
    }

    /**
     * @param  array<int, array<string, mixed>>  $boxes
     */
    private function seedProposalBox(
        MissedDetectionReport $report,
        string $label,
        float $x,
        float $y,
        float $width,
        float $height,
    ): void {
        $className = DatasetClasses::match($label) ?: $label;
        $classIndex = WasteClassMap::index($className);
        if ($classIndex === null || $width <= 0 || $height <= 0) {
            return;
        }
        $x = max(0.0, min(1.0, $x));
        $y = max(0.0, min(1.0, $y));
        $width = max(0.0, min(1.0 - $x, $width));
        $height = max(0.0, min(1.0 - $y, $height));
        if ($width <= 0 || $height <= 0) {
            return;
        }
        $report->annotations()->create([
            'class_name' => $className,
            'class_index' => $classIndex,
            'x' => round($x, 6),
            'y' => round($y, 6),
            'width' => round($width, 6),
            'height' => round($height, 6),
        ]);
    }

    private function replaceBoxes(MissedDetectionReport $report, array $boxes): void
    {
        $report->annotations()->delete();
        foreach ($boxes as $box) {
            $report->annotations()->create($box);
        }
    }

    private function proposalDescription(string $reason, string $label, ?float $confidence): string
    {
        $score = $confidence !== null ? ' Confidence '.round($confidence * 100).'%.' : '';
        if ($reason === 'low_confidence') {
            return trim(
                "YOLOv11 saw a possible {$label}, but the score is not high enough to save it.{$score}"
                .' Confirm the class and box, or reject the frame.'
            );
        }
        if ($reason === 'uncertain') {
            return trim(
                "The live model scored {$label} at or above 70%, but the class was not trusted.{$score}"
                .' Draw the correct class, or reject the box.'
            );
        }

        return trim(
            "Unrecognized object outside the dataset classes: {$label}.{$score}"
            .' Label it with a dataset class if it should be added to training, or reject it.'
        );
    }

    private function recentProposal(
        int $cameraId,
        string $label,
        float $x,
        float $y,
        float $w,
        float $h,
    ): ?MissedDetectionReport {
        $recent = MissedDetectionReport::query()
            ->where('camera_id', $cameraId)
            ->where('proposal_label', $label)
            ->where('created_at', '>=', now()->subMinutes(30))
            ->latest('id')
            ->get();

        foreach ($recent as $report) {
            $box = is_array($report->proposal) ? $report->proposal : [];
            if (! isset($box['width'], $box['height'])) {
                return $report;
            }
            if ($this->proposalIou($box, $x, $y, $w, $h) >= 0.4) {
                return $report;
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $box
     */
    private function proposalIou(array $box, float $x, float $y, float $w, float $h): float
    {
        $ax1 = (float) ($box['x'] ?? 0);
        $ay1 = (float) ($box['y'] ?? 0);
        $ax2 = $ax1 + (float) ($box['width'] ?? 0);
        $ay2 = $ay1 + (float) ($box['height'] ?? 0);
        $bx2 = $x + $w;
        $by2 = $y + $h;
        $ix1 = max($ax1, $x);
        $iy1 = max($ay1, $y);
        $ix2 = min($ax2, $bx2);
        $iy2 = min($ay2, $by2);
        $inter = max(0.0, $ix2 - $ix1) * max(0.0, $iy2 - $iy1);
        $union = max(0.0, $ax2 - $ax1) * max(0.0, $ay2 - $ay1) + ($w * $h) - $inter;
        if ($union <= 0) {
            return 0.0;
        }

        return $inter / $union;
    }

    /**
     * @return array{path: string, name: string}|JsonResponse
     */
    private function storeImage(Request $request, ?int $detectionId): array|JsonResponse
    {
        if ($request->hasFile('image')) {
            $file = $request->file('image');
            $name = Str::uuid()->toString().'.'.$file->getClientOriginalExtension();
            $path = $file->storeAs('missed-detections', $name, 'public');

            return ['path' => $path, 'name' => $file->getClientOriginalName() ?: $name];
        }

        $detection = Detection::query()->with('images')->find($detectionId);
        $image = $detection?->images->sortByDesc('id')->first();
        if (! $image || ! Storage::disk('public')->exists($image->image_path)) {
            return response()->json(['message' => 'That detection has no stored frame.'], 422);
        }
        $ext = pathinfo($image->image_path, PATHINFO_EXTENSION) ?: 'jpg';
        $name = Str::uuid()->toString().'.'.$ext;
        $path = 'missed-detections/'.$name;
        Storage::disk('public')->copy($image->image_path, $path);

        return ['path' => $path, 'name' => $image->image_name ?: $name];
    }
}
