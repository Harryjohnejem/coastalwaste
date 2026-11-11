<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Notification;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NotificationController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $userId = $request->user()->id;

        $rows = Notification::query()
            ->where('user_id', $userId)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get();

        $unread = (int) Notification::query()
            ->where('user_id', $userId)
            ->where('is_read', false)
            ->count();

        return response()->json([
            'notifications' => $rows,
            'unread' => $unread,
        ]);
    }

    public function markRead(Request $request, Notification $notification): JsonResponse
    {
        if ((int) $notification->user_id !== (int) $request->user()->id) {
            abort(403);
        }

        $notification->update(['is_read' => true]);

        return response()->json($notification->fresh());
    }

    public function markAllRead(Request $request): JsonResponse
    {
        Notification::query()
            ->where('user_id', $request->user()->id)
            ->where('is_read', false)
            ->update(['is_read' => true]);

        return response()->json(['ok' => true]);
    }
}
