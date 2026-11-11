<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Camera extends Model
{
    protected $fillable = [
        'camera_code',
        'camera_name',
        'monitoring_location',
        'ip_address',
        'status',
        'last_seen',
        'stream_url',
        'protocol',
        'transport',
        'username',
        'password',
        'resolution',
        'fps',
        'detection_enabled',
        'in_grid',
    ];

    protected $hidden = [
        'password',
    ];

    protected function casts(): array
    {
        return [
            'last_seen' => 'datetime',
            'detection_enabled' => 'boolean',
            'in_grid' => 'boolean',
        ];
    }

    /** Route binding uses camera_code (e.g. CAM-01). */
    public function getRouteKeyName(): string
    {
        return 'camera_code';
    }

    /** Camera hasMany Detections. */
    public function detections(): HasMany
    {
        return $this->hasMany(Detection::class);
    }

    /** API shape expected by the React dashboard. */
    public function toApiArray(): array
    {
        $status = strtolower((string) $this->status);
        if ($status === 'online') {
            $status = 'live';
        }

        return [
            'id' => $this->camera_code,
            'name' => $this->camera_name,
            'sector' => $this->monitoring_location,
            'location' => $this->monitoring_location,
            'stream_url' => $this->stream_url,
            'protocol' => $this->protocol,
            'transport' => $this->transport,
            'username' => $this->username,
            'status' => $status,
            'detections_per_hour' => null,
            'resolution' => $this->resolution,
            'fps' => $this->fps,
            'detection' => $this->detection_enabled,
            'inGrid' => $this->in_grid,
            'ip_address' => $this->ip_address,
            'last_seen' => $this->last_seen?->toIso8601String(),
        ];
    }
}
