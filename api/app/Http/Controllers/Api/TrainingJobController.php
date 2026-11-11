<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Jobs\ProcessTrainingJob;
use App\Models\MissedDetectionReport;
use App\Models\TrainingJob;
use App\Models\TrainingJobItem;
use App\Models\User;
use App\Services\RoboflowClient;
use App\Services\TrainingStatusReader;
use App\Support\ReviewDataset;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

class TrainingJobController extends Controller
{
    public function index(Request $request, TrainingStatusReader $reader): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can view training jobs.'], 403);
        }
        $counts = [
            'items',
            'items as uploaded_items_count' => fn ($query) => $query->where('upload_status', 'uploaded'),
        ];
        $latest = TrainingJob::query()->withCount($counts)->orderByDesc('id')->first();
        if ($latest) {
            $latest = $reader->refresh($latest);
        }

        $eligibleQuery = MissedDetectionReport::query()
            ->where('status', MissedDetectionReport::APPROVED)
            ->where('include_in_export', true)
            ->whereNull('training_job_id');
        $eligibleReviews = (int) (clone $eligibleQuery)->count();
        $annotationCount = (int) (clone $eligibleQuery)
            ->join('missed_detection_annotations', 'missed_detection_annotations.report_id', '=', 'missed_detection_reports.id')
            ->count('missed_detection_annotations.id');
        $heldOut = (int) MissedDetectionReport::query()
            ->where('status', MissedDetectionReport::APPROVED)
            ->where('include_in_export', false)
            ->whereNull('training_job_id')
            ->count();
        $alreadyUsed = (int) MissedDetectionReport::query()
            ->where(function ($query) {
                $query->where('status', MissedDetectionReport::EXPORTED)
                    ->orWhereNotNull('training_job_id');
            })
            ->count();

        $dataset = [
            'eligible_reviews' => $eligibleReviews,
            'images' => $eligibleReviews,
            'annotations' => $annotationCount,
            'held_out' => $heldOut,
            'already_exported_or_queued' => $alreadyUsed,
            'issues' => null,
            'valid' => null,
        ];
        if ($request->boolean('validate')) {
            $checked = ReviewDataset::collectExportable();
            $dataset['issues'] = $checked['issues'];
            $dataset['images'] = count($checked['items']);
            $dataset['eligible_reviews'] = count($checked['items']);
            $dataset['annotations'] = 0;
            foreach ($checked['items'] as $row) {
                $lines = trim((string) ($row['yolo'] ?? ''));
                $dataset['annotations'] += $lines === '' ? 0 : (substr_count($lines, "\n") + 1);
            }
            $dataset['valid'] = $checked['issues'] === [] && $checked['items'] !== [];
        }

        return response()->json([
            'configured' => app(RoboflowClient::class)->configured(),
            'workspace' => config('services.roboflow.workspace'),
            'project' => config('services.roboflow.project'),
            'model_type' => config('services.roboflow.model_type'),
            'latest' => $latest?->toApiArray(),
            'jobs' => TrainingJob::query()->withCount($counts)->orderByDesc('id')->limit(8)->get()->map->toApiArray()->values(),
            'dataset' => $dataset,
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can start training.'], 403);
        }
        $roboflow = app(RoboflowClient::class);
        if (! $roboflow->configured()) {
            return response()->json([
                'message' => 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT in the API environment before training.',
            ], 422);
        }
        if (TrainingJob::query()->whereIn('status', TrainingJob::ACTIVE)->exists()) {
            return response()->json(['message' => 'A training job is already running.'], 422);
        }

        $dataset = ReviewDataset::collectExportable();
        if ($dataset['issues'] !== []) {
            return response()->json([
                'message' => 'Training stopped. Fix these approved reports first.',
                'issues' => $dataset['issues'],
            ], 422);
        }
        if ($dataset['items'] === []) {
            return response()->json(['message' => 'There are no approved reviews marked for export.'], 422);
        }

        $job = DB::transaction(function () use ($request, $dataset, $roboflow) {
            $job = TrainingJob::query()->create([
                'started_by' => $request->user()->id,
                'status' => TrainingJob::PREPARING,
                'workspace' => $roboflow->workspace(),
                'project' => $roboflow->project(),
                'model_type' => $roboflow->modelType(),
                'training_speed' => $roboflow->speed(),
                'preprocessing' => $roboflow->preprocessing(),
                'augmentation' => $roboflow->augmentation(),
                'manifest' => [
                    'report_ids' => array_column($dataset['items'], 'report_id'),
                    'hashes' => array_column($dataset['items'], 'hash'),
                    'created_at' => now()->toIso8601String(),
                ],
                'started_at' => now(),
            ]);
            foreach ($dataset['items'] as $row) {
                TrainingJobItem::query()->create([
                    'training_job_id' => $job->id,
                    'report_id' => $row['report_id'],
                    'image_hash' => $row['hash'],
                    'split' => $row['split'],
                    'filename' => $row['filename'],
                    'upload_status' => 'pending',
                ]);
                MissedDetectionReport::query()->whereKey($row['report_id'])->update([
                    'training_job_id' => $job->id,
                ]);
            }

            return $job;
        });

        ProcessTrainingJob::dispatch($job->id);

        return response()->json($job->fresh('items')?->toApiArray(), 201);
    }

    public function retry(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can retry training.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::FAILED) {
            return response()->json(['message' => 'Only a failed job can be retried.'], 422);
        }
        if (TrainingJob::query()->whereIn('status', TrainingJob::ACTIVE)->where('id', '!=', $trainingJob->id)->exists()) {
            return response()->json(['message' => 'A training job is already running.'], 422);
        }
        $manifest = is_array($trainingJob->manifest) ? $trainingJob->manifest : [];
        $manifest['training_started'] = false;
        $trainingJob->update([
            'status' => TrainingJob::PREPARING,
            'error_message' => null,
            'completed_at' => null,
            'started_at' => now(),
            'manifest' => $manifest,
        ]);
        ProcessTrainingJob::dispatch($trainingJob->id);

        return response()->json($trainingJob->fresh('items')?->toApiArray());
    }

    public function evaluate(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can record evaluation notes.'], 403);
        }
        $data = $request->validate([
            'notes' => ['nullable', 'string', 'max:2000'],
        ]);
        if (! in_array($trainingJob->status, [TrainingJob::COMPLETED, TrainingJob::AWAITING_EVALUATION], true)) {
            return response()->json(['message' => 'Evaluate the model only after training completes.'], 422);
        }
        $trainingJob->update([
            'status' => TrainingJob::AWAITING_EVALUATION,
            'evaluation_notes' => $data['notes'] ?? $trainingJob->evaluation_notes,
        ]);

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function approveDeployment(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can approve deployment.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::AWAITING_EVALUATION) {
            return response()->json(['message' => 'Evaluate the trained model before approving deployment.'], 422);
        }
        $trainingJob->update(['status' => TrainingJob::APPROVED_FOR_DEPLOYMENT]);

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function reject(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can reject a trained model.'], 403);
        }
        if (! in_array($trainingJob->status, [TrainingJob::AWAITING_EVALUATION, TrainingJob::APPROVED_FOR_DEPLOYMENT], true)) {
            return response()->json(['message' => 'This job cannot be rejected.'], 422);
        }
        $trainingJob->update(['status' => TrainingJob::REJECTED]);

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function deploy(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can deploy a model.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::APPROVED_FOR_DEPLOYMENT) {
            return response()->json(['message' => 'Approve the model for deployment first. The live ONNX file is not replaced automatically.'], 422);
        }
        $live = $this->liveOnnxPath();
        $backup = null;
        if (is_file($live)) {
            $backupDir = dirname($live).DIRECTORY_SEPARATOR.'backups';
            File::ensureDirectoryExists($backupDir);
            $backup = $backupDir.DIRECTORY_SEPARATOR.now()->format('Ymd-His').'-best.onnx';
            File::copy($live, $backup);
        }
        $trainingJob->update([
            'status' => TrainingJob::DEPLOYED,
            'previous_model_path' => $live,
            'backup_model_path' => $backup,
            'deployed_at' => now(),
            'evaluation_notes' => trim((string) $trainingJob->evaluation_notes."\nRecorded hosted model ".$trainingJob->hosted_model_id.'. Live cameras still use local best.onnx until that file is replaced with an exported YOLOv11 ONNX.'),
        ]);

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function rollback(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can roll back a model.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::DEPLOYED || ! $trainingJob->backup_model_path) {
            return response()->json(['message' => 'There is no backup for this job.'], 422);
        }
        if (! is_file($trainingJob->backup_model_path)) {
            return response()->json(['message' => 'The backup file is missing.'], 422);
        }
        $live = $trainingJob->previous_model_path ?: $this->liveOnnxPath();
        File::copy($trainingJob->backup_model_path, $live);
        $trainingJob->update([
            'status' => TrainingJob::REJECTED,
            'evaluation_notes' => trim((string) $trainingJob->evaluation_notes."\nRolled back to the previous local ONNX backup."),
        ]);

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    private function liveOnnxPath(): string
    {
        return dirname(base_path()).DIRECTORY_SEPARATOR.'detector'.DIRECTORY_SEPARATOR.'weights'.DIRECTORY_SEPARATOR.'trained'.DIRECTORY_SEPARATOR.'best.onnx';
    }

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }
}
