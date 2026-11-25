<?php

namespace App\Support;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\Notification;
use App\Models\SystemSetting;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * Cleanup threshold ("waste load").
 *
 * Counts the waste each camera still sees on the beach (status Present) and
 * compares it with the cleanup limit from Settings > Notifications:
 *   normal  – below the warning level
 *   warning – at or above the warning percent of the limit (waste building up)
 *   full    – at or above the limit (send a cleanup team)
 *
 * Admins get one notification each time a camera climbs to a higher level.
 * A camera only drops back to normal once its count falls below the warning
 * level, so a count that wobbles around the limit does not send repeat alerts.
 */
class WasteLoad
{
    public const DEFAULT_LIMIT = 20;

    public const DEFAULT_WARN_PERCENT = 70;

    private const LEVELS_KEY = 'waste_load_levels';

    /** Latest result, refreshed by every detector frame; read by the dashboard poll. */
    private const STATUS_KEY = 'waste-load:status';

    private const RANK = ['normal' => 0, 'warning' => 1, 'full' => 2];

    /** @return array{enabled: bool, limit: int, warn_percent: int, warn_at: int} */
    public static function config(): array
    {
        $alerts = SystemSetting::getDefault()['alerts'] ?? [];
        $limit = self::clampInt($alerts['cleanupLimit'] ?? null, 1, 500, self::DEFAULT_LIMIT);
        $warn = self::clampInt($alerts['densityThreshold'] ?? null, 10, 95, self::DEFAULT_WARN_PERCENT);

        return [
            'enabled' => (bool) ($alerts['densityAlerts'] ?? true),
            'limit' => $limit,
            'warn_percent' => $warn,
            'warn_at' => max(1, (int) ceil($limit * $warn / 100)),
        ];
    }

    /** Current load per camera and for the whole site, without sending alerts. */
    public static function status(): array
    {
        WastePresence::sweepStale();
        $config = self::config();
        $counts = Detection::query()
            ->notMovedToReview()
            ->where('status', 'Present')
            ->selectRaw('camera_id, COUNT(*) as total')
            ->groupBy('camera_id')
            ->pluck('total', 'camera_id');

        // Levels already reached stay until the count drops below the warning
        // level, so one missed camera frame does not flip Full -> Warning -> Full.
        $stored = SystemSetting::query()->find(self::LEVELS_KEY)?->value ?? [];
        $cameraModels = Camera::query()->orderBy('camera_code')
            ->get(['id', 'camera_code', 'camera_name', 'monitoring_location']);
        $live = self::liveCounts($cameraModels->pluck('camera_code')->all());
        $cameras = $cameraModels
            ->map(function (Camera $camera) use ($counts, $config, $stored, $live) {
                // The same number of boxes Live Monitoring shows; saved records only
                // when the detector cannot be reached.
                $liveCount = $live[$camera->camera_code] ?? null;
                $count = $liveCount ?? (int) ($counts[$camera->id] ?? 0);
                $level = self::levelFor($count, $config);
                $held = $stored[$camera->camera_code] ?? 'normal';
                if ($level !== 'normal' && isset(self::RANK[$held]) && self::RANK[$held] > self::RANK[$level]) {
                    $level = $held;
                }

                return [
                    'code' => $camera->camera_code,
                    'name' => $camera->camera_name,
                    'location' => $camera->monitoring_location,
                    'count' => $count,
                    'source' => $liveCount === null ? 'records' : 'live',
                    'percent' => (int) min(999, round($count * 100 / $config['limit'])),
                    'level' => $level,
                ];
            })->values()->all();

        $worst = 'normal';
        foreach ($cameras as $row) {
            if (self::RANK[$row['level']] > self::RANK[$worst]) {
                $worst = $row['level'];
            }
        }

        return $config + [
            'level' => $config['enabled'] ? $worst : 'normal',
            'total' => array_sum(array_column($cameras, 'count')),
            'cameras' => $cameras,
            'checked_at' => now()->toIso8601String(),
        ];
    }

    /**
     * Status plus alerts. Safe to call often: it only writes when a camera
     * changes level, and it runs at most once every 2 seconds.
     */
    public static function check(): array
    {
        $status = self::status();
        Cache::put(self::STATUS_KEY, $status, 3);
        if (! $status['enabled'] || ! Cache::add('waste-load:check-lock', 1, 2)) {
            return $status;
        }

        $stored = SystemSetting::query()->find(self::LEVELS_KEY)?->value ?? [];
        $next = [];
        foreach ($status['cameras'] as $row) {
            $code = (string) $row['code'];
            $before = $stored[$code] ?? 'normal';
            $now = $row['level'];

            if ($now === 'normal') {
                // Cleaned below the warning level: start over.
                $next[$code] = 'normal';
                if ($before === 'full') {
                    self::notify($row, 'cleared', $status);
                }
            } elseif (self::RANK[$now] > self::RANK[$before]) {
                $next[$code] = $now;
                self::notify($row, $now, $status);
            } else {
                // Same level, or slipped from full to warning: keep the higher
                // level so the limit does not alert again until it is cleaned.
                $next[$code] = $before;
            }
        }

        if ($next !== $stored) {
            SystemSetting::query()->updateOrCreate(['key' => self::LEVELS_KEY], ['value' => $next]);
        }

        return $status;
    }

