<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Detection;
use App\Models\Report;
use App\Support\DashboardCache;
use App\Support\DatasetClasses;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

class StatsController extends Controller
{
    public function today(): JsonResponse
    {
        $payload = Cache::remember(DashboardCache::statsKey(), DashboardCache::TTL_SECONDS, function () {
            $todayStart = Carbon::today();
            $tomorrow = $todayStart->copy()->addDay();
            $yesterdayStart = $todayStart->copy()->subDay();
            $monthStart = $todayStart->copy()->startOfMonth();
            $today = $todayStart->toDateTimeString();
            $tomorrowAt = $tomorrow->toDateTimeString();
            $yesterdayAt = $yesterdayStart->toDateTimeString();
            $monthAt = $monthStart->toDateTimeString();

            $row = Detection::query()->notMovedToReview()
                ->selectRaw("
                    SUM(CASE WHEN status != 'Ignored' AND detected_at >= ? AND detected_at < ? THEN 1 ELSE 0 END) as today_count,
                    SUM(CASE WHEN status != 'Ignored' AND detected_at >= ? AND detected_at < ? THEN 1 ELSE 0 END) as yesterday_count,
                    SUM(CASE WHEN status != 'Ignored' AND detected_at >= ? THEN 1 ELSE 0 END) as month_count,
                    SUM(CASE WHEN status != 'Ignored' THEN 1 ELSE 0 END) as total_count,
                    SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as present_count,
                    SUM(CASE WHEN status = 'Confirmed Cleaned' THEN 1 ELSE 0 END) as cleaned_count,
                    SUM(CASE WHEN status = 'Confirmed Cleaned' AND removed_at >= ? AND removed_at < ? THEN 1 ELSE 0 END) as cleaned_today,
                    MAX(CASE WHEN status = 'Confirmed Cleaned' THEN removed_at END) as last_removed
                ", [$today, $tomorrowAt, $yesterdayAt, $today, $monthAt, $today, $tomorrowAt])
                ->first();

            $todayCount = (int) ($row->today_count ?? 0);
            $yesterdayCount = (int) ($row->yesterday_count ?? 0);
            $detectionDelta = $this->percentDelta($todayCount, $yesterdayCount);
            $debrisKg = round($todayCount * 0.22, 1);

            $flaggedLocations = Detection::query()->notMovedToReview()
                ->where('detected_at', '>=', $todayStart)
                ->where('detected_at', '<', $tomorrow)
                ->whereNotNull('location')
                ->distinct()
                ->pluck('location')
                ->filter()
                ->values();

            $hotspotLabels = $flaggedLocations->isNotEmpty()
                ? $flaggedLocations->join(', ').' flagged'
                : 'None flagged';

            return [
                'detections' => $todayCount,
                'month_detections' => (int) ($row->month_count ?? 0),
                'total_detections' => (int) ($row->total_count ?? 0),
                'present' => (int) ($row->present_count ?? 0),
                'confirmed_cleaned' => (int) ($row->cleaned_count ?? 0),
                'confirmed_cleaned_today' => (int) ($row->cleaned_today ?? 0),
                'last_removed_at' => $row->last_removed
                    ? Carbon::parse($row->last_removed)->format('Y-m-d H:i:s')
                    : null,
                'debris_kg' => $debrisKg,
                'hotspots' => [
                    'flagged' => $flaggedLocations->count(),
                    'total' => 6,
                    'labels' => $hotspotLabels,
                ],
                'reports_filed' => Report::query()->count(),
                'deltas' => [
                    'detections' => [
                        'direction' => $detectionDelta >= 0 ? 'up' : 'down',
                        'text' => ($detectionDelta >= 0 ? '▲ ' : '▼ ').abs($detectionDelta).'% vs yesterday',
                    ],
                    'debris_kg' => [
                        'direction' => 'up',
                        'text' => '▲ '.round($debrisKg * 0.13, 1).' kg since 06:00',
                    ],
                    'hotspots' => [
                        'direction' => 'neutral',
                        'text' => $hotspotLabels,
                    ],
                    'reports_filed' => [
                        'direction' => 'down',
                        'text' => 'All acknowledged',
                    ],
                ],
            ];
        });

        return response()->json($payload);
    }

    public function composition(Request $request): JsonResponse
    {
        $range = (string) $request->query('range', '24h');
        $payload = Cache::remember(DashboardCache::compositionKey($range), DashboardCache::TTL_SECONDS, function () use ($range) {
            $since = match ($range) {
                '24h' => Carbon::now()->subDay(),
                '7d' => Carbon::now()->subDays(7),
                '30d' => Carbon::now()->subDays(30),
                'all' => Carbon::createFromTimestamp(0),
                default => Carbon::now()->subDay(),
            };

            $rows = Detection::query()->notMovedToReview()
                ->join('waste_classifications', 'waste_classifications.id', '=', 'detections.classification_id')
                ->where('detections.detected_at', '>=', $since)
                ->where('detections.status', '!=', 'Ignored')
                ->groupBy('waste_classifications.waste_type')
                ->select('waste_classifications.waste_type', DB::raw('COUNT(*) as aggregate'))
                ->pluck('aggregate', 'waste_type');

            $classCounts = array_fill_keys(DatasetClasses::NAMES, 0);
            foreach ($rows as $label => $count) {
                $matched = DatasetClasses::match((string) $label);
                if ($matched === null) {
                    continue;
                }
                $classCounts[$matched] += (int) $count;
            }

            $categoryCounts = array_fill_keys(DatasetClasses::CATEGORIES, 0);
            foreach ($classCounts as $name => $count) {
                $category = DatasetClasses::categoryOf($name);
                if ($category !== null) {
                    $categoryCounts[$category] += $count;
                }
            }

            $total = array_sum($categoryCounts);

            return collect(DatasetClasses::CATEGORIES)->map(function (string $category) use ($categoryCounts, $classCounts, $total) {
                $classifications = [];
                foreach (DatasetClasses::NAMES as $name) {
                    if (DatasetClasses::categoryOf($name) !== $category) {
                        continue;
                    }
                    $classifications[] = [
                        'label' => $name,
                        'count' => $classCounts[$name],
                    ];
                }

                $count = $categoryCounts[$category];

                return [
                    'label' => $category,
                    'percent' => $total > 0 ? (int) round(($count / $total) * 100) : 0,
                    'count' => $count,
                    'classifications' => $classifications,
                ];
            })->values()->all();
        });

        return response()->json($payload);
    }

    public function trends(): JsonResponse
    {
        $payload = Cache::remember(DashboardCache::trendsKey(), DashboardCache::TTL_SECONDS, function () {
            $today = Carbon::today()->endOfDay();
            $from = Carbon::today()->startOfMonth()->subMonths(5);
            $counts = Detection::query()->notMovedToReview()
                ->where('status', '!=', 'Ignored')
                ->where('detected_at', '>=', $from)
                ->selectRaw('DATE(detected_at) as day, COUNT(*) as c')
                ->groupByRaw('DATE(detected_at)')
                ->pluck('c', 'day');

            $valueOn = function (Carbon $from, Carbon $to) use ($counts): int {
                $total = 0;
                for ($cursor = $from->copy()->startOfDay(); $cursor->lte($to); $cursor->addDay()) {
                    $total += (int) ($counts[$cursor->toDateString()] ?? 0);
                }

                return $total;
            };

            $daily = [];
            for ($i = 6; $i >= 0; $i--) {
                $day = Carbon::today()->subDays($i);
                $daily[] = [
                    'label' => $day->format('D'),
                    'value' => $valueOn($day->copy()->startOfDay(), $day->copy()->endOfDay()),
                ];
            }

            $weekly = [];
            for ($i = 3; $i >= 0; $i--) {
                $start = Carbon::today()->startOfWeek(Carbon::MONDAY)->subWeeks($i);
                $end = $start->copy()->endOfWeek(Carbon::SUNDAY);
                if ($end->gt($today)) {
                    $end = $today->copy();
                }
                $weekly[] = [
                    'label' => 'W'.(4 - $i),
                    'value' => $valueOn($start, $end),
                ];
            }

            $monthly = [];
            for ($i = 5; $i >= 0; $i--) {
                $month = Carbon::today()->startOfMonth()->subMonths($i);
                $start = $month->copy()->startOfMonth();
                $end = $month->copy()->endOfMonth();
                if ($end->gt($today)) {
                    $end = $today->copy();
                }
                $monthly[] = [
                    'label' => $month->format('M'),
                    'value' => $valueOn($start, $end),
                ];
            }

            return [
                'daily' => $daily,
                'weekly' => $weekly,
                'monthly' => $monthly,
            ];
        });

        return response()->json($payload);
    }

    public function trends(): JsonResponse
    {
        $today = Carbon::today()->endOfDay();

        $daily = [];
        for ($i = 6; $i >= 0; $i--) {
            $day = Carbon::today()->subDays($i);
            $daily[] = [
                'label' => $day->format('D'),
                'value' => $this->countBetween($day->copy()->startOfDay(), $day->copy()->endOfDay()),
            ];
        }

        $weekly = [];
        for ($i = 3; $i >= 0; $i--) {
            $start = Carbon::today()->startOfWeek(Carbon::MONDAY)->subWeeks($i);
            $end = $start->copy()->endOfWeek(Carbon::SUNDAY);
            if ($end->gt($today)) {
                $end = $today->copy();
            }
            $weekly[] = [
                'label' => 'W'.(4 - $i),
                'value' => $this->countBetween($start, $end),
            ];
        }

        $monthly = [];
        for ($i = 5; $i >= 0; $i--) {
            $month = Carbon::today()->startOfMonth()->subMonths($i);
            $start = $month->copy()->startOfMonth();
            $end = $month->copy()->endOfMonth();
            if ($end->gt($today)) {
                $end = $today->copy();
            }
            $monthly[] = [
                'label' => $month->format('M'),
                'value' => $this->countBetween($start, $end),
            ];
        }

        return response()->json([
            'daily' => $daily,
            'weekly' => $weekly,
            'monthly' => $monthly,
        ]);
    }

    private function countBetween(Carbon $from, Carbon $to): int
    {
        return (int) Detection::query()
            ->where('detected_at', '>=', $from)
            ->where('detected_at', '<=', $to)
            ->sum('quantity');
    }

    private function percentDelta(int $current, int $previous): int
    {
        if ($previous === 0) {
            return $current > 0 ? 100 : 0;
        }

        return (int) round((($current - $previous) / $previous) * 100);
    }
}
