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
    /*
     * Waste statuses. The cameras can only say whether waste is still seen;
     * only a person can say it was cleaned.
     *   Detected           saved by hand            -> "Waste Detected"
     *   Present            seen by a camera         -> "Waste Detected", then "Still Present"
     *   No Longer Visible  left the camera view     (inferred, NOT cleaning)
     *   Cleaning Verified  checked by an inspector / administrator (who + when stored)
     *   Ignored            hidden
     */
    public const DETECTED = 'Detected';

    public const PRESENT = 'Present';

    public const NOT_VISIBLE = 'No Longer Visible';

    public const VERIFIED = 'Cleaning Verified';

    public const IGNORED = 'Ignored';

    /** Seen again within this many seconds of the first save still counts as just detected. */
    private const JUST_DETECTED_SECONDS = 60;

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
        'cleaning_verified_by',
        'cleaning_verified_at',
        'object_key',
        'status',
        'moved_to_review',
        'auto_reviewed_at',
        'training_dataset',
        'training_model',
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
            'auto_reviewed_at' => 'datetime',
            'cleaning_verified_at' => 'datetime',
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

    /** The person who verified the cleaning. */
    public function verifier(): \Illuminate\Database\Eloquent\Relations\BelongsTo
    {
        return $this->belongsTo(User::class, 'cleaning_verified_by');
    }

    /** Status as shown everywhere (dashboard, records, analytics, reports). */
    public function statusLabel(): string
    {
        return match ($this->status) {
            self::DETECTED => 'Waste Detected',
            self::PRESENT => ($this->last_seen_at && $this->detected_at
                && $this->last_seen_at->diffInSeconds($this->detected_at, true) > self::JUST_DETECTED_SECONDS)
                ? 'Still Present'
                : 'Waste Detected',
            self::NOT_VISIBLE => 'No Longer Visible',
            self::VERIFIED => 'Cleaning Verified',
            self::IGNORED => 'Ignored',
            default => (string) $this->status,
        };
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
            'status_label' => $this->statusLabel(),
            'cleaning_verified_at' => $this->cleaning_verified_at?->format('Y-m-d H:i:s'),
            'cleaning_verified_by' => $this->cleaning_verified_by ? $this->verifier?->name : null,
            // Model training metadata (Local 1 + Local 2 merged). Null on legacy rows.
            'training_dataset' => $this->training_dataset,
            'training_model' => $this->training_model,
            // Live-model rows: top line is "YOLOv11l / Roboflow", second line is the Roboflow folder.
            'training_dataset_label' => $attributionCode === DatasetAttribution::LIVE_MODEL
                ? ($this->training_dataset ?: 'Unknown / Not recorded')
                : ($this->training_dataset ?: 'Unknown / Not recorded'),
            // Per-detection attribution — never inferred from class/confidence alone.
            'dataset_attribution' => $attributionCode,
            'dataset_attribution_label' => $attributionCode === DatasetAttribution::LIVE_MODEL
                ? ($this->training_model ?: \App\Support\LiveModel::DEFAULT_MODEL).' / Roboflow'
                : DatasetAttribution::label($attributionCode),
            'dataset_attribution_tooltip' => $attributionCode === DatasetAttribution::LIVE_MODEL
                ? 'Detected by the live model '.($this->training_model ?: 'YOLO').' trained on '.($this->training_dataset ?: 'the live dataset').'.'
                : DatasetAttribution::tooltip($attributionCode),
            'severity' => 'alert',
            'subtitle' => $trackId ? 'Track '.$trackId : null,
            'snapshot_url' => $image
                ? '/storage/'.$image->image_path
                : null,
            'snapshot_name' => $image?->image_name,
        ];
    }
}
