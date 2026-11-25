<?php

namespace App\Support;

use Illuminate\Support\Facades\Cache;

/** Starts the local queue so an upload runs without a separate terminal command. */
class LocalQueueWorker
{
    public static function ensure(): void
    {
        if (config('queue.default') === 'sync' || app()->runningUnitTests()) {
            return;
        }
        if (Cache::get('local-queue-worker') === 'up' || self::running()) {
            Cache::put('local-queue-worker', 'up', 20);

            return;
        }

        self::start();
        Cache::put('local-queue-worker', 'up', 20);
    }

    private static function running(): bool
    {
        if (PHP_OS_FAMILY === 'Windows') {
            $out = shell_exec('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=\'php.exe\'\" | Select-Object -ExpandProperty CommandLine"');

            return is_string($out) && str_contains($out, 'queue:work');
        }
        $out = shell_exec('ps -eo args') ?: '';

        return str_contains($out, 'artisan queue:work');
    }

    private static function start(): void
    {
        $php = escapeshellarg(PHP_BINARY);
        $artisan = escapeshellarg(base_path('artisan'));
        $log = escapeshellarg(storage_path('logs/queue-worker.log'));
        $work = $php.' '.$artisan.' queue:work --sleep=1 --timeout=600 --tries=1';
        if (PHP_OS_FAMILY === 'Windows') {
            $command = 'cmd /C start "" /B '.$work.' >> '.$log.' 2>&1';
            pclose(popen($command, 'r'));

            return;
        }
        exec($work.' >> '.$log.' 2>&1 &');
    }
}
