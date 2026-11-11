<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionLog;
use App\Support\WasteClassifier;
use App\Support\WasteQuotaMonitor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

class DetectionController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $limit = min((int) $request->query('limit', 50), 200);

        $detections = Detection::query()
            ->with(['camera', 'classification.category'])
            ->orderByDesc('detected_at')
            ->limit($limit)
            ->get()
            ->map(fn (Detection $detection) => $detection->toApiArray());

        return response()->json($detections);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'camera_id' => ['nullable', 'string', 'max:32'],
            'class' => ['required', 'string', 'max:120'],
            'confidence' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'count' => ['nullable', 'integer', 'min:1', 'max:999'],
            'sector' => ['nullable', 'string', 'max:120'],
            'location' => ['nullable', 'string', 'max:120'],
            'severity' => ['nullable', 'string', 'max:32'],
            'subtitle' => ['nullable', 'string', 'max:255'],
        ]);

        $camera = isset($data['camera_id'])
            ? Camera::query()->where('camera_code', $data['camera_id'])->first()
            : null;

        if (! $camera) {
            return response()->json(['message' => 'Camera not found.'], 422);
        }

        $classification = WasteClassifier::resolve($data['class']);

        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => WasteClassifier::confidencePercent(
                isset($data['confidence']) ? (float) $data['confidence'] : null
            ),
            'quantity' => $data['count'] ?? 1,
            'location' => $data['location'] ?? $data['sector'] ?? $camera->monitoring_location,
            'detected_at' => now(),
            'status' => 'Detected',
        ]);

        try {
            WasteQuotaMonitor::evaluate();
        } catch (\Throwable) {
            /* quota table may not be migrated yet */
        }

        return response()->json($detection->fresh(['camera', 'classification.category'])->toApiArray(), 201);
    }

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
            'model' => ['nullable', 'string', 'max:2000'],
            'detections' => ['nullable', 'array'],
            'detections.*.class' => ['required_with:detections', 'string'],
            'detections.*.confidence' => ['nullable', 'numeric'],
            'detections.*.count' => ['nullable', 'integer'],
            'detections.*.severity' => ['nullable', 'string'],
            'detections.*.sector' => ['nullable', 'string'],
            'detections.*.subtitle' => ['nullable', 'string'],
        ]);

        $cameraCode = $data['camera_id'];
        $boxes = $data['boxes'] ?? [];

        Cache::put($this->overlayKey($cameraCode), [
            'camera_id' => $cameraCode,
            'boxes' => $boxes,
            'inference_ms' => $data['inference_ms'] ?? null,
            'model' => $data['model'] ?? 'YOLO · waste',
            'updated_at' => now()->toIso8601String(),
        ], now()->addSeconds(30));

        $camera = Camera::query()->where('camera_code', $cameraCode)->first();
        if ($camera) {
            $camera->update([
                'status' => 'Online',
                'last_seen' => now(),
            ]);
        }

        $created = [];
        $modelName = $data['model'] ?? 'YOLO';
        $inferenceMs = $data['inference_ms'] ?? null;

        foreach ($data['detections'] ?? [] as $row) {
            if (! $camera) {
                break;
            }

            $classification = WasteClassifier::resolve($row['class']);
            $confidence = WasteClassifier::confidencePercent(
                isset($row['confidence']) ? (float) $row['confidence'] : null
            );

            $detection = Detection::query()->create([
                'camera_id' => $camera->id,
                'classification_id' => $classification->id,
                'confidence' => $confidence,
                'quantity' => $row['count'] ?? 1,
                'location' => $row['sector'] ?? $camera->monitoring_location,
                'detected_at' => now(),
                'status' => 'Detected',
            ]);

            DetectionLog::query()->create([
                'detection_id' => $detection->id,
                'frame_number' => null,
                'model_name' => $modelName,
                'model_version' => null,
                'raw_label' => $row['class'],
                'confidence' => $confidence,
                'processing_time_ms' => $inferenceMs,
                'created_at' => now(),
            ]);

            $created[] = $detection->fresh(['camera', 'classification.category'])->toApiArray();
        }

        if (count($created) > 0) {
            try {
                WasteQuotaMonitor::evaluate();
            } catch (\Throwable) {
                /* quota table may not be migrated yet */
            }
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
