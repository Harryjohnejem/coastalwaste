<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DetectionIngestTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        \App\Models\SystemSetting::saveDefault(['detection' => ['enabled' => true]]);

        Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Paco Shore',
            'monitoring_location' => 'Sector B',
            'status' => 'Offline',
        ]);

        $plastic = WasteCategory::query()->create([
            'category_name' => 'Plastic',
            'description' => 'Plastic coastal waste',
        ]);

        WasteClassification::query()->create([
            'category_id' => $plastic->id,
            'waste_type' => 'Plastic Bottle',
        ]);
    }

    public function test_ingest_rejects_missing_detector_key(): void
    {
        $this->postJson('/api/detections/live', [
            'camera_id' => 'CAM-01',
            'boxes' => [],
        ])->assertUnauthorized();
    }

    public function test_ingest_stores_overlay_and_detection_log(): void
    {
        $response = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'boxes' => [[
                    'class' => 'plastic bottle',
                    'confidence' => 0.81,
                    'left' => 0.1,
                    'top' => 0.2,
                    'width' => 0.15,
                    'height' => 0.2,
                ]],
                'detections' => [[
                    'class' => 'plastic bottle',
                    'confidence' => 0.81,
                    'count' => 1,
                    'sector' => 'Sector B',
                ]],
                'inference_ms' => 42,
                'model' => 'yolov8s-worldv2.pt',
            ]);

        $response->assertOk()
            ->assertJsonPath('ok', true)
            ->assertJsonPath('boxes', 1)
            ->assertJsonPath('logged', 1);

        $this->assertDatabaseHas('detections', [
            'location' => 'Sector B',
            'quantity' => 1,
            'status' => 'Present',
        ]);

        $this->assertDatabaseHas('detection_logs', [
            'raw_label' => 'Plastic Bottle',
            'model_name' => 'yolov8s-worldv2.pt',
            'processing_time_ms' => 42,
        ]);

        $this->assertDatabaseHas('cameras', [
            'camera_code' => 'CAM-01',
            'status' => 'Online',
        ]);
    }

    public function test_ingest_unknown_camera_is_rejected_before_logging(): void
    {
        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-04',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.91,
                    'subtitle' => 'Track 9 · YOLO · CAM-04',
                ]],
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Camera not found.');

        $this->assertSame(0, \App\Models\Detection::query()->count());
    }
}
