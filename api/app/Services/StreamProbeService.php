<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class StreamProbeService
{
    /**
     * @return array{ok: bool, latency_ms: int|null}
     */
    public function probe(?string $url, ?string $protocol = null): array
    {
        if (! $url) {
            return ['ok' => false, 'latency_ms' => null];
        }

        $protocol = strtoupper($protocol ?? '');

        if (Str::startsWith(strtolower($url), 'rtsp://') || Str::contains($protocol, 'RTSP')) {
            return $this->probeRtsp($url);
        }

        if (Str::contains($url, '.m3u8') || Str::contains($protocol, 'HLS')) {
            return $this->probeHttp($url);
        }

        if (preg_match('/\.(jpg|jpeg|mjpg|mjpeg)|snapshot|mjpeg/i', $url) || Str::contains($protocol, 'MJPEG') || Str::contains($protocol, 'HTTP')) {
            return $this->probeHttp($url);
        }

        return $this->probeHttp($url);
    }

    /**
     * @return array{ok: bool, latency_ms: int|null}
     */
    private function probeRtsp(string $url): array
    {
        $parts = parse_url($url);
        $host = $parts['host'] ?? null;
        $port = $parts['port'] ?? 554;

        if (! $host) {
            return ['ok' => false, 'latency_ms' => null];
        }

        $start = microtime(true);
        $socket = @fsockopen($host, (int) $port, $errno, $errstr, 3);

        if (! $socket) {
            return ['ok' => false, 'latency_ms' => null];
        }

        fclose($socket);
        $latency = (int) round((microtime(true) - $start) * 1000);

        return ['ok' => true, 'latency_ms' => $latency];
    }

    /**
     * @return array{ok: bool, latency_ms: int|null}
     */
    private function probeHttp(string $url): array
    {
        if (! Str::startsWith($url, ['http://', 'https://'])) {
            return ['ok' => false, 'latency_ms' => null];
        }

        $start = microtime(true);

        try {
            $response = Http::timeout(5)
                ->withOptions(['allow_redirects' => true])
                ->head($url);

            if (! $response->successful()) {
                $response = Http::timeout(5)->get($url);
            }

            $ok = $response->successful();
            $latency = $ok ? (int) round((microtime(true) - $start) * 1000) : null;

            return ['ok' => $ok, 'latency_ms' => $latency];
        } catch (\Throwable) {
            return ['ok' => false, 'latency_ms' => null];
        }
    }
}
