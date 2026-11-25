<?php

namespace App\Support;

use App\Models\Detection;
use App\Models\Notification;
use App\Models\User;
use Illuminate\Support\Collection;

/** Create one admin notification per newly saved waste detection. */
class DetectionNotifier
{
    /**
     * Settings > Notifications > "Notify on every new detection". Off by
     * default so the bell keeps the cleanup alerts readable.
     */
    public static function enabled(): bool
    {
        $alerts = \App\Models\SystemSetting::getDefault()['alerts'] ?? [];

        return is_array($alerts) && filter_var($alerts['detectionAlerts'] ?? false, FILTER_VALIDATE_BOOLEAN);
    }

    public static function notifyNewDetection(Detection $detection): void
    {
        if (! self::enabled()) {
            return;
        }
        $detection->loadMissing(['camera', 'classification']);

        $recipients = self::recipients();
        if ($recipients->isEmpty()) {
            return;
        }

        $class = $detection->classification?->waste_type
            ?: 'waste item';
        $location = $detection->location
            ?: ($detection->camera?->monitoring_location ?: 'the monitoring site');
        $cameraName = $detection->camera?->camera_name
            ?: ($detection->camera?->camera_code ?: 'Camera');
        $when = $detection->detected_at?->format('Y-m-d H:i:s')
            ?: now()->format('Y-m-d H:i:s');

        $title = 'New Waste Detection';
        $message = "A new {$class} was detected at {$location}."
            ." Camera: {$cameraName}."
            ." Detected at {$when}."
            ." Record #{$detection->id}.";

        foreach ($recipients as $user) {
            Notification::query()->firstOrCreate(
                [
                    'user_id' => $user->id,
                    'detection_id' => $detection->id,
                ],
                [
                    'title' => $title,
                    'message' => $message,
                    'type' => 'info',
                    'is_read' => false,
                ],
            );
        }
    }

    /** @return Collection<int, User> */
    private static function recipients(): Collection
    {
        $admins = User::query()
            ->where('role', 'Admin')
            ->orderBy('id')
            ->get();

        if ($admins->isNotEmpty()) {
            return $admins;
        }

        return User::query()->orderBy('id')->limit(5)->get();
    }
}
