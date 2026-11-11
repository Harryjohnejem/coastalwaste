<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MissedDetectionAnnotation extends Model
{
    protected $fillable = [
        'report_id',
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
        if ($this->class_index < 0 || $this->class_index >= count(\App\Support\WasteClassMap::CLASSES)) {
            return null;
        }
        if (\App\Support\WasteClassMap::CLASSES[$this->class_index] !== $this->class_name) {
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
