<?php

namespace App\Http\Controllers\Api;

use App\Support\WasteLoad;
use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\TrainingJob;
use App\Support\DatasetClasses;
use App\Support\LiveModel;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/**
 * "Today's report" page: every number comes from today's Waste Detections,
 * compared with yesterday. Counting happens in PHP so MySQL and SQLite agree.
 */
class TodayReportController extends Controller
{
    /** Waste still on the beach this long is listed under "needs attention". */
    private const LONG_PRESENT_MINUTES = 60;

    public function show(\Illuminate\Http\Request $request): JsonResponse
    {
        if (strcasecmp((string) $request->user()?->role, 'Admin') !== 0) {
            return response()->json(['message' => "Only an administrator can view today's report."], 403);
        }
        // Waste no longer seen (or detection off) becomes "No Longer Visible" before counting.
        \App\Support\WastePresence::sweepStale();
        // Short cache: the page asks every few seconds, many viewers share one build.
        $payload = Cache::remember('report:today:v1', 2, fn () => $this->build());

        return response()->json($payload);
    }

    private function build(): array
    {
        $now = Carbon::now();
        $todayStart = Carbon::today();
        $yesterdayStart = $todayStart->copy()->subDay();
        $hoursSoFar = (int) $now->format('G') + 1;

        $rows = Detection::query()
            ->notMovedToReview()
            ->where('status', '!=', 'Ignored')
            ->where('detected_at', '>=', $yesterdayStart)
            ->with(['classification:id,waste_type', 'camera:id,camera_code,camera_name'])
            ->get(['id', 'camera_id', 'classification_id', 'confidence', 'status', 'detected_at', 'removed_at']);

        $today = $rows->filter(fn (Detection $d) => $d->detected_at && $d->detected_at->gte($todayStart));
        // Yesterday up to the same time of day, so the comparison is fair.
        $sameTimeYesterday = $now->copy()->subDay();
        $yesterday = $rows->filter(fn (Detection $d) => $d->detected_at
            && $d->detected_at->lt($todayStart)
            && $d->detected_at->lte($sameTimeYesterday));

        $hours = array_fill(0, $hoursSoFar, ['present' => 0, 'cleaned' => 0]);
        $hourlyCount = array_fill(0, $hoursSoFar, 0);
        $hourlyCleaned = array_fill(0, $hoursSoFar, 0);
        $hourlyConfidence = array_fill(0, $hoursSoFar, []);
        $classes = [];
        $cameras = [];
        foreach ($today as $d) {
            $hour = min($hoursSoFar - 1, (int) $d->detected_at->format('G'));
            // Left the camera view or verified clean (both are off the beach view).
            $cleaned = in_array($d->status, [Detection::NOT_VISIBLE, Detection::VERIFIED], true);
            $hours[$hour][$cleaned ? 'cleaned' : 'present']++;
            $hourlyCount[$hour]++;
            $hourlyConfidence[$hour][] = $this->percent($d->confidence);
            if ($cleaned && $d->removed_at && $d->removed_at->gte($todayStart)) {
                $hourlyCleaned[min($hoursSoFar - 1, (int) $d->removed_at->format('G'))]++;
            }
            $name = DatasetClasses::match((string) $d->classification?->waste_type) ?: ($d->classification?->waste_type ?: 'Unknown');
            $classes[$name] = ($classes[$name] ?? 0) + 1;
            $code = $d->camera?->camera_code ?: 'Unknown';
            $cameras[$code] ??= ['code' => $code, 'name' => $d->camera?->camera_name, 'count' => 0];
            $cameras[$code]['count']++;
        }
        arsort($classes);

        $todayCount = $today->count();
        $yesterdayCount = $yesterday->count();
        $cleanedToday = Detection::query()->notMovedToReview()
            ->where('status', Detection::NOT_VISIBLE)
            ->where('removed_at', '>=', $todayStart)
            ->count();
        $verifiedToday = Detection::query()->notMovedToReview()
            ->where('status', Detection::VERIFIED)
            ->where('cleaning_verified_at', '>=', $todayStart)
            ->count();
        $cleanedYesterday = Detection::query()->notMovedToReview()
            ->where('status', Detection::NOT_VISIBLE)
            ->where('removed_at', '>=', $yesterdayStart)
            ->where('removed_at', '<=', $sameTimeYesterday)
            ->count();
        $presentNow = Detection::query()->notMovedToReview()->where('status', 'Present')->count();
        $longPresent = Detection::query()->notMovedToReview()
            ->where('status', 'Present')
            ->where('detected_at', '<=', $now->copy()->subMinutes(self::LONG_PRESENT_MINUTES))
            ->count();
        $avgToday = $todayCount ? round($today->avg(fn (Detection $d) => $this->percent($d->confidence)), 1) : null;
        $avgYesterday = $yesterdayCount ? round($yesterday->avg(fn (Detection $d) => $this->percent($d->confidence)), 1) : null;
        $pendingReviews = MissedDetectionReport::query()->where('status', MissedDetectionReport::PENDING)->count();
        $reviewsToday = MissedDetectionReport::query()->where('created_at', '>=', $todayStart)->count();

        $hourLabels = [];
        for ($h = 0; $h < $hoursSoFar; $h++) {
            $hourLabels[] = Carbon::createFromTime($h)->format('g A');
        }

        $live = LiveModel::current();
        $jobs = TrainingJob::query()->latest('id')->take(3)->get()->map(fn (TrainingJob $job) => [
            'id' => $job->id,
            'status' => $job->status,
            'status_label' => TrainingJob::label((string) $job->status),
            'dataset' => $job->hosted_model_id
                ? LiveModel::datasetFromHostedModel($job->hosted_model_id, (int) $job->dataset_version)
                : null,
            'when' => ($job->deployed_at ?? $job->completed_at ?? $job->created_at)?->toIso8601String(),
        ])->all();

        $allCameras = Camera::query()->orderBy('camera_code')->get(['id', 'camera_code', 'camera_name', 'status']);
        // Waste on camera right now = records still Present, the same rows the
        // Live Monitoring "Active" count shows. Present is kept current by
        // WastePresence::sweepStale(), so this follows the live cameras.
        $presentByCamera = [];
        Detection::query()->notMovedToReview()->where('status', 'Present')
            ->with(['classification:id,waste_type', 'camera:id,camera_code'])
            ->get(['id', 'camera_id', 'classification_id'])
            ->each(function (Detection $d) use (&$presentByCamera) {
                $code = (string) $d->camera?->camera_code;
                $name = (string) ($d->classification?->waste_type ?: 'Unknown');
                $presentByCamera[$code][$name] = ($presentByCamera[$code][$name] ?? 0) + 1;
            });
        $liveClasses = [];
        // "Where it was found" is real time: the waste each camera shows right now
        // (the same count as the cleanup alert). Offline stream or detection off = 0.
        $load = WasteLoad::status();
        $loadByCode = collect($load['cameras'] ?? [])->keyBy('code');
        $detection = \App\Models\SystemSetting::getDefault()['detection'] ?? [];
        $detectionOn = is_array($detection) && filter_var($detection['enabled'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $cameraRows = $allCameras->map(function (Camera $c) use ($cameras, $now, $presentByCamera, $loadByCode, $detectionOn, &$liveClasses) {
            $live = $this->liveOverlay($c->camera_code, $now);
            $live['classes'] = $presentByCamera[$c->camera_code] ?? [];
            $live['count'] = array_sum($live['classes']);
            foreach ($live['classes'] as $name => $count) {
                $liveClasses[$name] = ($liveClasses[$name] ?? 0) + $count;
            }

            return [
                'code' => $c->camera_code,
                'name' => $c->camera_name,
                'online' => strcasecmp((string) $c->status, 'Online') === 0,
                'count' => ($live['streaming'] && $detectionOn) ? (int) ($loadByCode[$c->camera_code]['count'] ?? 0) : 0,
                'today' => $cameras[$c->camera_code]['count'] ?? 0,
                'detection_on' => $detectionOn,
                'streaming' => $live['streaming'],
                'on_camera' => $live['count'],
            ];
        })->values()->all();
        arsort($liveClasses);

        return [
            'generated_at' => $now->toIso8601String(),
            'live_model' => $live,
            'cameras_online' => collect($cameraRows)->where('streaming', true)->count(),
            'live_now' => [
                'count' => array_sum($liveClasses),
                'classes' => collect($liveClasses)->map(fn (int $count, string $name) => ['name' => $name, 'count' => $count])->values()->all(),
            ],
            'cameras_total' => count($cameraRows),
            'kpis' => [
                'detections' => $this->kpi($todayCount, $yesterdayCount, $hourlyCount),
                // "cleaned" = No Longer Visible (inferred, not cleaning). Verified cleaning is apart.
                'cleaned' => $this->kpi($cleanedToday, $cleanedYesterday, $hourlyCleaned),
                'verified' => ['value' => $verifiedToday],
                'avg_confidence' => [
                    'value' => $avgToday,
                    'previous' => $avgYesterday,
                    'delta' => $avgToday !== null && $avgYesterday !== null ? round($avgToday - $avgYesterday, 1) : null,
                    'spark' => array_map(fn (array $v) => $v ? round(array_sum($v) / count($v), 1) : 0, $hourlyConfidence),
                ],
                'present' => [
                    'value' => $presentNow,
                    'long_present' => $longPresent,
                    'spark' => array_map(fn (array $h) => $h['present'], $hours),
                ],
            ],
            'hourly' => array_map(
                fn (int $h) => ['label' => $hourLabels[$h], 'present' => $hours[$h]['present'], 'cleaned' => $hours[$h]['cleaned']],
                range(0, $hoursSoFar - 1),
            ),
            'classes' => collect($classes)->map(fn (int $count, string $name) => ['name' => $name, 'count' => $count])->values()->all(),
            'cameras' => $cameraRows,
            'attention' => [
                'long_present' => $longPresent,
                'long_present_minutes' => self::LONG_PRESENT_MINUTES,
                'pending_reviews' => $pendingReviews,
                'reviews_today' => $reviewsToday,
            ],
            'training_jobs' => $jobs,
            'waste_load' => $load,
        ];
    }

    /**
     * The live stream's latest boxes for one camera, as published by the detector.
     * Only boxes at 80% or higher count, the same ones Live Monitoring labels.
     *
     * @return array{streaming: bool, count: int, classes: array<string, int>}
     */
    private function liveOverlay(string $code, Carbon $now): array
    {
        $overlay = Cache::get('live_overlay:'.$code);
        if (! is_array($overlay) || ! empty($overlay['paused'])) {
            return ['streaming' => false, 'count' => 0, 'classes' => []];
        }
        $updated = isset($overlay['updated_at']) ? Carbon::parse((string) $overlay['updated_at']) : null;
        $streaming = $updated !== null && $updated->diffInSeconds($now, true) <= 30;
        if (! $streaming) {
            return ['streaming' => false, 'count' => 0, 'classes' => []];
        }
        $classes = [];
        foreach ((array) ($overlay['boxes'] ?? []) as $box) {
            if (! is_array($box)) {
                continue;
            }
            $confidence = $this->percent($box['confidence'] ?? 0);
            if ($confidence < 80) {
                continue;
            }
            $name = DatasetClasses::match((string) ($box['class'] ?? '')) ?: (string) ($box['class'] ?? 'Unknown');
            $classes[$name] = ($classes[$name] ?? 0) + 1;
        }

        return ['streaming' => true, 'count' => array_sum($classes), 'classes' => $classes];
    }

    /** @param list<int> $spark */
    private function kpi(int $value, int $previous, array $spark): array
    {
        $delta = $previous > 0 ? (int) round(($value - $previous) / $previous * 100) : null;

        return ['value' => $value, 'previous' => $previous, 'delta_percent' => $delta, 'spark' => array_values($spark)];
    }

    private function percent(mixed $confidence): float
    {
        $value = (float) $confidence;

        return $value <= 1 ? $value * 100 : $value;
    }
}
