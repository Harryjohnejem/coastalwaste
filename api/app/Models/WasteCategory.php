<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class WasteCategory extends Model
{
    protected $fillable = [
        'category_name',
        'description',
    ];

    /** WasteCategory hasMany WasteClassifications. */
    public function classifications(): HasMany
    {
        return $this->hasMany(WasteClassification::class, 'category_id');
    }

    public function quotas(): HasMany
    {
        return $this->hasMany(WasteQuota::class, 'category_id');
    }
}
