<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Build Detection Reviews table thumbnails for existing reviews (needs the PHP GD extension).
Artisan::command('reviews:thumbnails', function () {
    if (! \App\Support\ReviewThumbnail::available()) {
        $this->error('The PHP GD extension is off. Enable extension=gd in php.ini, then run this again.');

        return 1;
    }
    $made = 0;
    \App\Models\MissedDetectionReport::query()->select(['id', 'image_path'])->orderBy('id')
        ->chunk(200, function ($reports) use (&$made) {
            foreach ($reports as $report) {
                $thumb = \App\Support\ReviewThumbnail::pathFor((string) $report->image_path);
                if (! \Illuminate\Support\Facades\Storage::disk('public')->exists($thumb)
                    && \App\Support\ReviewThumbnail::make((string) $report->image_path)) {
                    $made++;
                }
            }
        });
    $this->info("Thumbnails created: {$made}");

    return 0;
})->purpose('Create small thumbnails for the Detection Reviews table');

// Backups (storage/app/backups). They run while "php artisan schedule:work" is running.
\Illuminate\Support\Facades\Schedule::command('system:backup')->dailyAt('02:00');
\Illuminate\Support\Facades\Schedule::command('system:backup --files')->weeklyOn(0, '02:30');
