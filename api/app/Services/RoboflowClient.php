<?php

namespace App\Services;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class RoboflowClient
{
    public function configured(): bool
    {
        return $this->apiKey() !== '' && $this->workspace() !== '' && $this->project() !== '';
    }

    public function workspace(): string
    {
        return trim((string) config('services.roboflow.workspace', ''));
    }

    public function project(): string
    {
        return trim((string) config('services.roboflow.project', ''));
    }

    public function modelType(): string
    {
        return trim((string) config('services.roboflow.model_type', 'yolov11l')) ?: 'yolov11l';
    }

    public function speed(): string
    {
        return trim((string) config('services.roboflow.speed', 'fast')) ?: 'fast';
    }

    public function epochs(): int
    {
        $epochs = (int) config('services.roboflow.epochs', 350);

        return $epochs > 0 ? $epochs : 350;
    }

    /**
     * @return array<string, mixed>
     */
    public function preprocessing(): array
    {
        $stored = config('services.roboflow.preprocessing');

        return is_array($stored) ? $stored : [
            'auto-orient' => true,
            'resize' => ['width' => 640, 'height' => 640, 'format' => 'Stretch to'],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    public function augmentation(): array
    {
        $stored = config('services.roboflow.augmentation');

        return is_array($stored) ? $stored : [];
    }

    /**
     * @return array{id: string, duplicate: bool}
     */
    public function uploadImage(string $filename, string $bytes, string $mime, string $split): array
    {
        $url = $this->apiUrl('/dataset/'.$this->project().'/upload', [
            'batch' => 'coastal-hitl',
        ]);
        $response = $this->http()->timeout(120)
            ->retry(2, 800)
            ->attach('file', $bytes, $filename, ['Content-Type' => $mime])
            ->post($url, [
                'name' => $filename,
                'split' => $split === 'val' ? 'valid' : $split,
            ]);
        $json = $this->json($response, 'upload image');
        $id = (string) ($json['id'] ?? $json['image']['id'] ?? '');
        if ($id === '' && empty($json['duplicate']) && empty($json['success'])) {
            throw new RuntimeException($this->errorMessage($json, 'Roboflow did not return an image id.'));
        }
        if ($id === '') {
            $id = sha1($filename);
        }

        return [
            'id' => $id,
            'duplicate' => (bool) ($json['duplicate'] ?? false),
        ];
    }

    /**
     * @param  array<string, string>  $labelmap
     */
    public function saveAnnotation(string $imageId, string $filename, string $yolo, array $labelmap): void
    {
        $url = $this->apiUrl('/dataset/'.$this->project().'/annotate/'.$imageId, [
            'name' => $filename,
            'overwrite' => 'true',
        ]);
        $response = $this->http()->timeout(60)
            ->retry(2, 800)
            ->asJson()
            ->post($url, [
                'annotationFile' => $yolo,
                'labelmap' => $labelmap,
            ]);
        if ($response->status() === 409) {
            return;
        }
        $json = $this->json($response, 'save annotation');
        if (! empty($json['error'])) {
            throw new RuntimeException($this->errorMessage($json, 'Annotation upload failed.'));
        }
    }

    public function generateVersion(): int
    {
        $url = $this->apiUrl('/'.$this->workspace().'/'.$this->project().'/generate');
        $response = $this->http()->timeout(120)
            ->asJson()
            ->post($url, [
                'preprocessing' => $this->preprocessing(),
                'augmentation' => $this->augmentation(),
            ]);
        $json = $this->json($response, 'create dataset version');
        $version = $json['version'] ?? null;
        if (! is_numeric($version)) {
            throw new RuntimeException($this->errorMessage($json, 'Roboflow did not return a dataset version.'));
        }

        return (int) $version;
    }

    public function downloadTrainedWeights(int $version): string
    {
        $url = $this->apiUrl('/'.$this->workspace().'/'.$this->project().'/'.$version.'/ptFile');
        $response = $this->http()->timeout(60)->get($url);
        $json = $this->safeJson($response);
        $weightsUrl = is_string($json['weightsUrl'] ?? null) ? $json['weightsUrl'] : '';
        if ($weightsUrl !== '') {
            $file = $this->http()->timeout(180)->get($weightsUrl);
            if (! $file->successful()) {
                throw new RuntimeException('Roboflow weight download failed.');
            }

            return $file->body();
        }
        $body = $response->body();
        if ($response->successful() && strlen($body) > 100000 && ! str_starts_with(ltrim($body), '{')) {
            return $body;
        }

        throw new RuntimeException($this->errorMessage(
            $json,
            'Roboflow did not return trained weights. The account may not allow a weight download.'
        ));
    }

    public function startTraining(int $version, ?string $modelType = null, ?string $speed = null, ?int $epochs = null): void
    {
        $this->exportForTraining($version);
        $url = $this->apiUrl('/'.$this->workspace().'/'.$this->project().'/'.$version.'/train', [
            'nocache' => 'true',
        ]);
        $response = $this->http()->timeout(60)
            ->asJson()
            ->post($url, [
                'speed' => $speed ?: $this->speed(),
                'modelType' => $modelType ?: $this->modelType(),
                'epochs' => $epochs ?: $this->epochs(),
            ]);
        if (! $response->successful()) {
            throw new RuntimeException($this->errorMessage($this->safeJson($response), 'Roboflow could not start training. The account plan may not allow API training.'));
        }
    }

    /**
     * YOLOv11 Large trains from the yolov5pytorch export of the version.
     */
    public function exportForTraining(int $version): void
    {
        $url = $this->apiUrl('/'.$this->workspace().'/'.$this->project().'/'.$version.'/yolov5pytorch');
        $last = [];
        for ($attempt = 0; $attempt < 8; $attempt++) {
            $response = $this->http()->timeout(60)->get($url);
            $last = $this->safeJson($response);
            $link = $last['export']['link'] ?? $last['link'] ?? null;
            if ($response->successful() && is_string($link) && $link !== '') {
                return;
            }
            if (! $response->successful() && $response->status() !== 404 && $response->status() !== 202) {
                throw new RuntimeException($this->errorMessage($last, 'Roboflow could not export this version for training.'));
            }
            sleep(5);
        }

        throw new RuntimeException($this->errorMessage($last, 'Roboflow is still preparing the training export. Try again in a minute.'));
    }

    /**
     * @return array<string, mixed>
     */
    public function versionStatus(int $version): array
    {
        $url = $this->apiUrl('/'.$this->workspace().'/'.$this->project().'/'.$version);
        $response = $this->http()->timeout(30)->get($url);
        $json = $this->json($response, 'read training status');

        return is_array($json) ? $json : [];
    }

    public function redact(string $text): string
    {
        $key = $this->apiKey();
        if ($key === '') {
            return $text;
        }

        return str_replace($key, '[redacted]', $text);
    }

    private function http(): \Illuminate\Http\Client\PendingRequest
    {
        return Http::withOptions([
            'verify' => (bool) config('services.roboflow.verify_ssl', true),
        ]);
    }

    private function apiKey(): string
    {
        return trim((string) config('services.roboflow.key', ''));
    }

    /**
     * @param  array<string, scalar>  $query
     */
    private function apiUrl(string $path, array $query = []): string
    {
        $base = rtrim((string) config('services.roboflow.base_url', 'https://api.roboflow.com'), '/');
        $query['api_key'] = $this->apiKey();

        return $base.$path.'?'.http_build_query($query);
    }

    /**
     * @return array<string, mixed>
     */
    private function json(Response $response, string $action): array
    {
        $json = $this->safeJson($response);
        if (! $response->successful()) {
            throw new RuntimeException($this->errorMessage($json, 'Roboflow could not '.$action.'.'));
        }

        return $json;
    }

    /**
     * @return array<string, mixed>
     */
    private function safeJson(Response $response): array
    {
        $json = $response->json();

        return is_array($json) ? $json : [];
    }

    /**
     * @param  array<string, mixed>  $json
     */
    private function errorMessage(array $json, string $fallback): string
    {
        $error = $json['error'] ?? $json['message'] ?? null;
        if (is_array($error)) {
            $error = $error['message'] ?? json_encode($error);
        }
        $text = is_string($error) && $error !== '' ? $error : $fallback;

        return $this->redact($text);
    }
}
