<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Detection;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

class DetectionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $limit = min((int) $request->query('limit', 50), 200);

        $detections = Detection::query()
            ->orderByDesc('detected_at')
            ->limit($limit)
            ->get()
            ->map(fn (Detection $detection) => $detection->toApiArray());

        return response()->json($detections);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['nullable', 'string', 'max:32', 'exists:cameras,id'],
            'class' => ['required', 'string', 'max:120'],
            'confidence' => ['nullable', 'numeric', 'min:0', 'max:1'],
            'count' => ['nullable', 'integer', 'min:1', 'max:999'],
            'sector' => ['nullable', 'string', 'max:64'],
            'severity' => ['nullable', 'string', 'max:32'],
            'subtitle' => ['nullable', 'string', 'max:255'],
        ]);

        $detection = Detection::query()->create([
            'camera_id' => $data['camera_id'] ?? null,
            'class_label' => $data['class'],
            'confidence' => $data['confidence'] ?? null,
            'count' => $data['count'] ?? 1,
            'sector' => $data['sector'] ?? null,
            'severity' => $data['severity'] ?? 'alert',
            'subtitle' => $data['subtitle'] ?? null,
            'detected_at' => now(),
        ]);

        return response()->json($detection->toApiArray(), 201);
    }

    /** Live overlay snapshot from the Python YOLO worker (polled by the dashboard). */
    public function live(Request $request): JsonResponse
    {
        $cameraId = (string) $request->query('camera_id', 'CAM-01');
        $payload = Cache::get($this->overlayKey($cameraId), [
            'camera_id' => $cameraId,
            'boxes' => [],
            'inference_ms' => null,
            'model' => null,
            'updated_at' => null,
        ]);

        return response()->json($payload);
    }

    /** Ingest from detector service (X-Detector-Key). */
    public function ingestLive(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['required', 'string', 'max:32'],
            'boxes' => ['nullable', 'array'],
            'boxes.*.id' => ['nullable', 'string'],
            'boxes.*.class' => ['required_with:boxes', 'string'],
            'boxes.*.confidence' => ['nullable', 'numeric'],
            'boxes.*.left' => ['nullable', 'numeric'],
            'boxes.*.top' => ['nullable', 'numeric'],
            'boxes.*.width' => ['nullable', 'numeric'],
            'boxes.*.height' => ['nullable', 'numeric'],
            'boxes.*.severity' => ['nullable', 'string'],
            'boxes.*.variant' => ['nullable', 'string'],
            'inference_ms' => ['nullable', 'integer'],
            'model' => ['nullable', 'string', 'max:120'],
            'detections' => ['nullable', 'array'],
            'detections.*.class' => ['required_with:detections', 'string'],
            'detections.*.confidence' => ['nullable', 'numeric'],
            'detections.*.count' => ['nullable', 'integer'],
            'detections.*.severity' => ['nullable', 'string'],
            'detections.*.sector' => ['nullable', 'string'],
            'detections.*.subtitle' => ['nullable', 'string'],
        ]);

        $cameraId = $data['camera_id'];
        $boxes = $data['boxes'] ?? [];

        Cache::put($this->overlayKey($cameraId), [
            'camera_id' => $cameraId,
            'boxes' => $boxes,
            'inference_ms' => $data['inference_ms'] ?? null,
            'model' => $data['model'] ?? 'YOLO-World · waste',
            'updated_at' => now()->toIso8601String(),
        ], now()->addSeconds(30));

        $created = [];
        foreach ($data['detections'] ?? [] as $row) {
            $cameraExists = \App\Models\Camera::query()->whereKey($cameraId)->exists();
            $detection = Detection::query()->create([
                'camera_id' => $cameraExists ? $cameraId : null,
                'class_label' => $row['class'],
                'confidence' => $row['confidence'] ?? null,
                'count' => $row['count'] ?? 1,
                'sector' => $row['sector'] ?? null,
                'severity' => $row['severity'] ?? 'alert',
                'subtitle' => $row['subtitle'] ?? null,
                'detected_at' => now(),
            ]);
            $created[] = $detection->toApiArray();
        }

        return response()->json([
            'ok' => true,
            'boxes' => count($boxes),
            'logged' => count($created),
            'detections' => $created,
        ]);
    }

    private function overlayKey(string $cameraId): string
    {
        return 'live_overlay:'.$cameraId;
    }
}
