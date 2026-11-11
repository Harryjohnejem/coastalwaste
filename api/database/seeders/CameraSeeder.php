<?php

namespace Database\Seeders;

use App\Models\Camera;
use Illuminate\Database\Seeder;

class CameraSeeder extends Seeder
{
    public function run(): void
    {
        Camera::query()->updateOrCreate(
            ['camera_code' => 'CAM-01'],
            [
                'camera_name' => 'CAM-01 · Pier Overlook',
                'monitoring_location' => 'Paco Beach',
                'ip_address' => '192.168.254.185',
                'status' => 'Online',
                'last_seen' => now(),
                'stream_url' => 'http://127.0.0.1:1990/api/stream.mp4?src=cam01',
                'protocol' => 'MSE',
                'transport' => 'TCP',
                'username' => 'tapolinkcctv',
                'password' => 'tapolink123',
                'resolution' => '1920 × 1080',
                'fps' => '25 FPS',
                'detection_enabled' => true,
                'in_grid' => true,
            ],
        );

        Camera::query()->updateOrCreate(
            ['camera_code' => 'CAM-02'],
            [
                'camera_name' => 'CAM-02 · Mangrove Edge',
                'monitoring_location' => 'Paco Beach',
                'ip_address' => '192.168.1.65',
                'status' => 'Offline',
                'stream_url' => 'rtsp://192.168.1.65:554',
                'protocol' => 'RTSP',
                'transport' => 'TCP',
                'detection_enabled' => true,
                'in_grid' => true,
            ],
        );
    }
}
