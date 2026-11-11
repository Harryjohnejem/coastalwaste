<?php

namespace App\Support;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionObservation;
use Carbon\Carbon;

/**
 * Cross-camera linking is conservative. Cameras do not have a stored
 * field-of-view map, so a match requires the same class, a recent sighting,
 * a similar hue histogram, and exactly one candidate above the threshold.
 */
class WastePresence
{
    public static function histogramScore(array $left, array $right): float
    {
        if ($left === [] || count($left) !== count($right)) {
            return 0.0;
        }

        $dot = 0.0;
        $leftNorm = 0.0;
        $rightNorm = 0.0;
        foreach ($left as $index => $value) {
            $x = (float) $value;
            $y = (float) $right[$index];
            $dot += $x * $y;
            $leftNorm += $x * $x;
            $rightNorm += $y * $y;
        }

        if ($leftNorm <= 0.0 || $rightNorm <= 0.0) {
            return 0.0;
        }

        return $dot / (sqrt($leftNorm) * sqrt($rightNorm));
    }

    public static function candidateScore(
        string $incomingClass,
        array $incomingHistogram,
        string $candidateClass,
        array $candidateHistogram,
        int $ageSeconds,
        int $windowSeconds,
    ): float {
        if (strcasecmp(trim($incomingClass), trim($candidateClass)) !== 0) {
            return 0.0;
        }
        if ($incomingHistogram === [] || $candidateHistogram === []) {
            return 0.0;
        }
        if ($ageSeconds < 0 || $ageSeconds > $windowSeconds) {
            return 0.0;
        }

        $appearance = self::histogramScore($incomingHistogram, $candidateHistogram);
        $time = 1.0 - ($ageSeconds / max(1, $windowSeconds));

        return (0.8 * $appearance) + (0.2 * $time);
    }

    /**
     * @param  array<int, float>  $scores
     */
    public static function chooseMatch(array $scores, float $threshold): ?int
    {
        $passed = [];
        foreach ($scores as $id => $score) {
            if ((float) $score >= $threshold) {
                $passed[] = (int) $id;
            }
        }

        return count($passed) === 1 ? $passed[0] : null;
    }

    public static function matchThreshold(): float
    {
        return (float) config('services.detector.match_threshold', 0.82);
    }

    public static function matchWindowSeconds(): int
    {
        return max(1, (int) config('services.detector.match_window_seconds', 120));
    }

    /**
     * @param  array<string, mixed>  $row
     */
    public static function findCrossCameraMatch(Camera $camera, array $row): ?Detection
    {
        $histogram = self::numericList($row['histogram'] ?? null);
        $label = trim((string) ($row['class'] ?? ''));
        if ($histogram === [] || $label === '') {
            return null;
        }

        $window = self::matchWindowSeconds();
        $since = now()->subSeconds($window);
        // Dual-lens views of the same physical camera (shared IP) must not be
        // treated as independent devices for cross-camera object linking.
        $sameDeviceIds = [];
        if (filled($camera->ip_address)) {
            $sameDeviceIds = Camera::query()
                ->where('ip_address', $camera->ip_address)
                ->where('id', '!=', $camera->id)
                ->pluck('id')
                ->all();
        }

        $candidates = Detection::query()
            ->with(['logs', 'observations' => function ($query) {
                $query->orderByDesc('observed_at');
            }])
            ->where('camera_id', '!=', $camera->id)
            ->when($sameDeviceIds !== [], function ($query) use ($sameDeviceIds) {
                $query->whereNotIn('camera_id', $sameDeviceIds);
            })
            ->whereNotIn('status', ['Ignored', 'Confirmed Cleaned'])
            ->where(function ($query) use ($since) {
                $query->where('last_seen_at', '>=', $since)
                    ->orWhere('detected_at', '>=', $since);
            })
            ->orderByDesc('last_seen_at')
            ->limit(25)
            ->get();

        $scores = [];
        foreach ($candidates as $candidate) {
            $latest = $candidate->observations->first();
            $candidateLabel = (string) ($latest?->raw_label ?: $candidate->logs->sortByDesc('id')->first()?->raw_label);
            $candidateHistogram = is_array($latest?->histogram) ? $latest->histogram : [];
            $seenAt = $latest?->observed_at ?? $candidate->last_seen_at ?? $candidate->detected_at;
            $age = $seenAt instanceof Carbon ? (int) $seenAt->diffInSeconds(now()) : $window + 1;
            $scores[$candidate->id] = self::candidateScore(
                $label,
                $histogram,
                $candidateLabel,
                self::numericList($candidateHistogram),
                $age,
                $window,
            );
        }

        $matchId = self::chooseMatch($scores, self::matchThreshold());

        return $matchId === null
            ? null
            : $candidates->firstWhere('id', $matchId);
    }

