<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DetectionPresenceTest extends TestCase
{
    use RefreshDatabase;

    private function camera(string $code): Camera
    {
        return Camera::query()->create([
            'camera_code' => $code,
            'camera_name' => $code,
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
    }

    private function classification(): WasteClassification
    {
        $category = WasteCategory::query()->create([
            'category_name' => 'Plastic',
        ]);

        return WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => 'Plastic Bottle',
        ]);
    }

    public function test_disappearance_updates_only_the_requested_record(): void
    {
        $camera = $this->camera('CAM-01');
        $classification = $this->classification();
        $first = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'last_seen_at' => now()->subSeconds(20),
            'status' => 'Present',
        ]);
        $second = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 77,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'last_seen_at' => now(),
            'status' => 'Present',
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [],
                'status_updates' => [[
                    'detection_id' => $first->id,
                    'status' => 'Confirmed Cleaned',
                    'reason' => 'inferred_disappearance',
                    'last_seen_at' => now()->subSeconds(20)->toIso8601String(),
                ]],
            ])
            ->assertOk();

        $this->assertSame('Confirmed Cleaned', $first->fresh()->status);
        $this->assertNotNull($first->fresh()->removed_at);
        $this->assertSame('Present', $second->fresh()->status);
        $this->assertSame(2, Detection::query()->count());

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [],
                'status_updates' => [[
                    'detection_id' => $first->id,
                    'status' => 'Confirmed Cleaned',
                    'reason' => 'inferred_disappearance',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('presence.0.result', 'unchanged');
    }

    public function test_other_camera_does_not_merge_into_the_original_record(): void
    {
        $firstCamera = $this->camera('CAM-01');
        $this->camera('CAM-02');
        $classification = $this->classification();
        $histogram = array_fill(0, 16, 1 / 16);
        $existing = Detection::query()->create([
            'camera_id' => $firstCamera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subSeconds(10),
            'last_seen_at' => now()->subSeconds(10),
            'status' => 'Present',
            'object_key' => '11111111-1111-1111-1111-111111111111',
        ]);
        $existing->observations()->create([
            'camera_id' => $firstCamera->id,
            'track_id' => 4,
            'tracker_session' => 'cam1',
            'raw_label' => 'Plastic Bottle',
            'confidence' => 80,
            'histogram' => $histogram,
            'observed_at' => now()->subSeconds(10),
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-02',
                'tracker_session' => 'cam2',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 9 · YOLO · CAM-02',
                    'histogram' => $histogram,
                ]],
            ])
            ->assertOk();

        $this->assertSame(2, Detection::query()->count());
        $this->assertSame('Present', $existing->fresh()->status);
        $this->assertNull($existing->fresh()->removed_at);
        $this->assertSame(1, $existing->observations()->count());
    }

    public function test_live_ingest_ignores_classes_outside_the_dataset(): void
    {
        $this->camera('CAM-01');
        $this->classification();

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [[
                    'class' => 'shoe',
                    'confidence' => 0.91,
                    'subtitle' => 'Track 3 · YOLO · CAM-01',
                ]],
            ])
            ->assertOk();

        $this->assertSame(0, Detection::query()->count());
    }

    public function test_newer_camera_two_observation_blocks_a_stale_clean(): void
    {
        $firstCamera = $this->camera('CAM-01');
        $secondCamera = $this->camera('CAM-02');
        $classification = $this->classification();
        $existing = Detection::query()->create([
            'camera_id' => $firstCamera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinute(),
            'last_seen_at' => now(),
            'status' => 'Present',
        ]);
        $existing->observations()->create([
            'camera_id' => $secondCamera->id,
            'track_id' => 9,
            'tracker_session' => 'cam2',
            'raw_label' => 'Plastic Bottle',
            'confidence' => 80,
            'histogram' => [1, 0],
            'observed_at' => now(),
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [],
                'status_updates' => [[
                    'detection_id' => $existing->id,
                    'status' => 'Confirmed Cleaned',
                    'last_seen_at' => now()->subMinute()->toIso8601String(),
                    'reason' => 'inferred_disappearance',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('presence.0.result', 'stale');

        $this->assertSame('Present', $existing->fresh()->status);
    }
}
