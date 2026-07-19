<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Detection extends Model
{
    use HasUuids;

    protected $fillable = [
        'camera_id',
        'class_label',
        'confidence',
        'count',
        'sector',
        'detected_at',
        'severity',
        'subtitle',
    ];

    protected function casts(): array
    {
        return [
            'confidence' => 'float',
            'count' => 'integer',
            'detected_at' => 'datetime',
        ];
    }

    public function camera(): BelongsTo
    {
        return $this->belongsTo(Camera::class);
    }

    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'camera_id' => $this->camera_id,
            'class' => $this->class_label,
            'confidence' => $this->confidence,
            'count' => $this->count,
            'sector' => $this->sector,
            'detected_at' => $this->detected_at->format('H:i:s'),
            'severity' => $this->severity,
            'subtitle' => $this->subtitle,
        ];
    }
}