    /**
     * @param  array<string, mixed>  $row
     */
    public static function rememberObservation(
        Detection $detection,
        Camera $camera,
        array $row,
        ?int $trackId,
        ?string $trackerSession,
    ): void {
        $histogram = self::numericList($row['histogram'] ?? null);
        $values = [
            'raw_label' => (string) ($row['class'] ?? 'waste'),
            'confidence' => isset($row['confidence'])
                ? WasteClassifier::confidencePercent((float) $row['confidence'])
                : null,
            'box_left' => $row['left'] ?? null,
            'box_top' => $row['top'] ?? null,
            'box_width' => $row['width'] ?? null,
            'box_height' => $row['height'] ?? null,
            'histogram' => $histogram === [] ? null : $histogram,
            'observed_at' => now(),
        ];

        if ($trackId !== null && $trackerSession) {
            DetectionObservation::query()->updateOrCreate(
                [
                    'camera_id' => $camera->id,
                    'tracker_session' => $trackerSession,
                    'track_id' => $trackId,
                ],
                $values + ['detection_id' => $detection->id],
            );
        } else {
            DetectionObservation::query()->create($values + [
                'detection_id' => $detection->id,
                'camera_id' => $camera->id,
                'track_id' => $trackId,
                'tracker_session' => $trackerSession,
            ]);
        }

        $detection->last_seen_at = now();
        if ($detection->status !== 'Ignored') {
            $detection->status = 'Present';
            $detection->removed_at = null;
            $detection->removal_reason = null;
        }
        $detection->save();
    }

    /**
     * @param  array<string, mixed>  $update
     */
    public static function applyStatus(Camera $camera, array $update): string
    {
        $detection = Detection::query()->find($update['detection_id'] ?? null);
        if (! $detection) {
            return 'missing';
        }

        $status = (string) ($update['status'] ?? '');
        if (! in_array($status, ['Present', 'Confirmed Cleaned'], true)) {
            return 'rejected';
        }

        if ($status === 'Confirmed Cleaned' && $detection->status === 'Confirmed Cleaned') {
            return 'unchanged';
        }

        $lastSeen = isset($update['last_seen_at'])
            ? Carbon::parse($update['last_seen_at'])
            : now();

        if ($status === 'Confirmed Cleaned') {
            $newerElsewhere = DetectionObservation::query()
                ->where('detection_id', $detection->id)
                ->where('camera_id', '!=', $camera->id)
                ->where('observed_at', '>', $lastSeen)
                ->exists();
            if ($newerElsewhere) {
                return 'stale';
            }

            $detection->status = 'Confirmed Cleaned';
            $detection->removed_at = now();
            $detection->removal_reason = $update['reason'] ?? 'inferred_disappearance';
            $detection->save();

            return 'cleaned';
        }

        $detection->status = 'Present';
        $detection->last_seen_at = now();
        $detection->removed_at = null;
        $detection->removal_reason = null;
        $detection->save();

        return 'present';
    }

    /**
     * @return list<float>
     */
    private static function numericList(mixed $value): array
    {
        if (! is_array($value)) {
            return [];
        }

        $numbers = [];
        foreach ($value as $item) {
            if (! is_numeric($item)) {
                return [];
            }
            $numbers[] = (float) $item;
        }

        return $numbers;
    }
}
