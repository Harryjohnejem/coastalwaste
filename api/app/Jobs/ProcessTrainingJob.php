<?php

namespace App\Jobs;

use App\Models\TrainingJob;
use App\Services\RoboflowClient;
use App\Support\ReviewDataset;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
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
        if (! in_array($job->status, [TrainingJob::PREPARING, TrainingJob::UPLOADING, TrainingJob::FAILED], true)) {
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
                'model_type' => TrainingJob::RECIPE['model_type'],
                'training_speed' => TrainingJob::RECIPE['training_speed'],
                'preprocessing' => $roboflow->preprocessing(),
                'augmentation' => $roboflow->augmentation(),
                'error_message' => null,
            ]);

            $this->uploadPending($job, $roboflow);

            $job->update(['status' => TrainingJob::READY_TO_PICK]);
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
                    'validation_status' => 'invalid',
                    'upload_error' => 'The review image or annotation is no longer valid.',
                ]);
                throw new \RuntimeException("Review {$item->report_id} failed validation during upload.");
            }

            $item->update(['upload_status' => 'uploading', 'upload_error' => null]);
            $uploaded = $roboflow->uploadImage($row['filename'], $row['bytes'], $row['mime'], $item->split ?: $row['split']);
            $labelName = pathinfo($row['filename'], PATHINFO_FILENAME).'.txt';
            $roboflow->saveAnnotation($uploaded['id'], $labelName, $row['yolo'], $labelmap);
            $item->update([
                'roboflow_image_id' => $uploaded['id'],
                'upload_status' => 'uploaded',
                'validation_status' => 'valid',
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
