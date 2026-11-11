<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionImage;
use App\Models\DetectionLog;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class DetectionSnapshotTest extends TestCase
{
    use RefreshDatabase;

    private function camera(): Camera
    {
        return Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
    }

    private function classification(string $type = 'Plastic Bottle'): WasteClassification
    {
        $category = WasteCategory::query()->firstOrCreate(['category_name' => 'Plastic']);

        return WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => $type,
        ]);
    }

    public function test_detection_list_returns_present_and_confirmed_cleaned_rows(): void
    {
        $camera = $this->camera();
        $classification = $this->classification();
        $admin = User::factory()->create(['role' => 'Admin']);
        $present = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        $cleaned = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 84,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinute(),
            'status' => 'Confirmed Cleaned',
        ]);

        $this->actingAs($admin)
            ->getJson('/api/detections')
            ->assertOk()
            ->assertJsonFragment(['id' => $present->id, 'status' => 'Present'])
            ->assertJsonFragment(['id' => $cleaned->id, 'status' => 'Confirmed Cleaned']);
    }

    public function test_live_query_returns_only_the_selected_cameras_present_rows(): void
    {
        $camera = $this->camera();
        $other = Camera::query()->create([
            'camera_code' => 'CAM-02',
            'camera_name' => 'Second Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $classification = $this->classification();
        $admin = User::factory()->create(['role' => 'Admin']);
        $here = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        Detection::query()->create([
            'camera_id' => $other->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinute(),
            'status' => 'Confirmed Cleaned',
        ]);

        $response = $this->actingAs($admin)
            ->getJson('/api/detections?camera_id=CAM-01&status=Present')
            ->assertOk()
            ->json();

        $this->assertCount(1, $response);
        $this->assertSame($here->id, $response[0]['id']);
        $this->assertSame('Present', $response[0]['status']);
        $this->assertSame('CAM-01', $response[0]['camera_id']);
    }

    public function test_api_keeps_styrofoam_class_and_plastic_category(): void
    {
        $camera = $this->camera();
        $classification = $this->classification('Styrofoam');
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 90,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        DetectionLog::query()->create([
            'detection_id' => $detection->id,
            'raw_label' => 'Styrofoam',
            'confidence' => 90,
            'model_name' => 'YOLOv11n ONNX · best.onnx',
            'created_at' => now(),
        ]);

        $payload = $detection->fresh()->toApiArray();

        $this->assertSame('Styrofoam', $payload['class']);
        $this->assertSame('Plastic', $payload['waste_category']);
        $this->assertNull($payload['snapshot_url']);
    }

    public function test_successful_snapshot_is_stored_and_linked(): void
    {
        Storage::fake('public');
        $this->camera();
        $this->classification();
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-snap',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 4 · YOLO · CAM-01',
                    'sector' => 'Paco Beach',
                    'snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $image = DetectionImage::query()->first();
        $this->assertNotNull($image);
        Storage::disk('public')->assertExists($image->image_path);
        $this->assertSame('/storage/'.$image->image_path, Detection::query()->first()->toApiArray()['snapshot_url']);
    }

    public function test_failed_snapshot_write_does_not_create_an_image_row(): void
    {
        $this->camera();
        $this->classification();
        $disk = new class
        {
            public function put(string $path, string $contents): bool
            {
                return false;
            }
        };
        Storage::shouldReceive('disk')->once()->with('public')->andReturn($disk);
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-snap-fail',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 8 · YOLO · CAM-01',
                    'sector' => 'Paco Beach',
                    'snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $this->assertSame(1, Detection::query()->count());
        $this->assertSame(0, DetectionImage::query()->count());
        $this->assertNull(Detection::query()->first()->toApiArray()['snapshot_url']);
    }
}
