<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DetectionObservation extends Model
{
    protected $fillable = [
        'detection_id',
        'camera_id',
        'track_id',
        'tracker_session',
        'raw_label',
        'confidence',
        'box_left',
        'box_top',
        'box_width',
        'box_height',
        'histogram',
        'observed_at',
    ];

    protected function casts(): array
    {
        return [
            'track_id' => 'integer',
            'confidence' => 'float',
            'histogram' => 'array',
            'observed_at' => 'datetime',
        ];
    }

    public function detection(): BelongsTo
    {
        return $this->belongsTo(Detection::class);
    }

    public function camera(): BelongsTo
    {
        return $this->belongsTo(Camera::class);
    }
}
