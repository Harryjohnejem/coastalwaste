<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TrainingJobItem extends Model
{
    protected $fillable = [
        'training_job_id',
        'report_id',
        'annotation_id',
        'class_name',
        'image_hash',
        'split',
        'inclusion_status',
        'validation_status',
        'filename',
        'roboflow_image_id',
        'upload_status',
        'upload_error',
    ];

    public function job(): BelongsTo
    {
        return $this->belongsTo(TrainingJob::class, 'training_job_id');
    }

    public function report(): BelongsTo
    {
        return $this->belongsTo(MissedDetectionReport::class, 'report_id');
    }

    public function annotation(): BelongsTo
    {
        return $this->belongsTo(MissedDetectionAnnotation::class, 'annotation_id');
    }

    public function trainingJob(): BelongsTo
    {
        return $this->belongsTo(TrainingJob::class, 'training_job_id');
    }
}
