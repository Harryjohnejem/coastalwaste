<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DetectionLog extends Model
{
    public $timestamps = false;

    const CREATED_AT = 'created_at';

    const UPDATED_AT = null;

    protected $fillable = [
        'detection_id',
        'frame_number',
        'model_name',
        'model_version',
        'raw_label',
        'confidence',
        'processing_time_ms',
        'created_at',
    ];

    protected function casts(): array
    {
        return [
            'confidence' => 'float',
            'frame_number' => 'integer',
            'processing_time_ms' => 'integer',
            'created_at' => 'datetime',
        ];
    }

    /** belongsTo Detection. */
    public function detection(): BelongsTo
    {
        return $this->belongsTo(Detection::class);
    }
}
