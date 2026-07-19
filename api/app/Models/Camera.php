<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Camera extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id',
        'name',
        'sector',
        'stream_url',
        'protocol',
        'transport',
        'username',
        'password',
        'status',
        'detections_per_hour',
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
            'detections_per_hour' => 'integer',
            'detection_enabled' => 'boolean',
            'in_grid' => 'boolean',
        ];
    }

    public function detections(): HasMany
    {
        return $this->hasMany(Detection::class);
    }

    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'sector' => $this->sector,
            'stream_url' => $this->stream_url,
            'protocol' => $this->protocol,
            'transport' => $this->transport,
            'username' => $this->username,
            'status' => $this->status,
            'detections_per_hour' => $this->detections_per_hour,
            'resolution' => $this->resolution,
            'fps' => $this->fps,
            'detection' => $this->detection_enabled,
            'inGrid' => $this->in_grid,
        ];
    }
}
