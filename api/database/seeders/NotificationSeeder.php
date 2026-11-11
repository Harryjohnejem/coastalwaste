<?php

namespace Database\Seeders;

use App\Models\Notification;
use App\Models\User;
use Illuminate\Database\Seeder;

class NotificationSeeder extends Seeder
{
    public function run(): void
    {
        $admin = User::query()->where('email', 'dioquinojimscarl@tcc.edu.ph')->first();
        if (! $admin) {
            return;
        }

        Notification::query()->updateOrCreate(
            [
                'user_id' => $admin->id,
                'title' => 'System ready',
            ],
            [
                'message' => 'Coastal Waste Monitoring System is online for Paco Beach, Brgy. Gracia.',
                'type' => 'success',
                'is_read' => false,
            ],
        );

        Notification::query()->updateOrCreate(
            [
                'user_id' => $admin->id,
                'title' => 'Plastic detections',
            ],
            [
                'message' => 'Review the latest plastic detections at Paco Beach.',
                'type' => 'warning',
                'is_read' => false,
            ],
        );

        Notification::query()->updateOrCreate(
            [
                'user_id' => $admin->id,
                'title' => 'CAM-02 offline',
            ],
            [
                'message' => 'Mangrove Edge is not streaming. Check the camera connection.',
                'type' => 'danger',
                'is_read' => false,
            ],
        );
    }
}
