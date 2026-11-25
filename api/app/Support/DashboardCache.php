<?php

namespace App\Support;

use Illuminate\Support\Facades\Cache;

class DashboardCache
{
    public const TTL_SECONDS = 8;

    public static function statsKey(): string
    {
        return 'dashboard:stats:today';
    }

    public static function compositionKey(string $range): string
    {
        return 'dashboard:composition:'.$range;
    }

    public static function trendsKey(): string
    {
        return 'dashboard:trends';
    }

    public static function detectionsKey(int $limit, bool $perClass = false): string
    {
        return $perClass
            ? 'dashboard:detections:class:'.$limit
            : 'dashboard:detections:'.$limit;
    }

    public static function flush(): void
    {
        Cache::forget(self::statsKey());
        Cache::forget(self::trendsKey());
        // Delete, move to review, or a new record: the cleanup banner counts again.
        Cache::forget('waste-load:status');
        foreach (['24h', '7d', '30d', 'all'] as $range) {
            Cache::forget(self::compositionKey($range));
        }
        foreach ([50, 100, 200, 500, 1000] as $limit) {
            Cache::forget(self::detectionsKey($limit));
            Cache::forget(self::detectionsKey($limit, true));
        }
    }
}
