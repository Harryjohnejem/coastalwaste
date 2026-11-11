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
            ->orderBy('camera_code')
            ->get()
            ->map(fn (Camera $camera) => $camera->toApiArray());

        return response()->json($cameras);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validated($request);

        $code = $request->input('id') ?: $request->input('camera_code');
        if (! $code) {
            $next = Camera::query()->count() + 1;
            $code = 'CAM-'.str_pad((string) $next, 2, '0', STR_PAD_LEFT);
            while (Camera::query()->where('camera_code', $code)->exists()) {
                $next++;
                $code = 'CAM-'.str_pad((string) $next, 2, '0', STR_PAD_LEFT);
            }
        }

        $camera = Camera::query()->create([
            'camera_code' => $code,
            ...$data,
        ]);

        return response()->json($camera->toApiArray(), 201);
    }

    public function update(Request $request, Camera $camera): JsonResponse
    {
        $camera->update($this->validated($request, partial: true));

        return response()->json($camera->fresh()->toApiArray());
    }

    public function destroy(Camera $camera): JsonResponse
    {
        $camera->delete();

        return response()->json(['ok' => true]);
    }

    public function test(Camera $camera): JsonResponse
    {
        return response()->json(
            $this->streamProbe->probe($camera->stream_url, $camera->protocol),
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $partial = false): array
    {
        $rules = [
            'name' => [$partial ? 'sometimes' : 'required', 'string', 'max:255'],
            'camera_name' => ['sometimes', 'string', 'max:255'],
            'sector' => ['sometimes', 'string', 'max:120'],
            'monitoring_location' => ['sometimes', 'string', 'max:120'],
            'ip_address' => ['nullable', 'string', 'max:45'],
            'stream_url' => ['nullable', 'string', 'max:2048'],
            'protocol' => ['sometimes', 'string', 'max:64'],
            'transport' => ['sometimes', 'string', 'max:32'],
            'username' => ['nullable', 'string', 'max:255'],
            'password' => ['nullable', 'string', 'max:255'],
            'status' => ['sometimes', 'string', 'max:32'],
            'resolution' => ['sometimes', 'string', 'max:64'],
            'fps' => ['sometimes', 'string', 'max:32'],
            'detection' => ['sometimes', 'boolean'],
            'inGrid' => ['sometimes', 'boolean'],
        ];

        $validated = $request->validate($rules);
        $payload = [];

        $name = $validated['camera_name'] ?? $validated['name'] ?? null;
        if ($name !== null) {
            $payload['camera_name'] = $name;
        } elseif (! $partial) {
            $payload['camera_name'] = 'New camera';
        }

        $location = $validated['monitoring_location'] ?? $validated['sector'] ?? null;
        if ($location !== null) {
            $payload['monitoring_location'] = $location;
        } elseif (! $partial) {
            $payload['monitoring_location'] = 'Paco Beach';
        }

        foreach (['ip_address', 'stream_url', 'transport', 'username', 'password', 'resolution', 'fps'] as $field) {
            if (array_key_exists($field, $validated)) {
                $payload[$field] = $validated[$field];
            }
        }

        if (array_key_exists('protocol', $validated)) {
            $payload['protocol'] = $this->normalizeProtocol($validated['protocol']);
        } elseif (! $partial) {
            $payload['protocol'] = 'RTSP';
        }

        if (array_key_exists('status', $validated)) {
            $payload['status'] = $this->normalizeStatus($validated['status']);
        } elseif (! $partial) {
            $payload['status'] = 'Offline';
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
                'transport' => $payload['transport'] ?? 'TCP',
                'resolution' => $payload['resolution'] ?? '1920 × 1080',
                'fps' => $payload['fps'] ?? '25 FPS',
            ];
        }

        return $payload;
    }

    private function normalizeStatus(string $status): string
    {
        $s = strtolower($status);

        return in_array($s, ['online', 'live'], true) ? 'Online' : 'Offline';
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
