<?php

namespace App\Models;

use Carbon\Carbon;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;

class WasteQuota extends Model
{
    protected $fillable = [
        'name',
        'camera_id',
        'category_id',
        'quota_limit',
        'period',
        'cleanup_recommendation',
        'is_active',
    ];

    protected function casts(): array
    {
        return [
            'quota_limit' => 'integer',
            'is_active' => 'boolean',
        ];
    }

    public function camera(): BelongsTo
    {
        return $this->belongsTo(Camera::class);
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(WasteCategory::class, 'category_id');
    }

    /** @return array{0: Carbon, 1: Carbon} */
    public function periodWindow(?Carbon $at = null): array
    {
        $at = ($at ?? now())->timezone('Asia/Manila');

        return match ($this->period) {
            'weekly' => [$at->copy()->startOfWeek(), $at->copy()->endOfWeek()],
            'monthly' => [$at->copy()->startOfMonth(), $at->copy()->endOfMonth()],
            default => [$at->copy()->startOfDay(), $at->copy()->endOfDay()],
        };
    }

    public function periodKey(?Carbon $at = null): string
    {
        $at = ($at ?? now())->timezone('Asia/Manila');

        return match ($this->period) {
            'weekly' => $at->isoFormat('GGGG-[W]WW'),
            'monthly' => $at->format('Y-m'),
            default => $at->toDateString(),
        };
    }

    public function currentCount(?Carbon $at = null): int
    {
        [$from, $to] = $this->periodWindow($at);

        $query = Detection::query()
            ->whereBetween('detected_at', [$from, $to])
            ->where('status', '!=', 'Ignored');

        if ($this->camera_id) {
            $query->where('camera_id', $this->camera_id);
        }

        if ($this->category_id) {
            $query->whereIn(
                'classification_id',
                DB::table('waste_classifications')
                    ->where('category_id', $this->category_id)
                    ->pluck('id'),
            );
        }

        return (int) $query->sum('quantity');
    }

    public function toStatusArray(): array
    {
        $this->loadMissing(['camera', 'category']);

        [$from, $to] = $this->periodWindow();
        $limit = max(1, (int) $this->quota_limit);
        $count = $this->currentCount();
        $percent = (int) min(100, round(($count / $limit) * 100));
        $status = 'within';
        if ($count >= $limit) {
            $status = 'reached';
        } elseif ($percent >= 80) {
            $status = 'approaching';
        }

        return [
            'id' => $this->id,
            'name' => $this->name,
            'camera_id' => $this->camera?->camera_code,
            'camera_name' => $this->camera?->camera_name,
            'category_id' => $this->category_id,
            'category_name' => $this->category?->category_name,
            'quota_limit' => $limit,
            'period' => $this->period,
            'period_key' => $this->periodKey(),
            'period_start' => $from->toIso8601String(),
            'period_end' => $to->toIso8601String(),
            'current_count' => $count,
            'remaining' => max(0, $limit - $count),
            'percent' => $percent,
            'status' => $status,
            'cleanup_recommendation' => $this->cleanup_recommendation,
            'is_active' => $this->is_active,
        ];
    }
}
