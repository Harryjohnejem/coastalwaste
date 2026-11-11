<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class WasteClassification extends Model
{
    protected $fillable = [
        'category_id',
        'waste_type',
    ];

    /** belongsTo WasteCategory. */
    public function category(): BelongsTo
    {
        return $this->belongsTo(WasteCategory::class, 'category_id');
    }

    /** hasMany Detections. */
    public function detections(): HasMany
    {
        return $this->hasMany(Detection::class, 'classification_id');
    }
}
