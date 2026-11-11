<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Detection;
use App\Models\Report;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

class StatsController extends Controller
{
    public function today(): JsonResponse
    {
        $today = Carbon::today();
        $yesterday = Carbon::yesterday();

        $todayCount = (int) Detection::query()->whereDate('detected_at', $today)->sum('quantity');
        $yesterdayCount = (int) Detection::query()->whereDate('detected_at', $yesterday)->sum('quantity');

        $detectionDelta = $this->percentDelta($todayCount, $yesterdayCount);

        $debrisKg = round($todayCount * 0.22, 1);
        $reportsFiled = Report::query()->count();

        $flaggedLocations = Detection::query()
            ->whereDate('detected_at', $today)
            ->whereNotNull('location')
            ->select('location')
            ->distinct()
            ->pluck('location')
            ->filter()
            ->values();

        $hotspotLabels = $flaggedLocations->isNotEmpty()
            ? $flaggedLocations->join(', ').' flagged'
            : 'None flagged';

        $monthCount = (int) Detection::query()
            ->whereYear('detected_at', $today->year)
            ->whereMonth('detected_at', $today->month)
            ->sum('quantity');
        $totalCount = (int) Detection::query()->sum('quantity');

        return response()->json([
            'detections' => $todayCount,
            'month_detections' => $monthCount,
            'total_detections' => $totalCount,
            'debris_kg' => $debrisKg,
            'hotspots' => [
                'flagged' => $flaggedLocations->count(),
                'total' => 6,
                'labels' => $hotspotLabels,
            ],
            'reports_filed' => $reportsFiled,
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
        ]);
    }

    public function composition(Request $request): JsonResponse
    {
        $range = $request->query('range', '24h');
        $since = match ($range) {
            '24h' => Carbon::now()->subDay(),
            '7d' => Carbon::now()->subDays(7),
            '30d' => Carbon::now()->subDays(30),
            'all' => Carbon::createFromTimestamp(0),
            default => Carbon::now()->subDay(),
        };

        $detections = Detection::query()
            ->with('classification.category')
            ->where('detected_at', '>=', $since)
            ->get();

        $buckets = [
            'Papers' => 0,
            'Plastics' => 0,
            'Metals' => 0,
            'Wood' => 0,
            'Glass' => 0,
        ];

        foreach ($detections as $detection) {
            $categoryName = (string) ($detection->classification?->category?->category_name ?? '');
            $bucket = match (true) {
                str_contains(strtolower($categoryName), 'paper') => 'Papers',
                str_contains(strtolower($categoryName), 'metal') => 'Metals',
                str_contains(strtolower($categoryName), 'wood') => 'Wood',
                str_contains(strtolower($categoryName), 'glass') => 'Glass',
                default => 'Plastics',
            };
            $buckets[$bucket] += max((int) $detection->quantity, 1);
        }

        $total = array_sum($buckets);

        $composition = collect($buckets)->map(function (int $count, string $label) use ($total) {
            return [
                'label' => $label,
                'percent' => $total > 0 ? (int) round(($count / $total) * 100) : 0,
                'count' => $count,
            ];
        })->values();

        return response()->json($composition);
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
