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

    protected function setUp(): void
    {
        parent::setUp();
        \App\Models\SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
    }

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

    public function test_live_ingest_saves_the_live_dataset_name(): void
    {
        $this->seedCameraAndClass();
        \App\Support\LiveModel::save('Weights 10', 'YOLOv11l');

        $response = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'model' => 'YOLO11l ONNX · best.onnx',
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
        $this->assertSame('Weights 10', $detection->training_dataset);
        $this->assertSame('YOLOv11l', $detection->training_model);
        $this->assertSame(DatasetAttribution::LIVE_MODEL, $detection->dataset_attribution);

        $payload = $detection->toApiArray();
        $this->assertSame('CAM-01', $payload['detection_source']);
        $this->assertSame('YOLOv11l / Roboflow', $payload['dataset_attribution_label']);
        $this->assertSame('Weights 10', $payload['training_dataset_label']);

        // A later deploy changes the name for new detections only.
        \App\Support\LiveModel::save('local-ruwza-dgl85 v4', 'YOLOv11l');
        $this->assertSame('Weights 10', $detection->fresh()->toApiArray()['training_dataset_label']);
    }

    public function test_live_model_names_from_a_roboflow_job(): void
    {
        $this->assertSame('local-ruwza-dgl85 v4', \App\Support\LiveModel::datasetFromHostedModel('local-ruwza-dgl85/4', 4));
        $this->assertSame('YOLOv11l', \App\Support\LiveModel::modelName('yolov11', 'large'));
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
