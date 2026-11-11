<?php

namespace Database\Seeders;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\Report;
use App\Models\SystemSetting;
use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;

class CoastalMonitoringSeeder extends Seeder
{
    public function run(): void
    {
        User::query()->updateOrCreate(
            ['email' => 'operator@tidalwatch.test'],
            [
                'name' => 'Station Operator',
                'password' => Hash::make('password'),
            ],
        );

        $cameras = [
            [
                'id' => 'CAM-01',
                'name' => 'CAM-01 · Pier Overlook',
                'sector' => 'Sector B',
                'stream_url' => 'http://127.0.0.1:1984/api/stream.mp4?src=cam01',
                'protocol' => 'MSE',
                'username' => 'camera_costal',
                'password' => 'password_costal',
                'status' => 'live',
                'detections_per_hour' => 12,
            ],
            [
                'id' => 'CAM-02',
                'name' => 'CAM-02 · Mangrove Edge',
                'sector' => 'Sector E',
                'stream_url' => 'rtsp://192.168.1.65:554',
                'protocol' => 'RTSP',
                'status' => 'offline',
                'detections_per_hour' => 7,
            ],
        ];

        foreach ($cameras as $camera) {
            Camera::query()->updateOrCreate(
                ['id' => $camera['id']],
                $camera + [
                    'transport' => 'TCP',
                    'resolution' => '1920 × 1080',
                    'fps' => '25 FPS',
                    'detection_enabled' => true,
                    'in_grid' => true,
                ],
            );
        }

        $today = Carbon::today();
        $detections = [
            [
                'camera_id' => 'CAM-03',
                'class_label' => 'Plastic bottle cluster',
                'confidence' => 0.94,
                'count' => 4,
                'sector' => 'Sector B',
                'detected_at' => $today->copy()->setTime(14, 32, 8),
                'severity' => 'alert',
                'subtitle' => '4 objects · intertidal zone',
            ],
            [
                'camera_id' => 'CAM-01',
                'class_label' => 'Abandoned fishing net',
                'confidence' => 0.81,
                'count' => 1,
                'sector' => 'Sector B',
                'detected_at' => $today->copy()->setTime(14, 17, 41),
                'severity' => 'warn',
                'subtitle' => 'entanglement risk · large item',
            ],
            [
                'camera_id' => 'CAM-02',
                'class_label' => 'Styrofoam fragments',
                'confidence' => 0.88,
                'count' => 9,
                'sector' => 'Sector E',
                'detected_at' => $today->copy()->setTime(13, 58, 22),
                'severity' => 'alert',
                'subtitle' => '9 objects · drifting inshore',
            ],
        ];

        foreach ($detections as $detection) {
            Detection::query()->updateOrCreate(
                [
                    'class_label' => $detection['class_label'],
                    'detected_at' => $detection['detected_at'],
                ],
                $detection,
            );
        }

        // Yesterday baseline for stats deltas
        Detection::query()->firstOrCreate(
            [
                'class_label' => 'Plastic bag drift',
                'detected_at' => Carbon::yesterday()->setTime(11, 0, 0),
            ],
            [
                'camera_id' => 'CAM-02',
                'confidence' => 0.72,
                'count' => 2,
                'sector' => 'Sector E',
                'severity' => 'alert',
                'subtitle' => 'baseline event',
            ],
        );

        if (Report::query()->count() === 0) {
            for ($i = 0; $i < 5; $i++) {
                Report::query()->create([
                    'sector' => 'Sector '.chr(65 + $i),
                    'notes' => 'Cleanup sweep logged',
                    'status' => 'acknowledged',
                ]);
            }
        }

        SystemSetting::saveDefault([
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
                'model' => 'YOLOv11n ONNX · best.onnx',
                'confidence' => 0.6,
                'interval' => 5,
                'classes' => [
                    'Can',
                    'Cardboard',
                    'Ecobag',
                    'Face Mask',
                    'Glass Bottle',
                    'Paper Bag',
                    'Paper Drink Carton',
                    'Plastic Bottle',
                    'Plastic Cellophane',
                    'Plastic Cup',
                    'Plastic Wrapper',
                    'Styro Cup',
                    'Styrofoam',
                ],
                'showBoxes' => true,
                'showConfidence' => true,
            ],
            'recording' => [
                'record_confidence' => 0.70,
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
                'email' => 'coastal-team@example.org',
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
        ]);
    }
}
