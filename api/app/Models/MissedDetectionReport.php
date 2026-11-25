<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class MissedDetectionReport extends Model
{
    public const PENDING = 'pending';

    public const VERIFIED = 'verified';

    public const CORRECTED = 'corrected';

    public const APPROVED = 'approved';

    public const REJECTED = 'rejected';

    public const EXPORTED = 'exported';

    protected $table = 'detection_reviews';

    protected static function booted(): void
    {
        // Each annotation carries its review's status.
        static::saved(function (self $report) {
            if ($report->wasChanged('status') || $report->wasRecentlyCreated) {
                $report->annotations()->update(['status' => $report->status]);
            }
        });
    }

    /**
     * Copy review status onto annotations after a bulk query()->update().
     *
     * @param  iterable<int|string>  $reportIds
     */
    public static function syncAnnotationStatus(iterable $reportIds): void
    {
        $ids = collect($reportIds)->map(fn ($id) => (int) $id)->filter()->values()->all();
        if ($ids === []) {
            return;
        }
        MissedDetectionAnnotation::query()
            ->whereIn('report_id', $ids)
            ->update([
                'status' => \Illuminate\Support\Facades\DB::raw(
                    '(SELECT detection_reviews.status FROM detection_reviews WHERE detection_reviews.id = detection_review_annotations.report_id)'
                ),
            ]);
    }

    protected $fillable = [
        'user_id',
        'camera_id',
        'source_detection_id',
        'description',
        'proposal_label',
        'proposal',
        'original_prediction',
        'original_prediction_confidence',
        'original_model_boxes',
        'corrected_by',
        'corrected_at',
        'approved_by',
        'approved_at',
        'image_path',
        'image_name',
        'status',
        'include_in_export',
        'training_job_id',
        'reviewed_by',
        'reviewed_at',
        'rejection_note',
    ];

    protected function casts(): array
    {
        return [
            'reviewed_at' => 'datetime',
            'proposal' => 'array',
            'original_model_boxes' => 'array',
            'original_prediction_confidence' => 'float',
            'corrected_at' => 'datetime',
            'approved_at' => 'datetime',
            'include_in_export' => 'boolean',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function reviewer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reviewed_by');
    }

    public function camera(): BelongsTo
    {
        return $this->belongsTo(Camera::class);
    }

    public function annotations(): HasMany
    {
        return $this->hasMany(MissedDetectionAnnotation::class, 'report_id');
    }

    public function sourceDetection(): BelongsTo
    {
        return $this->belongsTo(Detection::class, 'source_detection_id');
    }

    public function trainingJob(): BelongsTo
    {
        return $this->belongsTo(TrainingJob::class, 'training_job_id');
    }

    public function toApiArray(): array
    {
        $overlay = $this->modelOverlay();

        return [
            'id' => $this->id,
            'description' => $this->description,
            'status' => $this->status,
            'include_in_export' => (bool) $this->include_in_export,
            'training_job_id' => $this->training_job_id,
            'location' => $this->camera?->monitoring_location,
            'image_url' => '/storage/'.$this->image_path,
            // Small copy for the review table; the modal keeps image_url.
            'thumb_url' => \App\Support\ReviewThumbnail::url($this->image_path),
            'image_name' => $this->image_name,
            'camera_id' => $this->camera?->camera_code,
            'camera_name' => $this->camera?->camera_name,
            'source_detection_id' => $this->source_detection_id,
            'original_prediction' => $this->original_prediction ?: $overlay['prediction'],
            'corrected_by' => $this->corrected_by,
            'corrected_at' => $this->corrected_at?->toIso8601String(),
            'approved_by' => $this->approved_by,
            'approved_at' => $this->approved_at?->toIso8601String(),
            'prediction' => $overlay['prediction'],
            'prediction_confidence' => $overlay['prediction_confidence'],
            'model_boxes' => $overlay['model_boxes'],
            'rejection_note' => $this->rejection_note,
            'created_at' => $this->created_at?->toIso8601String(),
            'reviewed_at' => $this->reviewed_at?->toIso8601String(),
            'annotations' => $this->annotations->map(fn (MissedDetectionAnnotation $box) => [
                'id' => $box->id,
                'class_name' => $box->class_name,
                'class_index' => $box->class_index,
                'x' => (float) $box->x,
                'y' => (float) $box->y,
                'width' => (float) $box->width,
                'height' => (float) $box->height,
            ])->values(),
        ];
    }

    /**
     * Read-only model overlay. Empty when this frame was not linked to a live detection.
     *
     * @return array{prediction: ?string, prediction_confidence: ?float, model_boxes: array<int, array<string, mixed>>}
     */
    public function modelOverlay(): array
    {
        if ($this->original_model_boxes !== null) {
            return [
                'prediction' => $this->original_prediction ?: ($this->original_model_boxes[0]['class_name'] ?? null),
                'prediction_confidence' => $this->original_prediction_confidence !== null
                    ? (float) $this->original_prediction_confidence
                    : null,
                'model_boxes' => $this->original_model_boxes ?? [],
            ];
        }
        $detection = $this->relationLoaded('sourceDetection')
            ? $this->sourceDetection
            : $this->sourceDetection()->with(['classification', 'latestObservation'])->first();

        if (! $detection) {
            $proposal = is_array($this->proposal) ? $this->proposal : null;
            if ($proposal && isset($proposal['width'], $proposal['height'])) {
                $label = (string) ($proposal['label'] ?? $this->proposal_label ?? 'Unfamiliar');
                $reason = (string) ($proposal['reason'] ?? '');
                $confidence = isset($proposal['confidence']) ? (float) $proposal['confidence'] : null;

                return [
                    'prediction' => $label,
                    'prediction_confidence' => $confidence,
                    'model_boxes' => [[
                        'class_name' => $label,
                        'x' => round((float) ($proposal['x'] ?? 0), 6),
                        'y' => round((float) ($proposal['y'] ?? 0), 6),
                        'width' => round((float) $proposal['width'], 6),
                        'height' => round((float) $proposal['height'], 6),
                        'source' => $reason === 'low_confidence' ? 'model' : 'proposal',
                        'confidence' => $confidence,
                    ]],
                ];
            }

            return ['prediction' => null, 'prediction_confidence' => null, 'model_boxes' => []];
        }

        $detection->loadMissing(['classification', 'latestObservation']);
        $observation = $detection->latestObservation;
        $prediction = $observation?->raw_label ?: $detection->classification?->waste_type;
        $boxes = [];
        if ($observation && $observation->box_width !== null && $observation->box_height !== null) {
            $width = (float) $observation->box_width;
            $scale = $width > 1 ? 100 : 1;
            $boxes[] = [
                'class_name' => $prediction,
                'x' => round(((float) $observation->box_left) / $scale, 6),
                'y' => round(((float) $observation->box_top) / $scale, 6),
                'width' => round($width / $scale, 6),
                'height' => round(((float) $observation->box_height) / $scale, 6),
                'source' => 'model',
            ];
        }

        $confidence = $detection->confidence;
        if ($confidence !== null && (float) $confidence > 1) {
            $confidence = round(((float) $confidence) / 100, 4);
        }

        return [
            'prediction' => $prediction ? (string) $prediction : null,
            'prediction_confidence' => $confidence !== null ? (float) $confidence : null,
            'model_boxes' => $boxes,
        ];
    }
}
