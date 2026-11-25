<?php

namespace App\Jobs;

use App\Models\TrainingJob;
use App\Services\TrainingStatusReader;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class WatchTrainingJob implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public int $timeout = 90;

    public function __construct(public int $trainingJobId, public int $poll = 0) {}

    public function handle(TrainingStatusReader $reader): void
    {
        $job = TrainingJob::query()->find($this->trainingJobId);
        if (! $job) {
            return;
        }
        if ($job->status !== TrainingJob::TRAINING) {
            return;
        }

        $job = $reader->refresh($job);
        if ($job->status === TrainingJob::TRAINING && config('queue.default') !== 'sync' && $this->poll < 360) {
            static::dispatch($this->trainingJobId, $this->poll + 1)->delay(now()->addSeconds(60));
        }
    }
}
