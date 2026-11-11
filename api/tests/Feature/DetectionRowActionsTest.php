<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionImage;
use App\Models\MissedDetectionReport;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class DetectionRowActionsTest extends TestCase
{
    use RefreshDatabase;

    private function detection(): Detection
    {
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-02',
            'camera_name' => 'Telephoto',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $category = WasteCategory::query()->create(['category_name' => 'Plastic']);
        $classification = WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => 'Ecobag',
        ]);
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        Storage::disk('public')->put('detections/det-row.jpg', 'jpeg-bytes');
        DetectionImage::query()->create([
            'detection_id' => $detection->id,
            'image_path' => 'detections/det-row.jpg',
            'image_name' => 'det-row.jpg',
            'captured_at' => now(),
        ]);

        return $detection;
    }

    public function test_staff_cannot_delete_or_move_a_detection(): void
    {
        Storage::fake('public');
        $detection = $this->detection();
        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff@example.com']);

        $this->actingAs($staff)
            ->deleteJson('/api/detections/'.$detection->id)
            ->assertForbidden();
        $this->actingAs($staff)
            ->postJson('/api/detections/'.$detection->id.'/review')
            ->assertForbidden();
        $this->assertNotNull(Detection::query()->find($detection->id));
    }

    public function test_admin_deletes_only_the_selected_detection_and_its_snapshot(): void
    {
        Storage::fake('public');
        $detection = $this->detection();
        $other = Detection::query()->create([
            'camera_id' => $detection->camera_id,
            'classification_id' => $detection->classification_id,
            'confidence' => 81,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->actingAs($admin)
            ->deleteJson('/api/detections/'.$detection->id)
            ->assertOk()
            ->assertJsonPath('deleted', true)
            ->assertJsonPath('id', $detection->id);

        $this->assertNull(Detection::query()->find($detection->id));
        $this->assertNotNull(Detection::query()->find($other->id));
        $this->assertSame(0, DetectionImage::query()->where('detection_id', $detection->id)->count());
        Storage::disk('public')->assertMissing('detections/det-row.jpg');
    }

    public function test_move_to_review_keeps_the_detection_and_does_not_duplicate(): void
    {
        Storage::fake('public');
        $detection = $this->detection();
        $admin = User::factory()->create(['role' => 'Admin']);

        $first = $this->actingAs($admin)
            ->postJson('/api/detections/'.$detection->id.'/review')
            ->assertCreated();
        $second = $this->actingAs($admin)
            ->postJson('/api/detections/'.$detection->id.'/review')
            ->assertOk();

        $this->assertSame($first->json('id'), $second->json('id'));
        $this->assertSame(1, MissedDetectionReport::query()->count());
        $this->assertNotNull(Detection::query()->find($detection->id));
        $this->assertTrue((bool) Detection::query()->find($detection->id)->moved_to_review);

        $listed = $this->actingAs($admin)->getJson('/api/detections')->assertOk()->json();
        $this->assertNotContains($detection->id, array_column($listed, 'id'));

        $review = $this->actingAs($admin)->getJson('/api/missed-detections')->assertOk()->json('data');
        $this->assertSame($detection->id, $review[0]['source_detection_id'] ?? $review[0]['detection_id'] ?? null);
        $report = MissedDetectionReport::query()->first();
        $this->assertSame($detection->id, $report->source_detection_id);
        $this->assertSame('pending', $report->status);
        $this->assertStringContainsString('Ecobag', $report->description);
        Storage::disk('public')->assertExists($report->image_path);
        Storage::disk('public')->assertExists('detections/det-row.jpg');
    }
}
