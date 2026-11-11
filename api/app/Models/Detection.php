<?php

namespace App\Models;

use App\Support\DatasetAttribution;
use App\Support\DatasetClasses;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Detection extends Model
{
    protected $fillable = [
        'camera_id',
        'classification_id',
        'confidence',
        'quantity',
        'location',
        'detected_at',
        'last_seen_at',
        'removed_at',
        'removal_reason',
        'object_key',
        'status',
        'moved_to_review',
        'training_dataset',
        'dataset_attribution',
    ];

    protected function casts(): array
    {
        return [
            'confidence' => 'float',
            'quantity' => 'integer',
            'detected_at' => 'datetime',
            'last_seen_at' => 'datetime',
            'removed_at' => 'datetime',
            'moved_to_review' => 'boolean',
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

    public function latestImage(): HasOne
    {
        return $this->hasOne(DetectionImage::class)->latestOfMany();
    }

    public function latestLog(): HasOne
    {
        return $this->hasOne(DetectionLog::class)->latestOfMany();
    }

    public function observations(): HasMany
    {
        return $this->hasMany(DetectionObservation::class);
    }

    public function latestObservation(): HasOne
    {
        return $this->hasOne(DetectionObservation::class)->latestOfMany();
    }

    /** Review copies created by Move to Review. The detection row itself stays. */
    public function reviewReports(): HasMany
    {
        return $this->hasMany(MissedDetectionReport::class, 'source_detection_id');
    }

    public function scopeNotMovedToReview($query)
    {
        return $query->where('moved_to_review', false);
    }

    /**
     * API shape expected by the React dashboard / detector.
     */
    public function toApiArray(): array
    {
        $this->loadMissing(['camera', 'classification.category', 'latestLog', 'latestImage']);
        $latestLog = $this->latestLog;
        $trackId = $latestLog?->frame_number;
        $datasetClass = DatasetClasses::match($latestLog?->raw_label);
        $parentCategory = DatasetClasses::categoryOf($datasetClass);
        $image = $this->latestImage;

        $confidence = (float) $this->confidence;
        // Store as 0–100; expose 0–1 when value looks like a percent.
        $apiConfidence = $confidence > 1 ? round($confidence / 100, 4) : $confidence;

        $attributionCode = $this->dataset_attribution !== null && $this->dataset_attribution !== ''
            ? DatasetAttribution::normalize($this->dataset_attribution)
            : DatasetAttribution::UNKNOWN;

        return [
            'id' => $this->id,
            'camera_id' => $this->camera?->camera_code,
            // Detection source = which camera/stream captured the frame (not the training subset).
            'detection_source' => $this->camera?->camera_code,
            'class' => $datasetClass ?? $this->classification?->waste_type,
            'waste_category' => $parentCategory ?? $this->classification?->category?->category_name,
            'waste_subtype' => $datasetClass ?? $this->classification?->waste_type,
            'dataset_class' => $datasetClass,
            'parent_category' => $parentCategory,
            'confidence' => $apiConfidence,
            'count' => $this->quantity,
            'sector' => $this->location,
            'location' => $this->location,
            'detected_at' => $this->detected_at?->format('Y-m-d H:i:s'),
            'detected_at_iso' => $this->detected_at?->toIso8601String(),
            'last_seen_at' => $this->last_seen_at?->format('Y-m-d H:i:s'),
            'removed_at' => $this->removed_at?->format('Y-m-d H:i:s'),
            'removal_reason' => $this->removal_reason,
            'object_key' => $this->object_key,
            'status' => $this->status,
            // Model training metadata (Local 1 + Local 2 merged). Null on legacy rows.
            'training_dataset' => $this->training_dataset,
            'training_dataset_label' => $this->training_dataset
                ?: 'Unknown / Not recorded',
            // Per-detection attribution — never inferred from class/confidence alone.
            'dataset_attribution' => $attributionCode,
            'dataset_attribution_label' => DatasetAttribution::label($attributionCode),
            'dataset_attribution_tooltip' => DatasetAttribution::tooltip($attributionCode),
            'severity' => 'alert',
            'subtitle' => $trackId ? 'Track '.$trackId : null,
            'snapshot_url' => $image
                ? '/storage/'.$image->image_path
                : null,
            'snapshot_name' => $image?->image_name,
        ];
    }
}
