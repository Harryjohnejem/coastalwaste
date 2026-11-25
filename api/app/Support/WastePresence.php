<?php

namespace App\Support;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionObservation;
use App\Models\SystemSetting;
use Carbon\Carbon;
use Illuminate\Support\Facades\Cache;

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
            ->whereNotIn('status', [Detection::IGNORED, Detection::NOT_VISIBLE, Detection::VERIFIED])
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
     * Same camera, same object, new ByteTrack id. Do not insert a second row.
     *
     * @param  array<string, mixed>  $row
     */
    public static function findSameCameraOverlap(Camera $camera, array $row): ?Detection
    {
        $incoming = self::boxFromRow($row);
        if ($incoming === null) {
            return null;
        }
        $incomingClass = DatasetClasses::match((string) ($row['class'] ?? '')) ?: trim((string) ($row['class'] ?? ''));
        $since = now()->subMinutes(8);
        $candidates = Detection::query()
            ->with(['observations' => function ($query) {
                $query->orderByDesc('observed_at');
            }, 'logs', 'classification'])
            ->where('camera_id', $camera->id)
            ->whereNotIn('status', [Detection::IGNORED, Detection::NOT_VISIBLE, Detection::VERIFIED])
            ->where(function ($query) use ($since) {
                $query->where('last_seen_at', '>=', $since)
                    ->orWhere('detected_at', '>=', $since);
            })
            ->orderByDesc('last_seen_at')
            ->limit(40)
            ->get();

        foreach ($candidates as $candidate) {
            $latest = $candidate->observations->first();
            $other = self::boxFromObservation($latest);
            if ($other === null) {
                continue;
            }
            $otherClass = DatasetClasses::match((string) ($latest?->raw_label ?: $candidate->logs->sortByDesc('id')->first()?->raw_label ?: ''))
                ?: (string) $candidate->classification?->waste_type;
            if (self::samePhysicalObject($incoming, $other, $incomingClass, $otherClass)) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * @param  array<string, float>  $left
     * @param  array<string, float>  $right
     */
    public static function samePhysicalObject(array $left, array $right, string $classA, string $classB): bool
    {
        $iou = self::boxIou($left, $right);
        if ($iou >= 0.28) {
            return true;
        }
        $related = self::classFamily($classA) !== '' && self::classFamily($classA) === self::classFamily($classB);
        if ($related && $iou >= 0.14) {
            return true;
        }
        $dist = self::centerDistance($left, $right);
        if ($related && $dist <= 12.0 && $iou >= 0.06) {
            return true;
        }

        return $dist <= 8.0 && $iou >= 0.10;
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array{left: float, top: float, width: float, height: float}|null
     */
    public static function boxFromRow(array $row): ?array
    {
        if (! isset($row['left'], $row['top'], $row['width'], $row['height'])) {
            return null;
        }
        $box = [
            'left' => (float) $row['left'],
            'top' => (float) $row['top'],
            'width' => (float) $row['width'],
            'height' => (float) $row['height'],
        ];

        return $box['width'] > 0 && $box['height'] > 0 ? $box : null;
    }

    /**
     * @return array{left: float, top: float, width: float, height: float}|null
     */
    public static function boxFromObservation(?DetectionObservation $observation): ?array
    {
        if ($observation === null) {
            return null;
        }

        return self::boxFromRow([
            'left' => $observation->box_left,
            'top' => $observation->box_top,
            'width' => $observation->box_width,
            'height' => $observation->box_height,
        ]);
    }

    /**
     * @param  array{left: float, top: float, width: float, height: float}  $left
     * @param  array{left: float, top: float, width: float, height: float}  $right
     */
    public static function boxIou(array $left, array $right): float
    {
        $ax2 = $left['left'] + $left['width'];
        $ay2 = $left['top'] + $left['height'];
        $bx2 = $right['left'] + $right['width'];
        $by2 = $right['top'] + $right['height'];
        $ix = max(0.0, min($ax2, $bx2) - max($left['left'], $right['left']));
        $iy = max(0.0, min($ay2, $by2) - max($left['top'], $right['top']));
        $inter = $ix * $iy;
        if ($inter <= 0) {
            return 0.0;
        }
        $union = ($left['width'] * $left['height']) + ($right['width'] * $right['height']) - $inter;

        return $union > 0 ? $inter / $union : 0.0;
    }

    /**
     * @param  array{left: float, top: float, width: float, height: float}  $left
     * @param  array{left: float, top: float, width: float, height: float}  $right
     */
    public static function centerDistance(array $left, array $right): float
    {
        $ax = $left['left'] + $left['width'] / 2.0;
        $ay = $left['top'] + $left['height'] / 2.0;
        $bx = $right['left'] + $right['width'] / 2.0;
        $by = $right['top'] + $right['height'] / 2.0;

        return hypot($ax - $bx, $ay - $by);
    }

    public static function classFamily(string $label): string
    {
        $name = DatasetClasses::match($label) ?: trim($label);

        return match ($name) {
            'Plastic Wrapper', 'Plastic Cellophane', 'Ecobag', 'Paper Bag' => 'film',
            'Plastic Bottle', 'Glass Bottle', 'Paper Drink Carton' => 'bottle',
            'Plastic Cup', 'Styro Cup' => 'cup',
            'Styrofoam' => 'foam',
            'Cardboard' => 'sheet',
            default => strtolower($name),
        };
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
        // Older detectors still send "Confirmed Cleaned": it only ever meant "left the view".
        if ($status === 'Confirmed Cleaned') {
            $status = Detection::NOT_VISIBLE;
        }
        if (! in_array($status, [Detection::PRESENT, Detection::NOT_VISIBLE], true)) {
            return 'rejected';
        }
        // A person verified the cleaning: the cameras do not change that record.
        if ($detection->status === Detection::VERIFIED) {
            return 'unchanged';
        }

        if ($status === Detection::NOT_VISIBLE && $detection->status === Detection::NOT_VISIBLE) {
            return 'unchanged';
        }

        $lastSeen = isset($update['last_seen_at'])
            ? Carbon::parse($update['last_seen_at'])
            : now();

        if ($status === Detection::NOT_VISIBLE) {
            $newerElsewhere = DetectionObservation::query()
                ->where('detection_id', $detection->id)
                ->where('camera_id', '!=', $camera->id)
                ->where('observed_at', '>', $lastSeen)
                ->exists();
            if ($newerElsewhere) {
                return 'stale';
            }

            // Inferred disappearance only; this is NOT cleaning.
            $detection->status = Detection::NOT_VISIBLE;
            $detection->removed_at = now();
            $detection->removal_reason = $update['reason'] ?? 'inferred_disappearance';
            $detection->save();

            return 'cleaned';
        }

        $detection->status = Detection::PRESENT;
        $detection->last_seen_at = now();
        $detection->removed_at = null;
        $detection->removal_reason = null;
        $detection->save();

        return 'present';
    }

    /**
     * Heartbeat of IDs still in this camera frame. Missing Present rows
     * become "No Longer Visible" after a short grace (inferred disappearance,
     * not cleaning) even if a track id lingered on the overlay.
     *
     * @param  list<int>  $visibleIds
     */
    public static function syncVisible(Camera $camera, array $visibleIds): int
    {
        $ids = [];
        foreach ($visibleIds as $id) {
            if (is_int($id) || (is_string($id) && ctype_digit($id))) {
                $ids[] = (int) $id;
            }
        }
        $ids = array_values(array_unique($ids));
        $grace = max(3, (int) config('services.detector.absence_grace_seconds', 12));
        $cutoff = now()->subSeconds($grace);

        if ($ids !== []) {
            Detection::query()
                ->where('camera_id', $camera->id)
                ->whereIn('id', $ids)
                ->whereNotIn('status', [Detection::IGNORED, Detection::VERIFIED])
                ->update([
                    'status' => Detection::PRESENT,
                    'last_seen_at' => now(),
                    'removed_at' => null,
                    'removal_reason' => null,
                ]);
        }

        return Detection::query()
            ->where('camera_id', $camera->id)
            ->where('status', 'Present')
            ->when($ids !== [], function ($query) use ($ids) {
                $query->whereNotIn('id', $ids);
            })
            ->where(function ($query) use ($cutoff) {
                $query->where('last_seen_at', '<=', $cutoff)
                    ->orWhere(function ($inner) use ($cutoff) {
                        $inner->whereNull('last_seen_at')
                            ->where('detected_at', '<=', $cutoff);
                    });
            })
            ->update([
                'status' => Detection::NOT_VISIBLE,
                'removed_at' => now(),
                'removal_reason' => 'inferred_disappearance',
            ]);
    }

    /**
     * Server-side cleanup so every page agrees with the live cameras, even when
     * the detector stops sending (detection off, detector stopped, API down):
     *  - detection off: everything still Present becomes "No Longer Visible";
     *  - detection on: Present waste not seen for STALE_SECONDS becomes
     *    "No Longer Visible" (a visible item is re-seen every few seconds).
     * Never "Cleaning Verified": only a person can verify cleaning.
     * Runs at most every few seconds; returns how many rows changed.
     */
    public const STALE_SECONDS = 40;

    public static function sweepStale(bool $force = false): int
    {
        if (! $force && ! Cache::add('presence:sweep-lock', 1, 3)) {
            return 0;
        }

        $detection = SystemSetting::getDefault()['detection'] ?? [];
        $detectionOn = is_array($detection) && filter_var($detection['enabled'] ?? false, FILTER_VALIDATE_BOOLEAN);
        $cutoff = now()->subSeconds(max(self::STALE_SECONDS, 2 * (int) config('services.detector.absence_grace_seconds', 12)));

        $changed = Detection::query()
            ->where('status', 'Present')
            ->when($detectionOn, function ($query) use ($cutoff) {
                $query->where(function ($inner) use ($cutoff) {
                    $inner->where('last_seen_at', '<=', $cutoff)
                        ->orWhere(function ($never) use ($cutoff) {
                            $never->whereNull('last_seen_at')->where('detected_at', '<=', $cutoff);
                        });
                });
            })
            ->update([
                'status' => Detection::NOT_VISIBLE,
                'removed_at' => now(),
                'removal_reason' => $detectionOn ? 'inferred_disappearance' : 'detection_off',
            ]);

        if ($changed > 0) {
            DashboardCache::flush();
            Cache::forget('report:today:v1');
        }

        return $changed;
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
