<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\SystemSetting;
use App\Support\DatasetClasses;
use App\Support\LiveModel;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SettingsController extends Controller
{
    private const MIN_CONFIDENCE = 0.80;

    private const MAX_CONFIDENCE = 0.98;

    private const MIN_REVIEW_CONFIDENCE = 0.25;

    private const DEFAULT_DETECT_CONF = 0.80;


    private const CLIP_SECONDS_OPTIONS = [15, 30, 60, 180, 300, 600];


    private const DEFAULT_CLIP_SECONDS = 60;

    private const DEFAULT_RECORD_CONF = 0.80;

    private const DEFAULT_REVIEW_CONF = 0.60;

    public function show(): JsonResponse
    {
        return response()->json($this->withLiveModel($this->mergedSettings()));
    }

    /**
     * The model the cameras run, as the rest of the system names it
     * (Dataset Source, Today's Report): "YOLOv11l / Roboflow" + the dataset.
     * Updated on Deploy and Rollback.
     */
    private function withLiveModel(array $settings): array
    {
        $live = LiveModel::current();
        $settings['live_model'] = $live + ['label' => "{$live['model']} / Roboflow · {$live['dataset']}"];
        $settings['detection']['model'] = $settings['live_model']['label'];

        return $settings;
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
            'enabled' => (bool) ($detection['enabled'] ?? false),
            'confidence' => $this->clampConfidence(
                $detection['confidence'] ?? null,
                self::DEFAULT_DETECT_CONF
            ),
            'review_confidence' => $this->clampReviewConfidence(
                $detection['review_confidence'] ?? null
            ),
            'interval' => (int) ($detection['interval'] ?? 1),
            'classes' => \App\Support\ClassRegistry::live(),
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
        $merged['recording']['clip_max_seconds'] = $this->clampClipSeconds(
            $merged['recording']['clip_max_seconds'] ?? null
        );
        unset($merged['detection']['fusion']);
        $merged['alerts']['cleanupLimit'] = max(1, min(500, (int) ($merged['alerts']['cleanupLimit'] ?? 20)));
        $merged['alerts']['densityThreshold'] = max(10, min(95, (int) ($merged['alerts']['densityThreshold'] ?? 70)));

        SystemSetting::saveDefault($merged);
        if (array_key_exists('enabled', $settings['detection'] ?? []) && ! filter_var($settings['detection']['enabled'], FILTER_VALIDATE_BOOLEAN)) {
            // Detection off: nothing is watched any more, so nothing is "still on the beach".
            \App\Support\WastePresence::sweepStale(force: true);
        }

        return response()->json($this->withLiveModel($this->mergedSettings()));
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
        $merged['recording']['clip_max_seconds'] = $this->clampClipSeconds(
            $merged['recording']['clip_max_seconds'] ?? null
        );
        unset($merged['detection']['fusion']);
        $stationName = trim((string) ($merged['station']['name'] ?? ''));
        if ($stationName === '' || $stationName === 'Station 01 — North Shoreline') {
            $merged['station']['name'] = 'Brgy. Gracia';
        }

        return $merged;
    }

    /**
     * Recursive merge that replaces list fields instead of appending by index.
     *
     * @param  array<string, mixed>  $base
     * @param  array<string, mixed>  $incoming
     * @return array<string, mixed>
     */
    /**
     * Live Monitoring clip length. Only the lengths offered in Settings are kept.
     */
    private function clampClipSeconds(mixed $value): int
    {
        $seconds = (int) $value;

        return in_array($seconds, self::CLIP_SECONDS_OPTIONS, true) ? $seconds : self::DEFAULT_CLIP_SECONDS;
    }

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
                'model' => 'YOLOv11x ONNX · best.onnx',
                'enabled' => false,
                'confidence' => self::DEFAULT_DETECT_CONF,
                'review_confidence' => self::DEFAULT_REVIEW_CONF,
                'interval' => 2,
                'classes' => \App\Support\ClassRegistry::live(),
                'showBoxes' => true,
                'showConfidence' => true,
            ],
            'recording' => [
                'record_confidence' => self::DEFAULT_RECORD_CONF,
                'min_confirmation_frames' => 3,
                'track_lost_timeout' => 3,
                'detection_cooldown' => 10,
                'prevent_duplicate' => true,
                'clip_max_seconds' => self::DEFAULT_CLIP_SECONDS,
            ],
            'alerts' => [
                'densityAlerts' => true,
                'detectionAlerts' => false,
                'densityThreshold' => 70,
                'cleanupLimit' => \App\Support\WasteLoad::DEFAULT_LIMIT,
                'largeItemAlerts' => true,
                'offlineAlerts' => true,
                'email' => '',
                'webhook' => '',
                'reportFrequency' => 'Daily · 06:00',
            ],
            'station' => [
                'name' => 'Brgy. Gracia',
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
