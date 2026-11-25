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

    protected function setUp(): void
    {
        parent::setUp();
        \App\Models\SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
    }

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
                    'status' => 'No Longer Visible',
                    'reason' => 'inferred_disappearance',
                    'last_seen_at' => now()->subSeconds(20)->toIso8601String(),
                ]],
            ])
            ->assertOk();

        $this->assertSame('No Longer Visible', $first->fresh()->status);
        $this->assertNotNull($first->fresh()->removed_at);
        $this->assertSame('Present', $second->fresh()->status);
        $this->assertSame(2, Detection::query()->count());

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [],
                'status_updates' => [[
                    'detection_id' => $first->id,
                    'status' => 'No Longer Visible',
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

    public function test_new_track_id_on_the_same_box_does_not_create_another_row(): void
    {
        $camera = $this->camera('CAM-01');
        $classification = $this->classification();
        $existing = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subSeconds(20),
            'last_seen_at' => now()->subSeconds(5),
            'status' => 'Present',
        ]);
        $existing->logs()->create([
            'frame_number' => 4,
            'model_name' => 'yolo',
            'model_version' => 'session-a',
            'raw_label' => 'Plastic Bottle',
            'confidence' => 88,
            'created_at' => now()->subSeconds(20),
        ]);
        $existing->observations()->create([
            'camera_id' => $camera->id,
            'track_id' => 4,
            'tracker_session' => 'session-a',
            'raw_label' => 'Plastic Bottle',
            'confidence' => 88,
            'box_left' => 20,
            'box_top' => 30,
            'box_width' => 12,
            'box_height' => 18,
            'observed_at' => now()->subSeconds(5),
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-a',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.90,
                    'subtitle' => 'Track 99 · YOLO · CAM-01',
                    'left' => 21,
                    'top' => 31,
                    'width' => 12,
                    'height' => 18,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $this->assertSame(1, Detection::query()->count());
        $this->assertSame($existing->id, Detection::query()->value('id'));
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
                    'status' => 'No Longer Visible',
                    'last_seen_at' => now()->subMinute()->toIso8601String(),
                    'reason' => 'inferred_disappearance',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('presence.0.result', 'stale');

        $this->assertSame('Present', $existing->fresh()->status);
    }

    public function test_visible_heartbeat_marks_stale_present_as_cleaned(): void
    {
        $camera = $this->camera('CAM-01');
        $classification = $this->classification();
        $gone = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinutes(2),
            'last_seen_at' => now()->subSeconds(30),
            'status' => 'Present',
        ]);
        $stillThere = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 81,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'last_seen_at' => now()->subSeconds(30),
            'status' => 'Present',
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [],
                'visible_detection_ids' => [$stillThere->id],
            ])
            ->assertOk();

        $this->assertSame('No Longer Visible', $gone->fresh()->status);
        $this->assertNotNull($gone->fresh()->removed_at);
        $this->assertSame('Present', $stillThere->fresh()->status);
        $this->assertNotNull($stillThere->fresh()->last_seen_at);
        $this->assertTrue($stillThere->fresh()->last_seen_at->greaterThan(now()->subSeconds(2)));
    }
}
