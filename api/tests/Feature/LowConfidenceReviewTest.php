<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LowConfidenceReviewTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        \Illuminate\Support\Facades\Storage::fake('public');
    }

    public function test_low_confidence_known_class_is_queued_without_a_live_detection(): void
    {
        User::factory()->create(['role' => 'Admin', 'email' => 'admin-review@example.com']);
        Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);

        $created = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'Plastic Bottle',
                'reason' => 'low_confidence',
                'confidence' => 0.62,
                'x' => 0.10,
                'y' => 0.20,
                'width' => 0.30,
                'height' => 0.25,
                'image' => missed_jpeg(),
            ]);

        $created->assertCreated();
        $created->assertJsonPath('status', MissedDetectionReport::PENDING);
        $created->assertJsonPath('prediction', 'Plastic Bottle');
        $created->assertJsonPath('prediction_confidence', 0.62);
        $created->assertJsonPath('model_boxes.0.source', 'model');
        $created->assertJsonPath('model_boxes.0.class_name', 'Plastic Bottle');
        $created->assertJsonPath('annotations', []);
        $this->assertSame(0, Detection::query()->count());
        $this->assertSame(1, MissedDetectionReport::query()->count());

        $again = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'Plastic Bottle',
                'reason' => 'low_confidence',
                'confidence' => 0.64,
                'x' => 0.12,
                'y' => 0.21,
                'width' => 0.30,
                'height' => 0.25,
                'image' => missed_jpeg(),
            ]);
        $again->assertOk();
        $again->assertJsonPath('id', $created->json('id'));
        $this->assertSame(1, MissedDetectionReport::query()->count());

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'shoe',
                'reason' => 'low_confidence',
                'confidence' => 0.55,
                'x' => 0.40,
                'y' => 0.40,
                'width' => 0.20,
                'height' => 0.20,
                'image' => missed_jpeg(),
            ])->assertStatus(422);

        $list = $this->actingAs(User::query()->first())
            ->getJson('/api/missed-detections?status=pending');
        $list->assertOk();
        $this->assertSame($created->json('id'), $list->json('data.0.id'));
    }

    public function test_review_confidence_is_saved_for_the_detector(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->putJson('/api/settings', [
                'detection' => ['review_confidence' => 0.55],
            ])
            ->assertOk()
            ->assertJsonPath('detection.review_confidence', 0.55);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->getJson('/api/settings/detection')
            ->assertOk()
            ->assertJsonPath('review_confidence', 0.55);
    }
}
