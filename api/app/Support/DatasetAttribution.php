<?php

namespace App\Support;

/**
 * Honest training-dataset attribution for detections.
 *
 * Local 1 (CCTV) and Local 2 (online) were merged into one YOLO model.
 * A single prediction does not reveal which subset contributed — never invent
 * Local 1 / Local 2 from class, confidence, box, or timestamp.
 */
final class DatasetAttribution
{
    public const LOCAL_1 = 'local_1';

    public const LOCAL_2 = 'local_2';

    public const COMBINED_NOT_ATTRIBUTABLE = 'combined_not_attributable';

    public const UNKNOWN = 'unknown';

    /** Saved with the live model's dataset name (see LiveModel). */
    public const LIVE_MODEL = 'live_model';

    /** Model metadata: both subsets trained together. */
    public const TRAINING_COMBINED = 'Combined (Local 1 + Local 2)';

    /**
     * Default for live CCTV detections using the merged YOLO model.
     *
     * @return array{training_dataset: string, dataset_attribution: string}
     */
    public static function forMergedModelLiveDetection(): array
    {
        return [
            'training_dataset' => self::TRAINING_COMBINED,
            'dataset_attribution' => self::COMBINED_NOT_ATTRIBUTABLE,
        ];
    }

    /**
     * Live CCTV detection: the dataset and model the cameras use right now.
     *
     * @return array{training_dataset: string, training_model: string, dataset_attribution: string}
     */
    public static function forLiveModel(): array
    {
        $live = LiveModel::current();

        return [
            'training_dataset' => $live['dataset'],
            'training_model' => $live['model'],
            'dataset_attribution' => self::LIVE_MODEL,
        ];
    }

    public static function normalize(?string $value): string
    {
        $raw = strtolower(trim((string) $value));
        return match ($raw) {
            self::LIVE_MODEL, 'live model' => self::LIVE_MODEL,
            self::LOCAL_1, 'local 1', 'local1' => self::LOCAL_1,
            self::LOCAL_2, 'local 2', 'local2' => self::LOCAL_2,
            self::COMBINED_NOT_ATTRIBUTABLE,
            'combined',
            'combined_model',
            'not_attributable',
            'combined model — source not attributable',
            'combined model - source not attributable' => self::COMBINED_NOT_ATTRIBUTABLE,
            self::UNKNOWN, '' => self::UNKNOWN,
            default => self::UNKNOWN,
        };
    }

    public static function label(?string $value): string
    {
        return match (self::normalize($value)) {
            self::LOCAL_1 => 'Local 1',
            self::LOCAL_2 => 'Local 2',
            self::LIVE_MODEL => 'Live model',
            self::COMBINED_NOT_ATTRIBUTABLE => 'Combined Model — Source Not Attributable',
            default => 'Unknown / Not Attributable',
        };
    }

    public static function tooltip(?string $value): string
    {
        return match (self::normalize($value)) {
            self::LOCAL_1 => 'Attributed to Local 1 (CCTV / camera environment training images) by verified data lineage — not inferred from the prediction alone.',
            self::LOCAL_2 => 'Attributed to Local 2 (online-source training images) by verified data lineage — not inferred from the prediction alone.',
            self::COMBINED_NOT_ATTRIBUTABLE => 'The live model was trained on Local 1 + Local 2 merged together. Individual predictions cannot be attributed to either subset.',
            default => 'No verified training-dataset attribution is stored for this detection. Camera / Detection Source is separate and identifies which stream captured the frame.',
        };
    }

    /**
     * @return list<string>
     */
    public static function filterValues(): array
    {
        return [
            self::LIVE_MODEL,
            self::LOCAL_1,
            self::LOCAL_2,
            self::COMBINED_NOT_ATTRIBUTABLE,
            self::UNKNOWN,
        ];
    }
}
