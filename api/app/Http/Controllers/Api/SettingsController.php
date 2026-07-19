<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\SystemSetting;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SettingsController extends Controller
{
    public function show(): JsonResponse
    {
        return response()->json($this->mergedSettings());
    }

    public function update(Request $request): JsonResponse
    {
        $settings = $request->validate([
            'stream' => ['sometimes', 'array'],
            'detection' => ['sometimes', 'array'],
            'alerts' => ['sometimes', 'array'],
            'station' => ['sometimes', 'array'],
        ]);

        $merged = array_replace_recursive($this->mergedSettings(), $settings);
        SystemSetting::saveDefault($merged);

        return response()->json($merged);
    }

    /**
     * @return array<string, mixed>
     */
    private function mergedSettings(): array
    {
        $stored = SystemSetting::getDefault();
        $base = $this->baseSettings();

        return empty($stored) ? $base : array_replace_recursive($base, $stored);
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
                'model' => 'YOLO-COAST v2.1 (recommended)',
                'confidence' => 0.6,
                'interval' => 5,
                'classes' => [
                    'Plastic bottles',
                    'Plastic bags',
                    'Fishing nets',
                    'Styrofoam',
                    'Metal cans',
                ],
                'showBoxes' => true,
                'showConfidence' => true,
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
