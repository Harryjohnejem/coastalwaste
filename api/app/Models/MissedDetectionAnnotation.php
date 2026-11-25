<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MissedDetectionAnnotation extends Model
{
    protected $table = 'detection_review_annotations';

    protected $fillable = [
        'report_id',
        'status',
        'class_name',
        'class_index',
        'x',
        'y',
        'width',
        'height',
    ];

    protected function casts(): array
    {
        return [
            'class_index' => 'integer',
            'x' => 'float',
            'y' => 'float',
            'width' => 'float',
            'height' => 'float',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (self $annotation) {
            if (! $annotation->status && $annotation->report_id) {
                $annotation->status = MissedDetectionReport::query()
                    ->whereKey($annotation->report_id)
                    ->value('status') ?? MissedDetectionReport::PENDING;
            }
        });
    }

    public function report(): BelongsTo
    {
        return $this->belongsTo(MissedDetectionReport::class, 'report_id');
    }

    /**
     * YOLO line: class_id x_center y_center width height, all 0–1.
     */
    public function toYoloLine(): ?string
    {
        $x = (float) $this->x;
        $y = (float) $this->y;
        $w = (float) $this->width;
        $h = (float) $this->height;
        if ($w <= 0 || $h <= 0 || $x < 0 || $y < 0 || $x + $w > 1.000001 || $y + $h > 1.000001) {
            return null;
        }
        $classes = \App\Support\WasteClassMap::classes();
        if ($this->class_index < 0 || $this->class_index >= count($classes)) {
            return null;
        }
        if ($classes[$this->class_index] !== $this->class_name) {
            return null;
        }

        $cx = $x + ($w / 2);
        $cy = $y + ($h / 2);

        return sprintf(
            '%d %.6f %.6f %.6f %.6f',
            $this->class_index,
            $cx,
            $cy,
            $w,
            $h,
        );
    }
}
