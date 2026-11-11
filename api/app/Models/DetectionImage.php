<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DetectionImage extends Model
{
    protected $fillable = [
        'detection_id',
        'image_path',
        'image_name',
        'captured_at',
    ];

    protected function casts(): array
    {
        return [
            'captured_at' => 'datetime',
        ];
    }

    /** belongsTo Detection. */
    public function detection(): BelongsTo
    {
        return $this->belongsTo(Detection::class);
    }
}
