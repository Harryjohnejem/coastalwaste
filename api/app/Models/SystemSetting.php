<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Cache;

class SystemSetting extends Model
{
    public $incrementing = false;

    protected $primaryKey = 'key';

    protected $keyType = 'string';

    protected $fillable = [
        'key',
        'value',
    ];

    protected function casts(): array
    {
        return [
            'value' => 'array',
        ];
    }

    public static function getDefault(): array
    {
        return static::query()->find('default')?->value ?? [];
    }

    public static function saveDefault(array $settings): void
    {
        static::query()->updateOrCreate(
            ['key' => 'default'],
            ['value' => $settings],
        );
        Cache::forget('settings:detection_enabled');
    }
}
