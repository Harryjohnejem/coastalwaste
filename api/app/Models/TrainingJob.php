<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class TrainingJob extends Model
{
    public const PREPARING = 'preparing';

    public const UPLOADING = 'uploading';

    public const CREATING_VERSION = 'creating_version';

    public const TRAINING = 'training';

    public const COMPLETED = 'completed';

    public const FAILED = 'failed';

    public const AWAITING_EVALUATION = 'awaiting_evaluation';

    public const APPROVED_FOR_DEPLOYMENT = 'approved_for_deployment';

    public const DEPLOYED = 'deployed';

    public const REJECTED = 'rejected';

    public const ACTIVE = [
        self::PREPARING,
        self::UPLOADING,
        self::CREATING_VERSION,
        self::TRAINING,
    ];

    protected $fillable = [
        'started_by',
        'status',
        'workspace',
        'project',
        'dataset_version',
        'model_type',
        'hosted_model_id',
        'training_speed',
        'manifest',
        'preprocessing',
        'augmentation',
        'metrics',
        'error_message',
        'evaluation_notes',
        'previous_model_path',
        'backup_model_path',
        'started_at',
        'completed_at',
        'deployed_at',
    ];

    protected function casts(): array
    {
        return [
            'manifest' => 'array',
            'preprocessing' => 'array',
            'augmentation' => 'array',
            'metrics' => 'array',
            'started_at' => 'datetime',
            'completed_at' => 'datetime',
            'deployed_at' => 'datetime',
        ];
    }

    public function starter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'started_by');
    }

    public function items(): HasMany
    {
        return $this->hasMany(TrainingJobItem::class);
    }

    public function reports(): HasMany
    {
        return $this->hasMany(MissedDetectionReport::class, 'training_job_id');
    }

    public static function label(string $status): string
    {
        return match ($status) {
            self::PREPARING => 'Preparing Dataset',
            self::UPLOADING => 'Uploading Dataset',
            self::CREATING_VERSION => 'Creating Version',
            self::TRAINING => 'Training',
            self::COMPLETED => 'Training Completed',
            self::FAILED => 'Training Failed',
            self::AWAITING_EVALUATION => 'Awaiting Evaluation',
            self::APPROVED_FOR_DEPLOYMENT => 'Approved for Deployment',
            self::DEPLOYED => 'Deployed',
            self::REJECTED => 'Rejected',
            default => $status,
        };
    }

    public function toApiArray(): array
    {
        return [
            'id' => $this->id,
            'status' => $this->status,
            'status_label' => self::label((string) $this->status),
            'workspace' => $this->workspace,
            'project' => $this->project,
            'dataset_version' => $this->dataset_version,
            'model_type' => $this->model_type,
            'hosted_model_id' => $this->hosted_model_id,
            'training_speed' => $this->training_speed,
            'manifest' => $this->manifest,
            'metrics' => $this->metrics,
            'error_message' => $this->error_message,
            'evaluation_notes' => $this->evaluation_notes,
            'backup_model_path' => $this->backup_model_path ? true : false,
            'started_at' => $this->started_at?->toIso8601String(),
            'completed_at' => $this->completed_at?->toIso8601String(),
            'deployed_at' => $this->deployed_at?->toIso8601String(),
            'item_count' => (int) ($this->items_count ?? ($this->relationLoaded('items') ? $this->items->count() : $this->items()->count())),
            'uploaded_count' => (int) ($this->uploaded_items_count ?? ($this->relationLoaded('items')
                ? $this->items->where('upload_status', 'uploaded')->count()
                : $this->items()->where('upload_status', 'uploaded')->count())),
        ];
    }
}
