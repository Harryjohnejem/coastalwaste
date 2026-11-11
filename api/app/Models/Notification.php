<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Notification extends Model
{
    protected $fillable = [
        'user_id',
        'detection_id',
        'title',
        'message',
        'type',
        'is_read',
    ];

    protected function casts(): array
    {
        return [
            'is_read' => 'boolean',
        ];
    }

    /** belongsTo User. */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** belongsTo Detection when this alert came from a saved waste record. */
    public function detection(): BelongsTo
    {
        return $this->belongsTo(Detection::class);
    }
}
