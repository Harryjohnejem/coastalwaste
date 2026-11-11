<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Detection extends Model
{
    protected $fillable = [
        'camera_id',
        'classification_id',
        'confidence',
        'quantity',
        'location',
        'detected_at',
        'status',
    ];

    protected function casts(): array
    {
        return [
            'confidence' => 'float',
            'quantity' => 'integer',
            'detected_at' => 'datetime',
        ];
    }

    /** belongsTo Camera. */
    public function camera(): BelongsTo
    {
        return $this->belongsTo(Camera::class);
    }

    /** belongsTo WasteClassification. */
    public function classification(): BelongsTo
    {
        return $this->belongsTo(WasteClassification::class, 'classification_id');
    }

    /** hasMany DetectionImages. */
    public function images(): HasMany
    {
        return $this->hasMany(DetectionImage::class);
    }

    /** hasMany DetectionLogs. */
    public function logs(): HasMany
    {
        return $this->hasMany(DetectionLog::class);
    }

    /** API shape expected by the React dashboard / detector. */
    public function toApiArray(): array
    {
        $this->loadMissing(['camera', 'classification.category']);

        $confidence = (float) $this->confidence;
        // Store as 0–100; expose 0–1 when value looks like a percent.
        $apiConfidence = $confidence > 1 ? round($confidence / 100, 4) : $confidence;

        return [
            'id' => $this->id,
            'camera_id' => $this->camera?->camera_code,
            'class' => $this->classification?->waste_type,
            'waste_category' => $this->classification?->category?->category_name,
            'waste_subtype' => $this->classification?->waste_type,
            'confidence' => $apiConfidence,
            'count' => $this->quantity,
            'sector' => $this->location,
            'location' => $this->location,
            'detected_at' => $this->detected_at?->format('Y-m-d H:i:s'),
            'detected_at_iso' => $this->detected_at?->toIso8601String(),
            'status' => $this->status,
            'severity' => 'alert',
            'subtitle' => null,
        ];
    }
}
