<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Services\StreamProbeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class CameraController extends Controller
{
    public function __construct(private readonly StreamProbeService $streamProbe) {}

    public function index(): JsonResponse
    {
        $cameras = Camera::query()
            ->orderBy('id')
            ->get()
            ->map(fn (Camera $camera) => $camera->toApiArray());

        return response()->json($cameras);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validated($request);

        $id = $request->input('id');
        if (! $id) {
            $next = Camera::query()->count() + 1;
            $id = 'CAM-'.str_pad((string) $next, 2, '0', STR_PAD_LEFT);
            while (Camera::query()->whereKey($id)->exists()) {
                $next++;
                $id = 'CAM-'.str_pad((string) $next, 2, '0', STR_PAD_LEFT);
            }
        }

        $camera = Camera::query()->create([
            'id' => $id,
            ...$data,
        ]);

        return response()->json($camera->toApiArray(), 201);
    }

    public function update(Request $request, string $camera): JsonResponse
    {
        $model = Camera::query()->findOrFail($camera);
        $model->update($this->validated($request, partial: true));

        return response()->json($model->fresh()->toApiArray());
    }

    public function destroy(string $camera): JsonResponse
    {
        Camera::query()->findOrFail($camera)->delete();

        return response()->json(['ok' => true]);
    }

    public function test(string $camera): JsonResponse
    {
        $model = Camera::query()->findOrFail($camera);

        return response()->json(
            $this->streamProbe->probe($model->stream_url, $model->protocol),
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $partial = false): array
    {
        $rules = [
            'name' => [$partial ? 'sometimes' : 'required', 'string', 'max:255'],
            'sector' => ['sometimes', 'string', 'max:64'],
            'stream_url' => ['nullable', 'string', 'max:2048'],
            'protocol' => ['sometimes', 'string', 'max:64'],
            'transport' => ['sometimes', 'string', 'max:32'],
            'username' => ['nullable', 'string', 'max:255'],
            'password' => ['nullable', 'string', 'max:255'],
            'status' => ['sometimes', 'string', 'max:32'],
            'detections_per_hour' => ['nullable', 'integer', 'min:0'],
            'resolution' => ['sometimes', 'string', 'max:64'],
            'fps' => ['sometimes', 'string', 'max:32'],
            'detection' => ['sometimes', 'boolean'],
            'inGrid' => ['sometimes', 'boolean'],
        ];

        $validated = $request->validate($rules);
        $payload = [];

        if (array_key_exists('name', $validated)) {
            $payload['name'] = $validated['name'];
        } elseif (! $partial) {
            $payload['name'] = 'New camera';
        }

        foreach (['sector', 'stream_url', 'transport', 'username', 'password', 'status', 'detections_per_hour', 'resolution', 'fps'] as $field) {
            if (array_key_exists($field, $validated)) {
                $payload[$field] = $validated[$field];
            }
        }

        if (array_key_exists('protocol', $validated)) {
            $payload['protocol'] = $this->normalizeProtocol($validated['protocol']);
        } elseif (! $partial) {
            $payload['protocol'] = 'RTSP';
        }

        if (array_key_exists('detection', $validated)) {
            $payload['detection_enabled'] = $validated['detection'];
        } elseif (! $partial) {
            $payload['detection_enabled'] = true;
        }

        if (array_key_exists('inGrid', $validated)) {
            $payload['in_grid'] = $validated['inGrid'];
        } elseif (! $partial) {
            $payload['in_grid'] = true;
        }

        if (! $partial) {
            $payload += [
                'sector' => $payload['sector'] ?? 'Sector A',
                'transport' => $payload['transport'] ?? 'TCP',
                'status' => $payload['status'] ?? 'offline',
                'resolution' => $payload['resolution'] ?? '1920 × 1080',
                'fps' => $payload['fps'] ?? '25 FPS',
            ];
        }

        return $payload;
    }

    private function normalizeProtocol(string $protocol): string
    {
        return match (true) {
            Str::contains(strtoupper($protocol), 'RTSP') => 'RTSP',
            Str::contains(strtoupper($protocol), 'HLS') => 'HLS',
            Str::contains(strtoupper($protocol), 'MJPEG') => 'MJPEG',
            Str::contains(strtoupper($protocol), 'WEBRTC') => 'WebRTC',
            Str::contains(strtoupper($protocol), 'HTTP') => 'HTTP snapshot',
            default => $protocol,
        };
    }
}
