<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\User;
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
        $counted = MissedDetectionReport::query()
            ->select('status', DB::raw('COUNT(*) as aggregate'))
            ->groupBy('status')
            ->pluck('aggregate', 'status');
        $counts = [];
        foreach ([
            MissedDetectionReport::PENDING,
            MissedDetectionReport::VERIFIED,
            MissedDetectionReport::APPROVED,
            MissedDetectionReport::REJECTED,
            MissedDetectionReport::EXPORTED,
        ] as $status) {
            $counts[$status] = (int) ($counted[$status] ?? 0);
        }
        $counts['training_eligible'] = (int) MissedDetectionReport::query()
            ->where('status', MissedDetectionReport::APPROVED)
            ->where('include_in_export', true)
            ->whereNull('training_job_id')
            ->count();

        $query = MissedDetectionReport::query()
            ->with(['camera', 'annotations', 'sourceDetection.classification', 'sourceDetection.latestObservation'])
            ->orderByDesc('id');

        if ($status = $request->query('status')) {
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

        if ($search = trim((string) $request->query('q', ''))) {
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

        $perPage = min(50, max(1, (int) $request->query('per_page', 10)));
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
        foreach (WasteClassMap::CLASSES as $index => $name) {
            $classes[] = ['index' => $index, 'name' => $name];
        }

        return response()->json($classes);
    }

    /**
     * Detector-only. An object outside the 13 CCTV classes becomes a pending
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
        $knownClass = \App\Support\DatasetClasses::match($label);
        if ($reason === 'low_confidence') {
            if ($knownClass === null) {
                return response()->json([
                    'message' => 'Low-confidence reviews must use a dataset class.',
                ], 422);
            }
            $label = $knownClass;
        } elseif ($reason !== 'uncertain') {
            foreach (WasteClassMap::CLASSES as $name) {
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

        return response()->json($report->load(['camera', 'annotations'])->toApiArray(), 201);
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
        if (! in_array($missedDetection->status, [MissedDetectionReport::PENDING, MissedDetectionReport::VERIFIED], true)) {
            return response()->json(['message' => 'Approved, rejected, and exported reports cannot be edited.'], 422);
        }
        if (! $this->canEdit($request->user(), $missedDetection)) {
            return response()->json(['message' => 'You cannot edit this report.'], 403);
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

        DB::transaction(function () use ($missedDetection, $boxes) {
            $this->replaceBoxes($missedDetection, $boxes);
        });

        return response()->json($missedDetection->fresh()->load(['camera', 'annotations'])->toApiArray());
    }

    public function review(Request $request, MissedDetectionReport $missedDetection): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can review detections.'], 403);
        }

        $data = $request->validate([
            'decision' => ['required', 'in:verified,approved,rejected'],
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
                $report->update([
                    'include_in_export' => (bool) $data['include_in_export'],
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
                    MissedDetectionReport::REJECTED,
                ], true)) {
                    return response()->json(['message' => 'This report can no longer be deleted.'], 422);
                }
                $id = $report->id;
                if ($report->image_path) {
                    Storage::disk('public')->delete($report->image_path);
                }
                $report->delete();

                return response()->json(['deleted' => true, 'id' => $id]);
            }

            if ($data['decision'] === 'verified' && $report->status !== MissedDetectionReport::PENDING) {
                return response()->json(['message' => 'Only a pending report can be verified.'], 422);
            }
            if ($data['decision'] === 'approved' && ! in_array($report->status, [MissedDetectionReport::PENDING, MissedDetectionReport::VERIFIED], true)) {
                return response()->json(['message' => 'Only a pending or verified report can be approved.'], 422);
            }

            $invalid = $this->annotationProblem($report);
            if ($invalid) {
                return $invalid;
            }

            $report->update([
                'status' => $data['decision'] === 'verified'
                    ? MissedDetectionReport::VERIFIED
                    : MissedDetectionReport::APPROVED,
                'include_in_export' => $data['decision'] === 'approved' && (bool) ($data['include_in_export'] ?? false),
                'reviewed_by' => $request->user()->id,
                'reviewed_at' => now(),
                'rejection_note' => null,
            ]);

            return $report;
        });

        if ($updated instanceof JsonResponse) {
            return $updated;
        }

        return response()->json($updated->fresh()->load(['camera', 'annotations', 'sourceDetection.classification', 'sourceDetection.observations'])->toApiArray());
    }

    public function destroy(Request $request, MissedDetectionReport $missedDetection): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can delete a review.'], 403);
        }
        if (! in_array($missedDetection->status, [
            MissedDetectionReport::PENDING,
            MissedDetectionReport::VERIFIED,
            MissedDetectionReport::REJECTED,
        ], true)) {
            return response()->json(['message' => 'Approved and exported reviews stay in the dataset record.'], 422);
        }
        if ($missedDetection->image_path) {
            Storage::disk('public')->delete($missedDetection->image_path);
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

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }

    private function canEdit(User $user, MissedDetectionReport $report): bool
    {
        return $this->isAdmin($user) || (int) $report->user_id === (int) $user->id;
    }

    /**
     * @param  array<int, array<string, mixed>>  $annotations
     * @return array<int, array<string, mixed>>|JsonResponse
     */
    private function normalizeBoxes(array $annotations): array|JsonResponse
    {
        $boxes = [];
        foreach ($annotations as $index => $box) {
            $name = (string) ($box['class_name'] ?? '');
            $classIndex = WasteClassMap::index($name);
            if ($classIndex === null) {
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
                "YOLOv11 scored {$label} below the live detection threshold.{$score}"
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
            "Unrecognized object outside the 13 dataset classes: {$label}.{$score}"
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
