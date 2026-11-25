<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Camera;
use App\Models\DetectionImage;
use App\Models\DetectionLog;
use App\Models\DetectionObservation;
use App\Services\Go2rtcGateway;
use App\Services\StreamProbeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class CameraController extends Controller
{
    /** Fields that change what go2rtc must open for an IP camera. */
    private const CONNECTION_FIELDS = ['ip_address', 'rtsp_port', 'rtsp_path', 'username', 'password', 'transport'];

    public function __construct(
        private readonly StreamProbeService $streamProbe,
        private readonly Go2rtcGateway $gateway,
    ) {}

    public function index(): JsonResponse
    {
        $cameras = Camera::query()
            ->orderBy('camera_code')
            ->get()
            ->reject(fn (Camera $camera) => $this->isZoomLens($camera))
            ->map(fn (Camera $camera) => $camera->toApiArray())
            ->values();

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
        } elseif (Camera::query()->where('camera_code', $code)->exists()) {
            throw ValidationException::withMessages([
                'id' => ['That camera code is already in use.'],
            ]);
        }

        $camera = Camera::query()->create([
            'camera_code' => $code,
            ...$data,
        ]);
        $this->syncGateway($camera, true);

        return response()->json($camera->fresh()->toApiArray(), 201);
    }

    public function update(Request $request, Camera $camera): JsonResponse
    {
        $data = $this->validated($request, partial: true);
        $nextIp = array_key_exists('ip_address', $data) ? $data['ip_address'] : $camera->ip_address;
        if (filled($camera->go2rtc_src) && filled($nextIp)) {
            // The playback URL of an IP camera is set here, not typed in the form.
            unset($data['stream_url'], $data['protocol']);
        }
        $camera->update($data);
        $this->syncGateway($camera, $camera->wasChanged(self::CONNECTION_FIELDS));

        return response()->json($camera->fresh()->toApiArray());
    }

    public function destroy(Camera $camera): JsonResponse
    {
        $managedSrc = $camera->go2rtc_src;
        try {
            DB::transaction(function () use ($camera) {
                $detectionIds = $camera->detections()->pluck('id');
                if ($detectionIds->isNotEmpty()) {
                    DetectionImage::query()->whereIn('detection_id', $detectionIds)->delete();
                    DetectionLog::query()->whereIn('detection_id', $detectionIds)->delete();
                    DetectionObservation::query()->whereIn('detection_id', $detectionIds)->delete();
                }
                DetectionObservation::query()->where('camera_id', $camera->id)->delete();
                $camera->detections()->delete();
                $camera->delete();
            });
        } catch (\Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Could not remove this camera from the station database.',
            ], 409);
        }

        if (filled($managedSrc)) {
            $this->gateway->remove($managedSrc);
        }

        return response()->json(['ok' => true]);
    }

    /**
     * IP camera added from the dashboard: give it a gateway stream and a
     * playback URL. Cameras with a typed stream URL (CAM-01, CAM-02) are left alone.
     */
    private function syncGateway(Camera $camera, bool $connectionChanged): void
    {
        $hasIp = filled($camera->ip_address);
        $managed = filled($camera->go2rtc_src);

        if ($hasIp && ($managed || ! filled($camera->stream_url))) {
            if (! $managed) {
                $camera->go2rtc_src = $this->nextGatewayName($camera);
                $connectionChanged = true;
            }
            $camera->stream_url = $this->gateway->playbackUrl($camera->go2rtc_src);
            $camera->protocol = 'MSE';
            $camera->rtsp_port = $camera->rtsp_port ?: 554;
            $camera->rtsp_path = $camera->rtsp_path ?: '/stream1';
            $camera->saveQuietly();
            if ($connectionChanged) {
                $this->gateway->register($camera);
            }

            return;
        }

        if ($managed) {
            // The IP address was removed: stop the gateway stream.
            $this->gateway->remove($camera->go2rtc_src);
            $camera->go2rtc_src = null;
            $camera->saveQuietly();
        }
    }

    /** ipcam03, ipcam04, ... never the hand-written cam01/cam02 names. */
    private function nextGatewayName(Camera $camera): string
    {
        $digits = preg_replace('/\D+/', '', (string) $camera->camera_code) ?: (string) $camera->id;
        $name = 'ipcam'.str_pad($digits, 2, '0', STR_PAD_LEFT);
        $suffix = 1;
        $candidate = $name;
        while (Camera::query()->where('go2rtc_src', $candidate)->whereKeyNot($camera->getKey())->exists()) {
            $candidate = $name.'_'.(++$suffix);
        }

        return $candidate;
    }

    /** Telephoto streams stay in the database so old detections remain. */
    private function isZoomLens(Camera $camera): bool
    {
        $url = (string) $camera->stream_url;
        $name = (string) $camera->camera_name;
        if (preg_match('/src=cam04\b/i', $url) || preg_match('#/stream6\b#i', $url)) {
            return true;
        }

        return (bool) preg_match('/second lens|telephoto|\bzoom\b/i', $name);
    }

    public function test(Camera $camera): JsonResponse
    {
        if (filled($camera->go2rtc_src)) {
            $result = $this->gateway->probe($camera->go2rtc_src);
            if (! $result['ok']) {
                // The gateway may have been restarted without this stream: add it again and retry.
                $this->gateway->register($camera);
                $result = $this->gateway->probe($camera->go2rtc_src);
            }

            return response()->json($result);
        }

        return response()->json(
            $this->streamProbe->probe($camera->stream_url, $camera->protocol),
        );
    }

    /**
     * Test an IP camera before it is saved: go2rtc opens the address once and
     * must return a real picture. A blank password reuses the saved one.
     */
    public function probe(Request $request): JsonResponse
    {
        $data = $request->validate([
            'ip_address' => ['required', 'string', 'max:255', 'regex:/^[A-Za-z0-9.\-:\[\]]+$/'],
            'rtsp_port' => ['nullable', 'integer', 'between:1,65535'],
            'rtsp_path' => ['nullable', 'string', 'max:255'],
            'username' => ['nullable', 'string', 'max:255'],
            'password' => ['nullable', 'string', 'max:255'],
            'transport' => ['nullable', 'string', 'max:32'],
            'camera' => ['nullable', 'string', 'max:32'],
        ]);
        $password = $data['password'] ?? null;
        if (! filled($password) && filled($data['camera'] ?? null)) {
            $password = Camera::query()->where('camera_code', $data['camera'])->first()?->password;
        }
        $source = Go2rtcGateway::rtspSource(
            $data['ip_address'],
            $data['rtsp_port'] ?? null,
            $data['rtsp_path'] ?? null,
            $data['username'] ?? null,
            $password,
            $data['transport'] ?? 'TCP',
        );

        return response()->json($this->gateway->probe($source, temporary: true));
    }

    /**
     * IP cameras added from the dashboard, for the detector. Includes the
     * camera login so go2rtc can be told again after it restarts.
     */
    public function detectorList(): JsonResponse
    {
        $rows = Camera::query()->whereNotNull('go2rtc_src')->orderBy('camera_code')->get()
            ->map(fn (Camera $camera) => [
                'camera_id' => $camera->camera_code,
                'label' => $camera->camera_name,
                'sector' => $camera->monitoring_location,
                'go2rtc_src' => $camera->go2rtc_src,
                'source' => Go2rtcGateway::sourceFor($camera),
                'detection' => (bool) $camera->detection_enabled,
            ])->values();

        return response()->json(['cameras' => $rows])->header('Cache-Control', 'no-store');
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
            'ip_address' => ['nullable', 'string', 'max:255', 'regex:/^[A-Za-z0-9.\-:\[\]]+$/'],
            'rtsp_port' => ['nullable', 'integer', 'between:1,65535'],
            'rtsp_path' => ['nullable', 'string', 'max:255'],
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

        foreach (['ip_address', 'rtsp_port', 'rtsp_path', 'stream_url', 'transport', 'username', 'password', 'resolution', 'fps'] as $field) {
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
