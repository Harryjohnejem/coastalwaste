<?php

namespace App\Support;

use App\Models\Notification;
use App\Models\User;
use App\Models\WasteQuota;

class WasteQuotaMonitor
{
    /**
     * Compare accumulated detections against each active quota and alert once
     * per period when the quota is reached (capstone Detection Management module).
     *
     * @return list<array<string, mixed>>
     */
    public static function evaluate(): array
    {
        $quotas = WasteQuota::query()
            ->where('is_active', true)
            ->with(['camera', 'category'])
            ->orderBy('id')
            ->get();

        $statuses = [];
        foreach ($quotas as $quota) {
            $status = $quota->toStatusArray();
            $statuses[] = $status;
            self::notifyIfNeeded($quota, $status);
        }

        return $statuses;
    }

    /**
     * @param  array<string, mixed>  $status
     */
    private static function notifyIfNeeded(WasteQuota $quota, array $status): void
    {
        if (($status['status'] ?? '') !== 'reached') {
            return;
        }

        $title = sprintf(
            'Waste quota reached · %s · %s',
            $quota->name,
            $status['period_key'],
        );

        $message = sprintf(
            'Accumulated waste detections (%d) reached the configured %s quota of %d. %s',
            $status['current_count'],
            $quota->period,
            $status['quota_limit'],
            $quota->cleanup_recommendation,
        );

        $admins = User::query()->where('role', 'Admin')->get();
        if ($admins->isEmpty()) {
            $admins = User::query()->limit(1)->get();
        }

        foreach ($admins as $admin) {
            Notification::query()->firstOrCreate(
                [
                    'user_id' => $admin->id,
                    'title' => $title,
                ],
                [
                    'message' => $message,
                    'type' => 'danger',
                    'is_read' => false,
                ],
            );
        }
    }
}
