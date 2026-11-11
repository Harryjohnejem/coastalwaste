<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\SystemSetting;
use App\Support\DatasetClasses;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SettingsController extends Controller
{
    private const MIN_CONFIDENCE = 0.80;

    private const MAX_CONFIDENCE = 0.98;

    private const MIN_REVIEW_CONFIDENCE = 0.25;

    private const DEFAULT_DETECT_CONF = 0.80;

    private const DEFAULT_RECORD_CONF = 0.80;

    private const DEFAULT_REVIEW_CONF = 0.50;

    public function show(): JsonResponse
    {
        return response()->json($this->mergedSettings());
    }

    /** Values the live detector applies. No stream passwords or other settings. */
    public function detectionRuntime(): JsonResponse
    {
        $merged = $this->mergedSettings();
        $detection = $merged['detection'] ?? [];
        $recording = $merged['recording'] ?? [];
        $station = $merged['station'] ?? [];
        $classes = $detection['classes'] ?? [];

        return response()->json([
            'enabled' => (bool) ($detection['enabled'] ?? true),
            'confidence' => $this->clampConfidence(
                $detection['confidence'] ?? null,
                self::DEFAULT_DETECT_CONF
            ),
            'review_confidence' => $this->clampReviewConfidence(
                $detection['review_confidence'] ?? null
            ),
            'interval' => (int) ($detection['interval'] ?? 1),
            'classes' => $this->runtimeClasses($classes),
            'recording' => [
                'record_confidence' => $this->clampConfidence(
                    $recording['record_confidence'] ?? null,
                    self::DEFAULT_RECORD_CONF
                ),
                'min_confirmation_frames' => (int) ($recording['min_confirmation_frames'] ?? 3),
                'track_lost_timeout' => (float) ($recording['track_lost_timeout'] ?? 3),
                'prevent_duplicate' => (bool) ($recording['prevent_duplicate'] ?? true),
                'save_snapshots' => (bool) ($station['saveSnapshots'] ?? true),
            ],
        ]);
    }

    public function update(Request $request): JsonResponse
    {
        $settings = $request->validate([
            'stream' => ['sometimes', 'array'],
            'detection' => ['sometimes', 'array'],
            'recording' => ['sometimes', 'array'],
            'alerts' => ['sometimes', 'array'],
            'station' => ['sometimes', 'array'],
        ]);

        $merged = $this->replaceSettings($this->mergedSettings(), $settings);
        if (isset($merged['detection']['confidence'])) {
            $merged['detection']['confidence'] = $this->clampConfidence(
                $merged['detection']['confidence'],
                self::DEFAULT_DETECT_CONF
            );
        }
        if (isset($merged['recording']['record_confidence'])) {
            $merged['recording']['record_confidence'] = $this->clampConfidence(
                $merged['recording']['record_confidence'],
                self::DEFAULT_RECORD_CONF
            );
        }
        $merged['detection']['review_confidence'] = $this->clampReviewConfidence(
            $merged['detection']['review_confidence'] ?? null
        );

        SystemSetting::saveDefault($merged);

        return response()->json($this->mergedSettings());
    }

    /**
     * @return array<string, mixed>
     */
    private function mergedSettings(): array
    {
        $stored = SystemSetting::getDefault();
        $base = $this->baseSettings();
        $merged = empty($stored) ? $base : $this->replaceSettings($base, $stored);
        $merged['detection']['confidence'] = $this->clampConfidence(
            $merged['detection']['confidence'] ?? null,
            self::DEFAULT_DETECT_CONF
        );
        $merged['recording']['record_confidence'] = $this->clampConfidence(
            $merged['recording']['record_confidence'] ?? null,
            self::DEFAULT_RECORD_CONF
        );
        $merged['detection']['review_confidence'] = $this->clampReviewConfidence(
            $merged['detection']['review_confidence'] ?? null
        );

        return $merged;
    }

    /**
     * Recursive merge that replaces list fields instead of appending by index.
     *
     * @param  array<string, mixed>  $base
     * @param  array<string, mixed>  $incoming
     * @return array<string, mixed>
     */
    private function replaceSettings(array $base, array $incoming): array
    {
        $merged = array_replace_recursive($base, $incoming);
        if (isset($incoming['detection']['classes']) && is_array($incoming['detection']['classes'])) {
            $merged['detection']['classes'] = array_values($incoming['detection']['classes']);
        }

        return $merged;
    }

    /**
     * @param  mixed  $classes
     * @return list<string>
     */
    private function runtimeClasses(mixed $classes): array
    {
        $names = [];
        if (is_array($classes)) {
            foreach ($classes as $class) {
                $label = trim((string) $class);
                if ($label === '') {
                    continue;
                }
                $names[$label] = $label;
            }
        }

        return $names === [] ? DatasetClasses::NAMES : array_values($names);
    }

    private function clampConfidence(mixed $value, float $fallback): float
    {
        if (! is_numeric($value)) {
            return $fallback;
        }
        $n = (float) $value;
        if ($n > 1.0 && $n <= 100.0) {
            $n /= 100.0;
        }
        if ($n < self::MIN_CONFIDENCE) {
            return $fallback;
        }

        return min(self::MAX_CONFIDENCE, $n);
    }

    private function clampReviewConfidence(mixed $value): float
    {
        if (! is_numeric($value)) {
            return self::DEFAULT_REVIEW_CONF;
        }
        $n = (float) $value;
        if ($n > 1.0 && $n <= 100.0) {
            $n /= 100.0;
        }

        return min(self::MIN_CONFIDENCE - 0.01, max(self::MIN_REVIEW_CONFIDENCE, $n));
    }

    /**
     * @return array<string, mixed>
     */
    private function baseSettings(): array
    {
        return [
            'stream' => [
                'url' => '',
                'protocol' => 'RTSP (via gateway)',
                'transport' => 'TCP',
                'username' => '',
                'password' => '',
                'resolution' => '1920 × 1080',
                'fps' => '25 FPS',
            ],
            'detection' => [
                'model' => 'YOLOv11s ONNX · best.onnx',
                'enabled' => true,
                'confidence' => self::DEFAULT_DETECT_CONF,
                'review_confidence' => self::DEFAULT_REVIEW_CONF,
                'interval' => 2,
                'classes' => DatasetClasses::NAMES,
                'showBoxes' => true,
                'showConfidence' => true,
            ],
            'recording' => [
                'record_confidence' => self::DEFAULT_RECORD_CONF,
                'min_confirmation_frames' => 3,
                'track_lost_timeout' => 3,
                'detection_cooldown' => 10,
                'prevent_duplicate' => true,
            ],
            'alerts' => [
                'densityAlerts' => true,
                'densityThreshold' => 70,
                'largeItemAlerts' => true,
                'offlineAlerts' => true,
                'email' => '',
                'webhook' => '',
                'reportFrequency' => 'Daily · 06:00',
            ],
            'station' => [
                'name' => 'Station 01 — North Shoreline',
                'lat' => '14.3486',
                'lon' => '121.3244',
                'timezone' => 'Asia/Manila (UTC+8)',
                'saveSnapshots' => true,
                'retention' => '30 days',
                'clipLength' => '30 seconds',
            ],
        ];
    }
}