    /** The saved result when it is under 3 seconds old, otherwise a fresh check. */
    public static function latest(): array
    {
        $cached = Cache::get(self::STATUS_KEY);

        return is_array($cached) ? $cached : self::check();
    }

    /**
     * Waste boxes each live camera shows right now, read from the detector
     * (the same feed Live Monitoring draws). Uses the screen's rule: a tracked
     * box is drawn; an untracked one needs 50% (provisional) or 80%.
     * Cached for 1 s. A camera is missing when the detector does not answer.
     *
     * @param  list<string>  $codes
     * @return array<string, int>
     */
    public static function liveCounts(array $codes): array
    {
        if (! config('services.detector.live_counts', true) || $codes === []) {
            return [];
        }

        return Cache::remember('waste-load:live-counts', 1, function () use ($codes) {
            $base = rtrim((string) config('services.detector.url', 'http://127.0.0.1:8092'), '/');
            $out = [];
            foreach ($codes as $code) {
                try {
                    $response = Http::timeout(1)->connectTimeout(0.5)
                        ->get($base.'/overlay', ['camera_id' => $code]);
                } catch (\Throwable) {
                    continue;
                }
                $body = $response->successful() ? $response->json() : null;
                if (! is_array($body) || ($body['connected'] ?? true) === false) {
                    continue;
                }
                $age = $body['overlay_age_ms'] ?? null;
                if (is_numeric($age) && (float) $age > 30000) {
                    // Old picture: the camera stopped; nothing is on screen.
                    $out[$code] = 0;

                    continue;
                }
                $count = 0;
                foreach ((array) ($body['boxes'] ?? []) as $box) {
                    if (! is_array($box)) {
                        continue;
                    }
                    $boxCamera = strtoupper((string) ($box['camera_id'] ?? $code));
                    if ($boxCamera !== strtoupper($code)) {
                        continue;
                    }
                    $score = (float) ($box['confidence'] ?? 0);
                    $score = $score > 1.5 ? $score / 100 : $score;
                    $tracked = ($box['track_id'] ?? null) !== null || ($box['held'] ?? false) === true;
                    $provisional = ($box['provisional'] ?? false) === true;
                    if ($tracked || ($provisional ? $score >= 0.5 : $score >= 0.8)) {
                        $count++;
                    }
                }
                $out[$code] = $count;
            }

            return $out;
        });
    }

    private static function levelFor(int $count, array $config): string
    {
        if ($count >= $config['limit']) {
            return 'full';
        }

        return $count >= $config['warn_at'] ? 'warning' : 'normal';
    }

    private static function notify(array $row, string $kind, array $status): void
    {
        $camera = $row['name'] ?: $row['code'];
        $where = $row['location'] ?: 'the beach';
        [$title, $message, $type] = match ($kind) {
            'full' => [
                "Cleanup needed · {$row['code']}",
                "{$camera} at {$where} has reached the cleanup limit: {$row['count']} waste items are still on the beach (limit {$status['limit']}). Send a cleanup team now.",
                'danger',
            ],
            'warning' => [
                "Waste building up · {$row['code']}",
                "{$camera} at {$where} is at {$row['percent']}% of the cleanup limit ({$row['count']} of {$status['limit']} items). Plan a cleanup soon.",
                'warning',
            ],
            default => [
                "Back to normal · {$row['code']}",
                "{$camera} at {$where} is back below the warning level ({$row['count']} items on camera). This is what the camera sees; it does not verify cleaning.",
                'success',
            ],
        };

        $admins = User::query()->where('role', 'Admin')->get();
        if ($admins->isEmpty()) {
            $admins = User::query()->orderBy('id')->limit(1)->get();
        }
        foreach ($admins as $admin) {
            Notification::query()->create([
                'user_id' => $admin->id,
                'title' => $title,
                'message' => $message,
                'type' => $type,
                'is_read' => false,
            ]);
        }
    }

    private static function clampInt(mixed $value, int $min, int $max, int $fallback): int
    {
        if (! is_numeric($value)) {
            return $fallback;
        }

        return max($min, min($max, (int) $value));
    }
}
