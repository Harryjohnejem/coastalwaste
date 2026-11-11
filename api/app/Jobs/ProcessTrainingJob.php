<?php

namespace App\Jobs;

use App\Models\MissedDetectionReport;
use App\Models\TrainingJob;
use App\Services\RoboflowClient;
use App\Support\ReviewDataset;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use Throwable;

class ProcessTrainingJob implements ShouldQueue
{
    use Queueable;

    public int $timeout = 600;

    public int $tries = 1;

    public function __construct(public int $trainingJobId) {}

    public function handle(RoboflowClient $roboflow): void
    {
        $job = TrainingJob::query()->with('items')->find($this->trainingJobId);
        if (! $job) {
            return;
        }
        if (! in_array($job->status, [TrainingJob::PREPARING, TrainingJob::UPLOADING, TrainingJob::CREATING_VERSION, TrainingJob::FAILED], true)) {
            return;
        }

        try {
            if (! $roboflow->configured()) {
                throw new \RuntimeException('Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT before training.');
            }

            $job->update([
                'status' => TrainingJob::UPLOADING,
                'workspace' => $roboflow->workspace(),
                'project' => $roboflow->project(),
                'model_type' => $roboflow->modelType(),
                'training_speed' => $roboflow->speed(),
                'preprocessing' => $roboflow->preprocessing(),
                'augmentation' => $roboflow->augmentation(),
                'error_message' => null,
            ]);

            $this->uploadPending($job, $roboflow);

            $job->update(['status' => TrainingJob::CREATING_VERSION]);
            $version = $job->dataset_version ?: $roboflow->generateVersion();
            $hosted = $roboflow->project().'/'.$version;
            $job->update([
                'dataset_version' => $version,
                'hosted_model_id' => $hosted,
                'status' => TrainingJob::TRAINING,
            ]);

            $manifest = is_array($job->manifest) ? $job->manifest : [];
            if (empty($manifest['training_started'])) {
                $roboflow->startTraining($version);
                $manifest['training_started'] = true;
                $job->update(['manifest' => $manifest]);
            }

            DB::transaction(function () use ($job) {
                MissedDetectionReport::query()
                    ->where('training_job_id', $job->id)
                    ->update([
                        'status' => MissedDetectionReport::EXPORTED,
                        'updated_at' => now(),
                    ]);
            });
        } catch (Throwable $e) {
            $job->update([
                'status' => TrainingJob::FAILED,
                'error_message' => $roboflow->redact($e->getMessage()),
                'completed_at' => now(),
            ]);
        }
    }

    private function uploadPending(TrainingJob $job, RoboflowClient $roboflow): void
    {
        $dataset = ReviewDataset::collectByIds($job->items->pluck('report_id')->all());
        if ($dataset['issues'] !== []) {
            throw new \RuntimeException(implode(' ', $dataset['issues']));
        }
        $byId = [];
        foreach ($dataset['items'] as $row) {
            $byId[$row['report_id']] = $row;
        }
        $labelmap = ReviewDataset::labelmap();

        foreach ($job->items as $item) {
            if ($item->upload_status === 'uploaded' && $item->roboflow_image_id) {
                continue;
            }
            $row = $byId[$item->report_id] ?? null;
            if (! $row) {
                $item->update([
                    'upload_status' => 'failed',
                    'upload_error' => 'The review image or annotation is no longer valid.',
                ]);
                throw new \RuntimeException("Review {$item->report_id} failed validation during upload.");
            }

            $item->update(['upload_status' => 'uploading', 'upload_error' => null]);
            $uploaded = $roboflow->uploadImage($row['filename'], $row['bytes'], $row['mime'], $item->split ?: $row['split']);
            $roboflow->saveAnnotation($uploaded['id'], $row['filename'], $row['yolo'], $labelmap);
            $item->update([
                'roboflow_image_id' => $uploaded['id'],
                'upload_status' => 'uploaded',
                'image_hash' => $row['hash'],
            ]);
        }
    }

    public function failed(?Throwable $exception): void
    {
        TrainingJob::query()->whereKey($this->trainingJobId)->update([
            'status' => TrainingJob::FAILED,
            'error_message' => app(RoboflowClient::class)->redact($exception?->getMessage() ?: 'Training job failed.'),
            'completed_at' => now(),
        ]);
    }
}
