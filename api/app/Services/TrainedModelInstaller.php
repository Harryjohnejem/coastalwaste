<?php

namespace App\Services;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Symfony\Component\Process\Process;

class TrainedModelInstaller
{
    public function __construct(private RoboflowClient $roboflow) {}

    /**
     * Download the trained weights, export ONNX, and replace the live file.
     *
     * @return array{backup: ?string, reloaded: bool, live: string}
     */
    public function install(int $version): array
    {
        $bytes = $this->roboflow->downloadTrainedWeights($version);
        if (strlen($bytes) < 100000) {
            throw new RuntimeException('Roboflow returned a weight file that is too small to be a model.');
        }

        $dir = storage_path('app/training');
        File::ensureDirectoryExists($dir);
        $pt = $dir.DIRECTORY_SEPARATOR.'version-'.$version.'.pt';
        $onnxTmp = $dir.DIRECTORY_SEPARATOR.'version-'.$version.'.onnx';
        File::put($pt, $bytes);

        $python = (string) config('services.detector.python', 'python');
        $script = dirname(base_path()).DIRECTORY_SEPARATOR.'detector'.DIRECTORY_SEPARATOR.'install_trained_onnx.py';
        $process = new Process([$python, $script, $pt, $onnxTmp], null, self::pythonEnvironment());
        $process->setTimeout(180);
        $process->run();
        if (! $process->isSuccessful()) {
            $detail = trim($process->getErrorOutput()."\n".$process->getOutput());
            throw new RuntimeException($detail !== '' ? $detail : 'The trained weights could not be exported to ONNX.');
        }
        if (! is_file($onnxTmp) || filesize($onnxTmp) < 100000) {
            throw new RuntimeException('The exported ONNX file was empty.');
        }

        $live = $this->onnxPath();
        File::ensureDirectoryExists(dirname($live));
        $backup = null;
        if (is_file($live)) {
            $backupDir = dirname($live).DIRECTORY_SEPARATOR.'backups';
            File::ensureDirectoryExists($backupDir);
            $backup = $backupDir.DIRECTORY_SEPARATOR.now()->format('Ymd-His').'-best.onnx';
            File::copy($live, $backup);
        }
        File::copy($onnxTmp, $live);

        // The model's class names (the installer prints them), so new classes
        // become known to the whole system.
        $classes = [];
        if (preg_match('/^CLASSES_JSON=(\[.*\])\s*$/m', $process->getOutput(), $m)) {
            $decoded = json_decode($m[1], true);
            $classes = is_array($decoded) ? array_values(array_map('strval', $decoded)) : [];
        }

        return [
            'backup' => $backup,
            'reloaded' => $this->reloadDetector(),
            'live' => $live,
            'classes' => $classes,
        ];
    }

    /**
     * `php artisan serve` passes only PATH and SYSTEMROOT to web requests.
     * Python, torch and ultralytics also need a home folder, AppData and a
     * temp folder, so fill in the ones that are missing.
     *
     * @return array<string, string>
     */
    public static function pythonEnvironment(): array
    {
        $home = getenv('USERPROFILE') ?: getenv('HOME') ?: '';
        if ($home === '') {
            // e.g. C:\Users\Admin\coastal-waste-platform\api -> C:\Users\Admin
            $parts = array_values(array_filter(explode('/', str_replace(chr(92), '/', base_path())), 'strlen'));
            if (count($parts) >= 3 && strcasecmp($parts[1], 'Users') === 0) {
                $home = $parts[0].DIRECTORY_SEPARATOR.'Users'.DIRECTORY_SEPARATOR.$parts[2];
            }
        }
        if ($home === '') {
            $home = storage_path('app/python-home');
            File::ensureDirectoryExists($home);
        }
        $home = str_replace('/', DIRECTORY_SEPARATOR, $home);
        $temp = storage_path('app/python-tmp');
        File::ensureDirectoryExists($temp);
        $configDir = storage_path('app/ultralytics');
        File::ensureDirectoryExists($configDir);

        $wanted = [
            'USERPROFILE' => $home,
            'HOME' => $home,
            'HOMEDRIVE' => substr($home, 0, 2),
            'HOMEPATH' => substr($home, 2),
            'APPDATA' => $home.DIRECTORY_SEPARATOR.'AppData'.DIRECTORY_SEPARATOR.'Roaming',
            'LOCALAPPDATA' => $home.DIRECTORY_SEPARATOR.'AppData'.DIRECTORY_SEPARATOR.'Local',
            'TEMP' => $temp,
            'TMP' => $temp,
            'USERNAME' => basename($home),
            'YOLO_CONFIG_DIR' => $configDir,
            // Without SystemRoot, Python's socket/asyncio import fails with WinError 10106.
            'SYSTEMROOT' => getenv('SystemRoot') ?: (getenv('WINDIR') ?: 'C:'.DIRECTORY_SEPARATOR.'Windows'),
            'WINDIR' => getenv('WINDIR') ?: (getenv('SystemRoot') ?: 'C:'.DIRECTORY_SEPARATOR.'Windows'),
            'PYTHONIOENCODING' => 'utf-8',
        ];
        $env = [];
        foreach ($wanted as $key => $value) {
            $current = getenv($key);
            $env[$key] = ($current === false || $current === '') ? $value : $current;
        }

        return $env;
    }

    public function reloadDetector(): bool
    {
        try {
            $response = Http::timeout(90)
                ->withHeaders(['X-Detector-Key' => (string) config('services.detector.key')])
                ->post(rtrim((string) config('services.detector.url', 'http://127.0.0.1:8092'), '/').'/model/reload');

            return $response->successful();
        } catch (\Throwable) {
            return false;
        }
    }

    public function onnxPath(): string
    {
        $configured = trim((string) config('services.detector.onnx_path', ''));
        if ($configured !== '') {
            return $configured;
        }

        return dirname(base_path()).DIRECTORY_SEPARATOR.'detector'.DIRECTORY_SEPARATOR.'weights'.DIRECTORY_SEPARATOR.'trained'.DIRECTORY_SEPARATOR.'best.onnx';
    }
}
