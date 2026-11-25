<?php

namespace App\Support;

use App\Models\SystemSetting;

/**
 * The dataset and model the cameras use right now. Every new detection saves
 * these names, so Waste Detections shows which dataset produced it.
 * Deploy and Rollback keep it up to date.
 */
final class LiveModel
{
    public const SETTING_KEY = 'live_model';

    public const DEFAULT_DATASET = 'local-ortk7 v2';

    public const DEFAULT_MODEL = 'YOLOv11l';

    /** @return array{dataset: string, model: string} */
    public static function current(): array
    {
        $value = SystemSetting::query()->find(self::SETTING_KEY)?->value;
        $value = is_array($value) ? $value : [];
        $dataset = trim((string) ($value['dataset'] ?? ''));
        $model = trim((string) ($value['model'] ?? ''));

        return [
            'dataset' => $dataset !== '' ? $dataset : self::DEFAULT_DATASET,
            'model' => $model !== '' ? $model : self::DEFAULT_MODEL,
        ];
    }

    public static function save(string $dataset, string $model): void
    {
        SystemSetting::query()->updateOrCreate(
            ['key' => self::SETTING_KEY],
            ['value' => [
                'dataset' => trim($dataset) ?: self::DEFAULT_DATASET,
                'model' => trim($model) ?: self::DEFAULT_MODEL,
            ]],
        );
    }

    /** "local-ruwza-dgl85/4" -> "local-ruwza-dgl85 v4" */
    public static function datasetFromHostedModel(?string $hostedModelId, ?int $version): string
    {
        $id = trim((string) $hostedModelId);
        if ($id !== '' && str_contains($id, '/')) {
            [$project, $ver] = explode('/', $id, 2);

            return $project.' v'.$ver;
        }

        return $id !== '' ? $id : ($version ? 'Roboflow v'.$version : self::DEFAULT_DATASET);
    }

    /** "yolov11" + "large" -> "YOLOv11l" */
    public static function modelName(?string $architecture, ?string $size): string
    {
        $arch = strtolower((string) $architecture);
        $family = preg_match('/(\d+)/', $arch, $m) ? 'YOLOv'.ltrim($m[1], '0') : 'YOLO';
        $letter = [
            'nano' => 'n', 'small' => 's', 'medium' => 'm', 'large' => 'l', 'xlarge' => 'x', 'extra large' => 'x',
        ][strtolower((string) $size)] ?? '';

        return $family.$letter;
    }
}
