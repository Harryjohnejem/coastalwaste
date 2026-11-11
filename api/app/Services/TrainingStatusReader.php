<?php

namespace App\Services;

use App\Models\TrainingJob;

class TrainingStatusReader
{
    public function __construct(private RoboflowClient $roboflow) {}

    public function refresh(TrainingJob $job): TrainingJob
    {
        if ($job->status !== TrainingJob::TRAINING || ! $job->dataset_version) {
            return $job;
        }
        if (! $this->roboflow->configured()) {
            return $job;
        }

        try {
            $payload = $this->roboflow->versionStatus((int) $job->dataset_version);
        } catch (\Throwable $e) {
            $job->update([
                'error_message' => $this->roboflow->redact($e->getMessage()),
            ]);

            return $job->fresh() ?? $job;
        }
        $state = strtolower((string) (
            $payload['status']
            ?? $payload['train']['status']
            ?? $payload['training']['status']
            ?? $payload['model']['status']
            ?? ''
        ));
        $metrics = $this->metrics($payload);
        $failed = in_array($state, ['failed', 'error', 'cancelled', 'canceled'], true)
            || isset($payload['error']);

        if ($failed) {
            $job->update([
                'status' => TrainingJob::FAILED,
                'metrics' => $metrics ?: $job->metrics,
                'error_message' => is_string($payload['error'] ?? null)
                    ? $payload['error']
                    : 'Roboflow reported a training failure.',
                'completed_at' => now(),
            ]);

            return $job->fresh() ?? $job;
        }

        $model = is_array($payload['model'] ?? null) ? $payload['model'] : [];
        $hasMetrics = isset($model['map']) || isset($model['mAP']) || isset($payload['map']) || isset($payload['mAP']);
        $done = in_array($state, ['finished', 'complete', 'completed', 'success', 'trained'], true)
            || ($hasMetrics && ! in_array($state, ['training', 'generating', 'pending', 'queued'], true));

        if ($done) {
            $job->update([
                'status' => TrainingJob::AWAITING_EVALUATION,
                'metrics' => $metrics ?: $job->metrics,
                'error_message' => null,
                'completed_at' => now(),
            ]);
        } elseif ($metrics) {
            $job->update(['metrics' => $metrics]);
        }

        return $job->fresh() ?? $job;
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>|null
     */
    private function metrics(array $payload): ?array
    {
        $model = is_array($payload['model'] ?? null) ? $payload['model'] : [];
        $keys = ['map', 'mAP', 'map50', 'precision', 'recall', 'progress'];
        $out = [];
        foreach ($keys as $key) {
            if (isset($payload[$key]) && is_numeric($payload[$key])) {
                $out[$key] = $payload[$key];
            }
            if (isset($model[$key]) && is_numeric($model[$key])) {
                $out[$key] = $model[$key];
            }
        }

        return $out === [] ? null : $out;
    }
}
