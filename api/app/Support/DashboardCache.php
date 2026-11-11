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

    public static function flush(): void
    {
        Cache::forget(self::statsKey());
        Cache::forget(self::trendsKey());
        foreach (['24h', '7d', '30d', 'all'] as $range) {
            Cache::forget(self::compositionKey($range));
        }
    }
}
