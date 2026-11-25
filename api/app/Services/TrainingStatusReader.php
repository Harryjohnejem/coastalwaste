<?php

namespace App\Services;

use App\Models\TrainingJob;

class TrainingStatusReader
{
    public function __construct(
        private RoboflowClient $roboflow,
    ) {}

    public function refresh(TrainingJob $job): TrainingJob
    {
        if ($job->status !== TrainingJob::TRAINING || ! $job->dataset_version) {
            return $job;
        }
        if (! $this->roboflow->configured()) {
            return $job;
        }

        try {
            $payload = $this->versionPayload($this->roboflow->versionStatus((int) $job->dataset_version));
        } catch (\Illuminate\Http\Client\ConnectionException $e) {
            // A slow or dropped connection is not a training problem. Keep the job
            // as it is; the watcher checks Roboflow again in a minute.
            report($e);

            return $job;
        } catch (\Throwable $e) {
            $job->update([
                'error_message' => $this->roboflow->redact($e->getMessage()),
            ]);

            return $job->fresh() ?? $job;
        }
        if ($job->error_message !== null) {
            // Roboflow answered, so an earlier check error no longer applies.
            $job->update(['error_message' => null]);
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
            return $this->finishTraining($job, $metrics);
        }
        if ($metrics) {
            $previous = is_array($job->metrics) ? $job->metrics : [];
            $job->update(['metrics' => array_merge($previous, $metrics)]);
        }

        return $job->fresh() ?? $job;
    }

    /**
     * @param  array<string, mixed>|null  $metrics
     */
    private function finishTraining(TrainingJob $job, ?array $metrics): TrainingJob
    {
        $claimed = TrainingJob::query()
            ->whereKey($job->id)
            ->where('status', TrainingJob::TRAINING)
            ->update([
                'status' => TrainingJob::AWAITING_EVALUATION,
                'error_message' => null,
                'completed_at' => now(),
            ]);
        if ($claimed === 0) {
            return $job->fresh() ?? $job;
        }

        $job = $job->fresh() ?? $job;
        if ($metrics) {
            $job->update(['metrics' => $metrics]);
        }
        $job->update([
            'status' => TrainingJob::AWAITING_EVALUATION,
            'error_message' => null,
            'completed_at' => now(),
            'evaluation_notes' => trim((string) $job->evaluation_notes."\nTraining finished. Review and evaluate this model, then approve deployment explicitly before replacing the live weights."),
        ]);

        return $job->fresh() ?? $job;
    }

    /**
     * Roboflow nests the trained model under version, not at the top of the reply.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function versionPayload(array $payload): array
    {
        $version = $payload['version'] ?? null;
        if (! is_array($version)) {
            return $payload;
        }
        $train = is_array($version['train'] ?? null) ? $version['train'] : [];
        $results = is_array($train['results'] ?? null) ? $train['results'] : [];
        if (! isset($train['epoch']) && isset($results['finished_epochs']) && is_numeric($results['finished_epochs'])) {
            $train['epoch'] = $results['finished_epochs'];
        }
        $trainings = $version['trainings'] ?? null;
        if (($train['status'] ?? '') === '' && is_array($trainings) && is_string($trainings[0]['status'] ?? null)) {
            $train['status'] = $trainings[0]['status'];
        }
        if ($train !== []) {
            $version['train'] = $train;
        }

        return array_replace($payload, $version);
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>|null
     */
    private function metrics(array $payload): ?array
    {
        $model = is_array($payload['model'] ?? null) ? $payload['model'] : [];
        $train = is_array($payload['train'] ?? null) ? $payload['train'] : [];
        $training = is_array($payload['training'] ?? null) ? $payload['training'] : [];
        $keys = ['map', 'mAP', 'map50', 'precision', 'recall', 'progress'];
        $out = [];
        foreach ($keys as $key) {
            // Top-level "progress" is how far Roboflow got generating the dataset
            // version, not training progress, so only model/train progress counts.
            if ($key !== 'progress' && isset($payload[$key]) && is_numeric($payload[$key])) {
                $out[$key] = $payload[$key];
            }
            if (isset($model[$key]) && is_numeric($model[$key])) {
                $out[$key] = $model[$key];
            }
            if (isset($train[$key]) && is_numeric($train[$key])) {
                $out[$key] = $train[$key];
            }
        }
        $epoch = $this->firstNumeric([
            $payload['epoch'] ?? null,
            $payload['current_epoch'] ?? null,
            $model['epoch'] ?? null,
            $model['current_epoch'] ?? null,
            $train['epoch'] ?? null,
            $train['current_epoch'] ?? null,
            $training['epoch'] ?? null,
            $training['current_epoch'] ?? null,
        ]);
        if ($epoch !== null) {
            $out['epoch'] = $epoch;
        }
        if (isset($out['progress']) && is_numeric($out['progress']) && (float) $out['progress'] > 1) {
            $out['progress'] = min(1, ((float) $out['progress']) / 100);
        }

        return $out === [] ? null : $out;
    }

    /**
     * @param  list<mixed>  $values
     */
    private function firstNumeric(array $values): ?float
    {
        foreach ($values as $value) {
            if (is_numeric($value)) {
                return (float) $value;
            }
        }

        return null;
    }
}
