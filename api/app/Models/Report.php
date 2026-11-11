<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Report extends Model
{
    protected $fillable = [
        'report_number',
        'report_type',
        'generated_by',
        'monitoring_period',
        'average_confidence',
        'generated_at',
        'remarks',
        'recommendations',
    ];

    protected function casts(): array
    {
        return [
            'average_confidence' => 'float',
            'generated_at' => 'datetime',
        ];
    }

    /** belongsTo User (generated_by). */
    public function generator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'generated_by');
    }

    /** Alias for generator(). */
    public function user(): BelongsTo
    {
        return $this->generator();
    }
}
