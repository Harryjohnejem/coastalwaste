<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Jobs\ProcessTrainingJob;
use App\Jobs\WatchTrainingJob;
use App\Models\MissedDetectionAnnotation;
use App\Models\MissedDetectionReport;
use App\Models\TrainingJob;
use App\Models\TrainingJobItem;
use App\Models\User;
use App\Services\RoboflowClient;
use App\Services\TrainedModelInstaller;
use App\Services\TrainingStatusReader;
use App\Support\LocalQueueWorker;
use App\Support\ReviewDataset;
use App\Support\TrainingSamplePlan;
use App\Support\WasteClassMap;
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
            'items as train_items_count' => fn ($query) => $query->where('split', 'train'),
            'items as valid_items_count' => fn ($query) => $query->whereIn('split', ['valid', 'val']),
        ];
        $visible = fn () => TrainingJob::query()
            ->withCount($counts)
            ->where('status', '!=', TrainingJob::DISMISSED)
            ->orderByDesc('id');
        $latest = $visible()->first();
        if ($latest) {
            $latest = $reader->refresh($latest);
        }
        if ($latest && in_array($latest->status, [TrainingJob::PREPARING, TrainingJob::UPLOADING, TrainingJob::TRAINING], true)) {
            LocalQueueWorker::ensure();
        }

        $plan = TrainingSamplePlan::summary();
        $eligibleReviews = (int) $plan['eligible_reviews'];
        // One COUNT query instead of loading every approved review into memory.
        $annotationCount = (int) MissedDetectionAnnotation::query()
            ->whereIn('report_id', MissedDetectionReport::query()
                ->select('id')
                ->whereIn('status', [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED])
                ->where('include_in_export', true))
            ->count();
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

        $selectedIds = $plan['selected_ids'];
        unset($plan['selected_ids']);
        $dataset = [
            'eligible_reviews' => $eligibleReviews,
            'images' => $eligibleReviews,
            'annotations' => $annotationCount,
            'held_out' => $heldOut,
            'already_exported_or_queued' => $alreadyUsed,
            'issues' => null,
            'valid' => null,
            'sample_plan' => $plan,
        ];
        if ($request->boolean('validate')) {
            $checked = ReviewDataset::collectByIds($selectedIds);
            $dataset['issues'] = $checked['issues'];
            $dataset['images'] = count($checked['items']);
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
            'model_type' => TrainingJob::RECIPE['model_type'],
            'recipe' => TrainingJob::RECIPE,
            'sample_limit' => $plan['limit'],
            'latest' => $latest?->toApiArray(),
            'jobs' => $visible()->limit(8)->get()->map->toApiArray()->values(),
            'dataset' => $dataset,
        ]);
    }

    public function updateSampleLimit(Request $request): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can set the training sample limit.'], 403);
        }
        $data = $request->validate([
            'per_class' => ['required', 'integer', 'in:'.implode(',', TrainingSamplePlan::OPTIONS)],
        ]);
        $limit = TrainingSamplePlan::save((int) $data['per_class']);
        $plan = TrainingSamplePlan::summary();
        unset($plan['selected_ids']);

        return response()->json([
            'sample_limit' => $limit,
            'sample_plan' => $plan,
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can upload a training dataset.'], 403);
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

        $result = DB::transaction(function () use ($request, $roboflow) {
            if (TrainingJob::query()->whereIn('status', TrainingJob::ACTIVE)->exists()) {
                return response()->json(['message' => 'A training job is already running.'], 422);
            }
            $plan = TrainingSamplePlan::summary();
            if (TrainingJob::query()->whereIn('status', TrainingJob::ACTIVE)->exists()) {
                return response()->json(['message' => 'A training job is already running.'], 422);
            }
            if (! $plan['ready']) {
                $missing = array_values(array_filter($plan['classes'], fn (array $row) => $row['remaining'] > 0 && empty($row['optional'])));

                return response()->json([
                    'message' => 'Training requires at least '.$plan['required'].' valid approved samples for every configured waste class.',
                    'classes' => $missing,
                ], 422);
            }
            $dataset = ReviewDataset::collectByIds($plan['selected_ids']);
            if ($dataset['issues'] !== []) {
                return response()->json([
                    'message' => 'Training stopped. Fix these approved reports first.',
                    'issues' => $dataset['issues'],
                ], 422);
            }
            if ($dataset['items'] === []) {
                return response()->json(['message' => 'There are no approved reviews marked for export.'], 422);
            }
            $snapshotCounts = $this->sampleCounts($dataset['items']);
            $missingSnapshotClasses = array_values(array_filter(
                TrainingSamplePlan::requiredClasses(),
                fn (string $name) => ($snapshotCounts[$name] ?? 0) < (int) $plan['required'],
            ));
            if ($missingSnapshotClasses !== []) {
                return response()->json([
                    'message' => 'The balanced dataset snapshot is missing the required approved samples.',
                    'classes' => $missingSnapshotClasses,
                ], 422);
            }

            $job = TrainingJob::query()->create([
                'started_by' => $request->user()->id,
                'status' => TrainingJob::PREPARING,
                'workspace' => $roboflow->workspace(),
                'project' => $roboflow->project(),
                'model_type' => TrainingJob::RECIPE['model_type'],
                'training_speed' => TrainingJob::RECIPE['training_speed'],
                'preprocessing' => $roboflow->preprocessing(),
                'augmentation' => $roboflow->augmentation(),
                'manifest' => [
                    'report_ids' => array_column($dataset['items'], 'report_id'),
                    'hashes' => array_column($dataset['items'], 'hash'),
                    'architecture' => TrainingJob::RECIPE['architecture'],
                    'model_size' => TrainingJob::RECIPE['model_size'],
                    'epochs' => TrainingJob::RECIPE['epochs'],
                    'sample_limit' => $plan['limit'],
                    'required_per_class' => (int) $plan['required'],
                    'class_counts' => collect($plan['classes'])->mapWithKeys(fn (array $row) => [$row['name'] => $row['eligible']])->all(),
                    'snapshot_class_counts' => $snapshotCounts,
                    'snapshot_type' => TrainingJob::query()->whereNotNull('dataset_version')->exists() ? 'cumulative' : 'initial_balanced',
                    'created_at' => now()->toIso8601String(),
                ],
                'started_at' => now(),
                'total_valid_samples' => count($dataset['items']),
            ]);
            foreach ($dataset['items'] as $row) {
                $annotations = $row['report']->annotations()->orderBy('id')->get(['id', 'class_name']);
                TrainingJobItem::query()->create([
                    'training_job_id' => $job->id,
                    'report_id' => $row['report_id'],
                    'annotation_id' => $annotations->first()?->id,
                    'class_name' => $annotations->pluck('class_name')->unique()->implode(', ') ?: null,
                    'image_hash' => $row['hash'],
                    'split' => $row['split'],
                    'inclusion_status' => 'included',
                    'validation_status' => 'valid',
                    'filename' => $row['filename'],
                    'upload_status' => 'pending',
                ]);
                MissedDetectionReport::query()->whereKey($row['report_id'])->whereNull('training_job_id')->update([
                    'training_job_id' => $job->id,
                ]);
            }

            return $job;
        });
        if ($result instanceof JsonResponse) {
            return $result;
        }
        $job = $result;

        ProcessTrainingJob::dispatch($job->id);
        LocalQueueWorker::ensure();

        return response()->json($job->fresh('items')?->toApiArray(), 201);
    }

    public function pickData(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        // Roboflow can take longer than PHP's default 30 s to answer.
        set_time_limit(300);
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can pick training data.'], 403);
        }
        $uploaded = (int) $trainingJob->items()->where('upload_status', 'uploaded')->count();
        $total = (int) $trainingJob->items()->count();
        $canPick = in_array($trainingJob->status, [TrainingJob::READY_TO_PICK, TrainingJob::FAILED], true)
            && $uploaded > 0
            && $uploaded === $total
            && ! $trainingJob->dataset_version;
        if (! $canPick) {
            return response()->json(['message' => 'Upload the dataset before picking data for a version.'], 422);
        }

        $roboflow = app(RoboflowClient::class);
        if (! $roboflow->configured()) {
            return response()->json([
                'message' => 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT in the API environment before training.',
            ], 422);
        }

        $snapshot = ReviewDataset::collectByIds($trainingJob->items()->orderBy('report_id')->pluck('report_id')->map(fn ($id) => (int) $id)->all());
        if ($snapshot['issues'] !== []) {
            return response()->json([
                'message' => 'Training stopped because the saved dataset snapshot is no longer valid.',
                'issues' => $snapshot['issues'],
            ], 422);
        }
        $snapshotCounts = $this->sampleCounts($snapshot['items']);
        $missingSnapshotClasses = array_values(array_filter(
            TrainingSamplePlan::requiredClasses(),
            fn (string $name) => ($snapshotCounts[$name] ?? 0) < $this->requiredForJob($trainingJob),
        ));
        if ($missingSnapshotClasses !== []) {
            return response()->json([
                'message' => 'This dataset version does not meet its saved approved-sample threshold for every class.',
                'classes' => $missingSnapshotClasses,
            ], 422);
        }

        $trainingJob->update([
            'status' => TrainingJob::CREATING_VERSION,
            'error_message' => null,
        ]);
        try {
            $version = $roboflow->generateVersion();
            $trainingJob->update([
                'dataset_version' => $version,
                'hosted_model_id' => $roboflow->project().'/'.$version,
                'status' => TrainingJob::READY_TO_TRAIN,
                'completed_at' => null,
            ]);
        } catch (\Throwable $e) {
            $trainingJob->update([
                'status' => TrainingJob::FAILED,
                'error_message' => $roboflow->redact($e->getMessage()),
                'completed_at' => now(),
            ]);

            return response()->json($trainingJob->fresh()?->toApiArray(), 422);
        }

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function startTraining(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        // Roboflow can take longer than PHP's default 30 s to answer.
        set_time_limit(300);
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can start training.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::READY_TO_TRAIN) {
            return response()->json(['message' => 'Upload and version the dataset before starting training.'], 422);
        }
        $data = $request->validate([
            'architecture' => ['required', 'in:yolov11'],
            'model_size' => ['required', 'in:large'],
            'epochs' => ['nullable', 'integer', 'in:350'],
        ]);
        $version = (int) $trainingJob->dataset_version;
        if ($version < 1) {
            return response()->json(['message' => 'This job has no Roboflow version to train.'], 422);
        }

        $roboflow = app(RoboflowClient::class);
        if (! $roboflow->configured()) {
            return response()->json([
                'message' => 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT in the API environment before training.',
            ], 422);
        }

        $snapshot = ReviewDataset::collectByIds($trainingJob->items()->orderBy('report_id')->pluck('report_id')->map(fn ($id) => (int) $id)->all());
        if ($snapshot['issues'] !== []) {
            return response()->json([
                'message' => 'Training stopped because the saved dataset snapshot is no longer valid.',
                'issues' => $snapshot['issues'],
            ], 422);
        }
        $snapshotCounts = $this->sampleCounts($snapshot['items']);
        $missingSnapshotClasses = array_values(array_filter(
            TrainingSamplePlan::requiredClasses(),
            fn (string $name) => ($snapshotCounts[$name] ?? 0) < $this->requiredForJob($trainingJob),
        ));
        if ($missingSnapshotClasses !== []) {
            return response()->json([
                'message' => 'This dataset version does not meet its saved approved-sample threshold for every class.',
                'classes' => $missingSnapshotClasses,
            ], 422);
        }

        $modelType = TrainingJob::RECIPE['model_type'];
        $speed = TrainingJob::RECIPE['training_speed'];
        $epochs = TrainingJob::RECIPE['epochs'];
        $manifest = is_array($trainingJob->manifest) ? $trainingJob->manifest : [];
        $manifest['architecture'] = $data['architecture'];
        $manifest['model_size'] = $data['model_size'];
        $manifest['epochs'] = $epochs;
        $manifest['snapshot_class_counts'] = $snapshotCounts;

        $trainingJob->update([
            'status' => TrainingJob::TRAINING,
            'model_type' => $modelType,
            'training_speed' => $speed,
            'error_message' => null,
            'manifest' => $manifest,
        ]);

        try {
            $roboflow->startTraining($version, $modelType, $speed, $epochs);
            $manifest['training_started'] = true;
            $manifest['training_started_at'] = now()->toIso8601String();
            $trainingJob->update(['manifest' => $manifest]);
            MissedDetectionReport::query()
                ->whereIn('id', $trainingJob->items()->pluck('report_id'))
                ->whereIn('status', [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED])
                ->update([
                    'status' => MissedDetectionReport::EXPORTED,
                    'updated_at' => now(),
                ]);
            MissedDetectionReport::syncAnnotationStatus($trainingJob->items()->pluck('report_id'));
            WatchTrainingJob::dispatch($trainingJob->id);
            LocalQueueWorker::ensure();
        } catch (\Throwable $e) {
            if (str_contains(strtolower($e->getMessage()), 'still generating')) {
                // Roboflow needs a few minutes to build a new version. Not a failure:
                // keep the job ready so the admin can press Start training again.
                $trainingJob->update([
                    'status' => TrainingJob::READY_TO_TRAIN,
                    'error_message' => null,
                    'completed_at' => null,
                ]);

                return response()->json([
                    'message' => 'Roboflow is still preparing dataset version '.$version.'. Wait a few minutes, then press Start training again.',
                    'job' => $trainingJob->fresh()?->toApiArray(),
                ], 409);
            }
            $trainingJob->update([
                'status' => TrainingJob::FAILED,
                'error_message' => $roboflow->redact($e->getMessage()),
                'completed_at' => now(),
            ]);

            return response()->json($trainingJob->fresh()?->toApiArray(), 422);
        }

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function retry(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        // Roboflow can take longer than PHP's default 30 s to answer.
        set_time_limit(300);
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can retry training.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::FAILED) {
            return response()->json(['message' => 'Only a failed job can be retried.'], 422);
        }
        if (TrainingJob::query()->whereIn('status', TrainingJob::ACTIVE)->where('id', '!=', $trainingJob->id)->exists()) {
            return response()->json(['message' => 'A training job is already running.'], 422);
        }
        $uploaded = (int) $trainingJob->items()->where('upload_status', 'uploaded')->count();
        $total = (int) $trainingJob->items()->count();
        if ($uploaded > 0 && $uploaded === $total && $trainingJob->dataset_version) {
            $trainingJob->update([
                'status' => TrainingJob::READY_TO_TRAIN,
                'error_message' => null,
                'completed_at' => null,
            ]);
            $request->merge([
                'architecture' => TrainingJob::RECIPE['architecture'],
                'model_size' => TrainingJob::RECIPE['model_size'],
                'epochs' => TrainingJob::RECIPE['epochs'],
            ]);

            return $this->startTraining($request, $trainingJob->fresh() ?? $trainingJob);
        }
        if ($uploaded > 0 && $uploaded === $total && ! $trainingJob->dataset_version) {
            $trainingJob->update([
                'status' => TrainingJob::READY_TO_PICK,
                'error_message' => null,
                'completed_at' => null,
            ]);

            return $this->pickData($request, $trainingJob->fresh() ?? $trainingJob);
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
        LocalQueueWorker::ensure();

        return response()->json($trainingJob->fresh('items')?->toApiArray());
    }

    public function dismiss(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can clear a training job.'], 403);
        }
        if (in_array($trainingJob->status, TrainingJob::ACTIVE, true)) {
            return response()->json(['message' => 'Wait for this job to finish or fail before clearing it.'], 422);
        }
        if ($trainingJob->status === TrainingJob::DISMISSED) {
            return response()->json($trainingJob->toApiArray());
        }

        $manifest = is_array($trainingJob->manifest) ? $trainingJob->manifest : [];
        $trainingStarted = (bool) ($manifest['training_started'] ?? false);
        if ($trainingJob->status === TrainingJob::FAILED && ! $trainingStarted) {
            $releasedIds = MissedDetectionReport::query()
                ->where('training_job_id', $trainingJob->id)
                ->pluck('id');
            MissedDetectionReport::query()
                ->where('training_job_id', $trainingJob->id)
                ->update([
                    'training_job_id' => null,
                    'status' => MissedDetectionReport::APPROVED,
                    'updated_at' => now(),
                ]);
            MissedDetectionReport::syncAnnotationStatus($releasedIds);
        }

        $trainingJob->update(['status' => TrainingJob::DISMISSED]);

        return response()->json($trainingJob->fresh()?->toApiArray());
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

    public function deploy(Request $request, TrainingJob $trainingJob, TrainedModelInstaller $installer): JsonResponse
    {
        // Downloading and converting the weights takes minutes, longer than PHP's default 30 s.
        set_time_limit(900);
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can deploy a model.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::APPROVED_FOR_DEPLOYMENT) {
            return response()->json(['message' => 'Approve the model for deployment first.'], 422);
        }
        if (! $trainingJob->dataset_version) {
            return response()->json(['message' => 'This job has no Roboflow version to download.'], 422);
        }
        try {
            $installed = $installer->install((int) $trainingJob->dataset_version);
        } catch (\Throwable $e) {
            return response()->json([
                'message' => app(RoboflowClient::class)->redact($e->getMessage()),
            ], 422);
        }
        $connected = $installed['reloaded']
            ? 'The cameras are now using the new weights.'
            : 'The new weights are saved. Restart the detector to load them.';
        $manifest = is_array($trainingJob->manifest) ? $trainingJob->manifest : [];
        $manifest['previous_live_model'] = \App\Support\LiveModel::current();
        // Classes of the new model (may include new ones); keep the old list for Rollback.
        $manifest['previous_model_classes'] = \App\Support\ClassRegistry::modelClasses();
        if (! empty($installed['classes'])) {
            $manifest['model_classes'] = $installed['classes'];
            \App\Support\ClassRegistry::saveModelClasses($installed['classes']);
        }
        \App\Support\LiveModel::save(
            \App\Support\LiveModel::datasetFromHostedModel($trainingJob->hosted_model_id, (int) $trainingJob->dataset_version),
            \App\Support\LiveModel::modelName($manifest['architecture'] ?? TrainingJob::RECIPE['architecture'], $manifest['model_size'] ?? TrainingJob::RECIPE['model_size']),
        );
        $trainingJob->update([
            'manifest' => $manifest,
            'status' => TrainingJob::DEPLOYED,
            'previous_model_path' => $installed['live'],
            'backup_model_path' => $installed['backup'],
            'deployed_at' => now(),
            'evaluation_notes' => trim((string) $trainingJob->evaluation_notes."\nDownloaded ".$trainingJob->hosted_model_id.' and installed it as the live ONNX. '.$connected),
        ]);

        return response()->json($trainingJob->fresh()?->toApiArray());
    }

    public function rollback(Request $request, TrainingJob $trainingJob): JsonResponse
    {
        // Copying the backup and reloading the detector can pass 30 s.
        set_time_limit(300);
        if (! $this->isAdmin($request->user())) {
            return response()->json(['message' => 'Only an administrator can roll back a model.'], 403);
        }
        if ($trainingJob->status !== TrainingJob::DEPLOYED || ! $trainingJob->backup_model_path) {
            return response()->json(['message' => 'There is no backup for this job.'], 422);
        }
        if (! is_file($trainingJob->backup_model_path)) {
            return response()->json(['message' => 'The backup file is missing.'], 422);
        }
        $live = $trainingJob->previous_model_path ?: app(TrainedModelInstaller::class)->onnxPath();
        File::copy($trainingJob->backup_model_path, $live);
        $reloaded = app(TrainedModelInstaller::class)->reloadDetector();
        $previous = ($trainingJob->manifest ?? [])['previous_live_model'] ?? null;
        // Back to the class list of the previous model.
        \App\Support\ClassRegistry::saveModelClasses((array) (($trainingJob->manifest ?? [])['previous_model_classes'] ?? []));
        \App\Support\LiveModel::save(
            is_array($previous) ? (string) ($previous['dataset'] ?? '') : '',
            is_array($previous) ? (string) ($previous['model'] ?? '') : '',
        );
        $trainingJob->update([
            'status' => TrainingJob::REJECTED,
            'evaluation_notes' => trim((string) $trainingJob->evaluation_notes."\nRolled back to the previous local ONNX backup."),
        ]);

        return response()->json([
            ...($trainingJob->fresh()?->toApiArray() ?? []),
            'message' => $reloaded
                ? 'Rolled back. The cameras are now using the previous weights.'
                : 'The previous weights are restored on disk. Restart the detector to load them.',
            'reloaded' => $reloaded,
        ]);
    }

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }

    private function requiredForJob(TrainingJob $trainingJob): int
    {
        $manifest = is_array($trainingJob->manifest) ? $trainingJob->manifest : [];
        $required = (int) ($manifest['required_per_class'] ?? $manifest['sample_limit'] ?? TrainingSamplePlan::current());

        return in_array($required, TrainingSamplePlan::OPTIONS, true) ? $required : TrainingSamplePlan::DEFAULT;
    }

    /** @param list<array<string, mixed>> $items @return array<string, int> */
    private function sampleCounts(array $items): array
    {
        $counts = array_fill_keys(WasteClassMap::classes(), 0);
        foreach ($items as $item) {
            $report = $item['report'] ?? null;
            if (! $report) continue;
            $classes = [];
            foreach ($report->annotations as $annotation) {
                if (isset($counts[$annotation->class_name]) && $annotation->toYoloLine() !== null) {
                    $classes[$annotation->class_name] = true;
                }
            }
            foreach (array_keys($classes) as $name) $counts[$name]++;
        }

        return $counts;
    }
}
