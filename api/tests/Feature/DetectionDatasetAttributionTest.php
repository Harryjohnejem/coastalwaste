<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use App\Support\DatasetAttribution;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DetectionDatasetAttributionTest extends TestCase
{
    use RefreshDatabase;

    private function seedCameraAndClass(): Camera
    {
        WasteClassification::query()->create([
            'category_id' => WasteCategory::query()->create([
                'category_name' => 'Plastic',
            ])->id,
            'waste_type' => 'Plastic Bottle',
        ]);

        return Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
    }

    public function test_live_ingest_sets_combined_not_attributable(): void
    {
        $this->seedCameraAndClass();

        $response = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'model' => 'YOLOv11n ONNX · best.onnx',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'count' => 1,
                    'sector' => 'Paco Beach',
                    'subtitle' => 'Track 42 · YOLO · CAM-01 · cam01',
                ]],
            ]);

        $response->assertOk();
        $detection = Detection::query()->first();
        $this->assertNotNull($detection);
        $this->assertSame(
            DatasetAttribution::TRAINING_COMBINED,
            $detection->training_dataset,
        );
        $this->assertSame(
            DatasetAttribution::COMBINED_NOT_ATTRIBUTABLE,
            $detection->dataset_attribution,
        );

        $payload = $detection->toApiArray();
        $this->assertSame('CAM-01', $payload['detection_source']);
        $this->assertSame(
            'Combined Model — Source Not Attributable',
            $payload['dataset_attribution_label'],
        );
        // Must not invent Local 1 / Local 2 from the prediction.
        $this->assertNotSame('Local 1', $payload['dataset_attribution_label']);
        $this->assertNotSame('Local 2', $payload['dataset_attribution_label']);
    }

    public function test_legacy_null_attribution_exposes_unknown_without_backfill(): void
    {
        $camera = $this->seedCameraAndClass();
        $classification = WasteClassification::query()->first();
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Detected',
            'training_dataset' => null,
            'dataset_attribution' => null,
        ]);

        $payload = $detection->toApiArray();
        $this->assertSame(DatasetAttribution::UNKNOWN, $payload['dataset_attribution']);
        $this->assertSame('Unknown / Not Attributable', $payload['dataset_attribution_label']);
        $this->assertNull($detection->fresh()->dataset_attribution);
    }
}
