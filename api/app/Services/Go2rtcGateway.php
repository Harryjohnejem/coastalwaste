<?php

namespace App\Services;

use App\Models\Camera;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Talks to the go2rtc gateway for IP cameras added from the dashboard.
 * Cameras written in gateway/go2rtc.yaml by hand (CAM-01, CAM-02) are never touched.
 */
class Go2rtcGateway
{
    public function base(): string
    {
        return rtrim((string) config('services.go2rtc.base', 'http://127.0.0.1:1990'), '/');
    }

    /** Browser stream URL saved on the camera, same format as CAM-01 and CAM-02. */
    public function playbackUrl(string $src): string
    {
        $public = rtrim((string) config('services.go2rtc.public_base', $this->base()), '/');

        return $public.'/api/stream.mp4?src='.rawurlencode($src);
    }

    /** RTSP address go2rtc opens. Credentials are URL-encoded so symbols in a password work. */
    public static function rtspSource(
        string $ip,
        ?int $port,
        ?string $path,
        ?string $username,
        ?string $password,
        ?string $transport = 'TCP',
    ): string {
        $auth = '';
        if (filled($username)) {
            $auth = rawurlencode((string) $username);
            if (filled($password)) {
                $auth .= ':'.rawurlencode((string) $password);
            }
            $auth .= '@';
        }
        $path = '/'.ltrim((string) ($path ?: '/stream1'), '/');
        $port = $port ?: 554;
        $flags = strtoupper((string) $transport) === 'UDP' ? '' : '#transport=tcp';

        return "rtsp://{$auth}{$ip}:{$port}{$path}{$flags}#timeout=5s";
    }

    public static function sourceFor(Camera $camera): ?string
    {
        if (! filled($camera->ip_address)) {
            return null;
        }

        return self::rtspSource(
            (string) $camera->ip_address,
            $camera->rtsp_port,
            $camera->rtsp_path,
            $camera->username,
            $camera->password,
            $camera->transport,
        );
    }

    /** Add or replace the camera's stream. go2rtc keeps it after a restart. */
    public function register(Camera $camera): bool
    {
        $source = self::sourceFor($camera);
        if (! $camera->go2rtc_src || ! $source) {
            return false;
        }
        try {
            $this->remove($camera->go2rtc_src);
            $response = Http::timeout(5)->put($this->base().'/api/streams?'.http_build_query([
                'name' => $camera->go2rtc_src,
                'src' => $source,
            ]));

            return $response->successful();
        } catch (\Throwable $e) {
            Log::warning('go2rtc register failed', ['camera' => $camera->camera_code, 'error' => $e->getMessage()]);

            return false;
        }
    }

    public function remove(string $src): bool
    {
        try {
            return Http::timeout(5)->delete($this->base().'/api/streams?'.http_build_query(['src' => $src]))->successful();
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * Grab one picture through go2rtc. A wrong address or password returns no
     * picture (go2rtc still answers 200), so the body must be a real JPEG.
     *
     * @return array{ok: bool, latency_ms: int|null, message?: string}
     */
    public function probe(string $srcOrUrl, bool $temporary = false): array
    {
        $started = microtime(true);
        try {
            $response = Http::timeout(12)->get($this->base().'/api/frame.jpeg', ['src' => $srcOrUrl]);
            $body = (string) $response->body();
            $ok = $response->successful() && strlen($body) > 1000 && str_starts_with($body, "\xFF\xD8");

            return [
                'ok' => $ok,
                'latency_ms' => (int) round((microtime(true) - $started) * 1000),
            ] + ($ok ? [] : ['message' => 'No picture from the camera. Check the IP address, port, path, username and password.']);
        } catch (\Throwable) {
            return ['ok' => false, 'latency_ms' => null, 'message' => 'The video gateway (go2rtc) did not answer. Make sure it is running.'];
        } finally {
            if ($temporary) {
                // go2rtc opened the address as a one-off stream; close it again.
                $this->remove($srcOrUrl);
            }
        }
    }
}
