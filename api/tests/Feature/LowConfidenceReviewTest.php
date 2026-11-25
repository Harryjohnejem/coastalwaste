<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;

class LowConfidenceReviewTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        \Illuminate\Support\Facades\Storage::fake('public');
    }

    public function test_low_confidence_known_class_is_not_added_to_detection_reviews(): void
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
                'label' => 'Can',
                'reason' => 'low_confidence',
                'confidence' => 0.68,
                'x' => 0.40,
                'y' => 0.50,
                'width' => 0.06,
                'height' => 0.09,
                'image' => new UploadedFile(dirname(__DIR__).'/fixtures/pixel.jpg', 'frame.jpg', 'image/jpeg', null, true),
            ]);

        $created->assertOk();
        $created->assertJsonPath('queued', false);
        $this->assertSame(0, Detection::query()->count());
        $this->assertSame(0, MissedDetectionReport::query()->count());
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
