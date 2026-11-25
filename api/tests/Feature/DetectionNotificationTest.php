<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\Notification;
use App\Models\SystemSetting;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use App\Support\DetectionNotifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DetectionNotificationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        // These tests cover the per-detection notice, which is off by default.
        SystemSetting::saveDefault(['detection' => ['enabled' => true], 'alerts' => ['detectionAlerts' => true]]);
    }

    public function test_no_notice_per_detection_when_the_setting_is_off(): void
    {
        SystemSetting::saveDefault(['detection' => ['enabled' => true], 'alerts' => ['detectionAlerts' => false]]);
        $this->admin();
        $this->camera();
        $this->classification();

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [['class' => 'Plastic Bottle', 'confidence' => 0.9, 'left' => 10, 'top' => 10, 'width' => 10, 'height' => 10]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $this->assertSame(0, \App\Models\Notification::query()->count());
    }

    private function camera(): Camera
    {
        return Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Pier Overlook',
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

    private function admin(): User
    {
        return User::factory()->create([
            'role' => 'Admin',
            'email' => 'admin@example.com',
        ]);
    }

    public function test_live_ingest_creates_one_notification_for_a_new_detection(): void
    {
        $this->camera();
        $this->classification();
        $admin = $this->admin();

        $response = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-a',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 12 · YOLO · CAM-01',
                    'sector' => 'Paco Beach',
                ]],
            ]);
        $response->assertOk()
            ->assertJsonPath('logged', 1)
            ->assertJsonPath('detections.0.subtitle', 'Track 12');
        $this->assertArrayNotHasKey('snapshot_url', $response->json('detections.0'));

        $this->assertSame(1, Detection::query()->count());
        $this->assertSame(1, Notification::query()->count());

        $note = Notification::query()->first();
        $this->assertSame($admin->id, $note->user_id);
        $this->assertSame('New Waste Detection', $note->title);
        $this->assertFalse($note->is_read);
        $this->assertStringContainsString('Plastic Bottle', $note->message);
        $this->assertStringContainsString('Paco Beach', $note->message);
        $this->assertStringContainsString('Pier Overlook', $note->message);
        $this->assertSame(Detection::query()->value('id'), $note->detection_id);
    }

    public function test_retrying_the_same_track_does_not_duplicate_notifications(): void
    {
        $this->camera();
        $this->classification();
        $this->admin();

        $payload = [
            'camera_id' => 'CAM-01',
            'tracker_session' => 'session-a',
            'detections' => [[
                'class' => 'Plastic Bottle',
                'confidence' => 0.86,
                'subtitle' => 'Track 12 · YOLO · CAM-01',
                'sector' => 'Paco Beach',
            ]],
        ];

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', $payload)
            ->assertOk();

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', $payload)
            ->assertOk();

        $this->assertSame(1, Detection::query()->count());
        $this->assertSame(1, Notification::query()->count());
    }

    public function test_notifier_is_idempotent_for_the_same_detection(): void
    {
        $camera = $this->camera();
        $classification = $this->classification();
        $this->admin();
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);

        DetectionNotifier::notifyNewDetection($detection);
        DetectionNotifier::notifyNewDetection($detection);

        $this->assertSame(1, Notification::query()->count());
    }

    public function test_status_only_updates_do_not_create_notifications(): void
    {
        $camera = $this->camera();
        $classification = $this->classification();
        $this->admin();
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'last_seen_at' => now()->subSeconds(20),
            'status' => 'Present',
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [],
                'status_updates' => [[
                    'detection_id' => $detection->id,
                    'status' => 'No Longer Visible',
                    'reason' => 'inferred_disappearance',
                ]],
            ])
            ->assertOk();

        $this->assertSame(0, Notification::query()->count());
    }

    public function test_authenticated_user_can_list_and_mark_notifications_read(): void
    {
        $admin = $this->admin();
        $camera = $this->camera();
        $classification = $this->classification();
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        DetectionNotifier::notifyNewDetection($detection);
        $note = Notification::query()->first();

        $this->actingAs($admin)
            ->getJson('/api/notifications')
            ->assertOk()
            ->assertJsonPath('unread', 1)
            ->assertJsonPath('notifications.0.id', $note->id);

        $this->actingAs($admin)
            ->postJson('/api/notifications/'.$note->id.'/read')
            ->assertOk()
            ->assertJsonPath('is_read', true);

        $this->actingAs($admin)
            ->getJson('/api/notifications')
            ->assertOk()
            ->assertJsonPath('unread', 0);
    }

    public function test_guest_cannot_list_notifications(): void
    {
        $this->getJson('/api/notifications')->assertUnauthorized();
    }

    public function test_user_cannot_mark_another_users_notification_read(): void
    {
        $admin = $this->admin();
        $other = User::factory()->create(['role' => 'Admin', 'email' => 'other@example.com']);
        $camera = $this->camera();
        $classification = $this->classification();
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        DetectionNotifier::notifyNewDetection($detection);
        $note = Notification::query()->where('user_id', $admin->id)->first();

        $this->actingAs($other)
            ->postJson('/api/notifications/'.$note->id.'/read')
            ->assertForbidden();
    }

    public function test_live_ingest_does_not_record_when_detection_is_off(): void
    {
        $this->camera();
        $this->classification();
        SystemSetting::saveDefault([
            'detection' => ['enabled' => false],
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-off',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.91,
                    'subtitle' => 'Track 4 · YOLO · CAM-01',
                    'sector' => 'Paco Beach',
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 0)
            ->assertJsonPath('paused', true);

        $this->assertSame(0, Detection::query()->count());
        $this->assertSame(0, Notification::query()->count());
    }
}
