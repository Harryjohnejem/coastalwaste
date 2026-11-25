<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\SystemSetting;
use App\Models\User;
use App\Support\WasteClassifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

/** Every page must agree with the live cameras, even if the detector stops sending. */
class PresenceSweepTest extends TestCase
{
    use RefreshDatabase;

    private function present(Camera $camera, $lastSeen): Detection
    {
        return Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => WasteClassifier::resolve('Plastic Bottle')->id,
            'confidence' => 90,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinutes(10),
            'last_seen_at' => $lastSeen,
            'object_key' => uniqid('obj', true),
            'status' => 'Present',
        ]);
    }

    private function camera(): Camera
    {
        return Camera::query()->create([
            'camera_code' => 'CAM-01', 'camera_name' => 'Paco', 'monitoring_location' => 'Paco Beach', 'status' => 'Online',
        ]);
    }

    public function test_waste_not_seen_for_a_while_is_no_longer_visible(): void
    {
        Cache::flush();
        SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
        $camera = $this->camera();
        $stale = $this->present($camera, now()->subMinutes(2));
        $fresh = $this->present($camera, now());

        $this->actingAs(User::factory()->create())->getJson('/api/stats/today')->assertOk()->assertJsonPath('present', 1);

        $this->assertSame('No Longer Visible', $stale->fresh()->status);
        $this->assertSame('inferred_disappearance', $stale->fresh()->removal_reason);
        $this->assertSame('Present', $fresh->fresh()->status);
    }

    public function test_turning_detection_off_marks_everything_no_longer_visible(): void
    {
        Cache::flush();
        SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
        $camera = $this->camera();
        $row = $this->present($camera, now());

        $this->actingAs(User::factory()->create(['role' => 'Admin']))
            ->putJson('/api/settings', ['detection' => ['enabled' => false]])
            ->assertOk();

        $this->assertSame('No Longer Visible', $row->fresh()->status);
        $this->assertSame('detection_off', $row->fresh()->removal_reason);
    }
}
