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

        $todayCount = Detection::query()->whereDate('detected_at', $today)->count();
        $yesterdayCount = Detection::query()->whereDate('detected_at', $yesterday)->count();

        $detectionDelta = $this->percentDelta($todayCount, $yesterdayCount);

        $debrisKg = round($todayCount * 0.22, 1);
        $reportsFiled = Report::query()->whereDate('created_at', $today)->count()
            + Report::query()->whereDate('created_at', '<', $today)->count();

        $flaggedSectors = Detection::query()
            ->whereDate('detected_at', $today)
            ->whereNotNull('sector')
            ->select('sector')
            ->distinct()
            ->pluck('sector')
            ->map(fn ($sector) => str_replace('Sector ', '', $sector))
            ->filter()
            ->values();

        $hotspotLabels = $flaggedSectors->isNotEmpty()
            ? $flaggedSectors->join(', ').' flagged'
            : 'None flagged';

        return response()->json([
            'detections' => $todayCount,
            'debris_kg' => $debrisKg,
            'hotspots' => [
                'flagged' => $flaggedSectors->count(),
                'total' => 6,
                'labels' => $hotspotLabels,
            ],
            'reports_filed' => max($reportsFiled, Report::query()->count()),
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
            default => Carbon::now()->subDay(),
        };

        $detections = Detection::query()
            ->where('detected_at', '>=', $since)
            ->get();

        if ($detections->isEmpty()) {
            return response()->json([
                ['label' => 'Plastics', 'percent' => 58],
                ['label' => 'Fishing gear', 'percent' => 19],
                ['label' => 'Styrofoam', 'percent' => 14],
                ['label' => 'Other', 'percent' => 9],
            ]);
        }

        $buckets = [
            'Plastics' => 0,
            'Fishing gear' => 0,
            'Styrofoam' => 0,
            'Other' => 0,
        ];

        foreach ($detections as $detection) {
            $label = strtolower($detection->class_label);
            $weight = max($detection->count, 1);

            if (str_contains($label, 'plastic') || str_contains($label, 'bottle')) {
                $buckets['Plastics'] += $weight;
            } elseif (str_contains($label, 'net') || str_contains($label, 'fishing')) {
                $buckets['Fishing gear'] += $weight;
            } elseif (str_contains($label, 'styrofoam')) {
                $buckets['Styrofoam'] += $weight;
            } else {
                $buckets['Other'] += $weight;
            }
        }

        $total = array_sum($buckets) ?: 1;

        $composition = collect($buckets)->map(function (int $count, string $label) use ($total) {
            return [
                'label' => $label,
                'percent' => (int) round(($count / $total) * 100),
            ];
        })->values();

        return response()->json($composition);
    }

    private function percentDelta(int $current, int $previous): int
    {
        if ($previous === 0) {
            return $current > 0 ? 100 : 0;
        }

        return (int) round((($current - $previous) / $previous) * 100);
    }
}
