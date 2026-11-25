<?php

namespace Tests\Feature;

use App\Models\SystemSetting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SettingsPersistenceTest extends TestCase
{
    use RefreshDatabase;

    public function test_saved_confidence_and_classes_round_trip(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->putJson('/api/settings', [
                'detection' => [
                    'confidence' => 0.85,
                    'classes' => ['Can', 'Plastic Bottle'],
                ],
                'recording' => [
                    'record_confidence' => 0.90,
                ],
            ])
            ->assertOk()
            ->assertJsonPath('detection.confidence', 0.85)
            ->assertJsonPath('recording.record_confidence', 0.90)
            ->assertJsonPath('detection.classes', ['Can', 'Plastic Bottle']);

        $this->actingAs($user)
            ->getJson('/api/settings')
            ->assertOk()
            ->assertJsonPath('detection.confidence', 0.85)
            ->assertJsonPath('recording.record_confidence', 0.90)
            ->assertJsonPath('detection.classes', ['Can', 'Plastic Bottle']);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->getJson('/api/settings/detection')
            ->assertOk()
            ->assertJsonPath('confidence', 0.85)
            ->assertJsonPath('recording.record_confidence', 0.90)
            // The detector always gets every class of the deployed model (a class
            // cannot be switched off from Settings), not the saved subset.
            ->assertJsonPath('classes', \App\Support\ClassRegistry::live())
            ->assertJsonPath('enabled', false);
    }

    public function test_detection_off_is_visible_to_the_detector(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->putJson('/api/settings', [
                'detection' => ['enabled' => false],
            ])
            ->assertOk()
            ->assertJsonPath('detection.enabled', false);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->getJson('/api/settings/detection')
            ->assertOk()
            ->assertJsonPath('enabled', false);
    }

    public function test_confidence_below_70_is_raised_to_default(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->putJson('/api/settings', [
                'detection' => ['confidence' => 0.20],
                'recording' => ['record_confidence' => 0.40],
            ])
            ->assertOk()
            ->assertJsonPath('detection.confidence', 0.80)
            ->assertJsonPath('recording.record_confidence', 0.80);

        $this->assertSame(
            0.80,
            SystemSetting::getDefault()['detection']['confidence']
        );
    }

    public function test_toggle_saves_only_enabled_and_keeps_other_settings(): void
    {
        $user = User::factory()->create(['role' => 'Admin']);
        $this->actingAs($user)
            ->putJson('/api/settings', [
                'detection' => ['enabled' => true, 'confidence' => 0.9],
                'station' => ['name' => 'Paco Station'],
            ])
            ->assertOk();

        $this->actingAs($user)
            ->putJson('/api/settings', ['detection' => ['enabled' => false]])
            ->assertOk()
            ->assertJsonPath('detection.enabled', false)
            ->assertJsonPath('detection.confidence', 0.9)
            ->assertJsonPath('station.name', 'Paco Station');
    }

    public function test_clip_recording_length_saves_only_offered_values(): void
    {
        $user = User::factory()->create(['role' => 'Admin']);

        $this->actingAs($user)->getJson('/api/settings')
            ->assertOk()
            ->assertJsonPath('recording.clip_max_seconds', 60);

        $this->actingAs($user)
            ->putJson('/api/settings', ['recording' => ['clip_max_seconds' => 300]])
            ->assertOk()
            ->assertJsonPath('recording.clip_max_seconds', 300)
            ->assertJsonPath('recording.record_confidence', 0.8);

        $this->actingAs($user)
            ->putJson('/api/settings', ['recording' => ['clip_max_seconds' => 9999]])
            ->assertOk()
            ->assertJsonPath('recording.clip_max_seconds', 60);
    }

    public function test_camera_fusion_setting_is_removed(): void
    {
        $user = User::factory()->create(['role' => 'Admin']);

        // An old saved value is dropped, and the detector no longer gets one.
        $this->actingAs($user)
            ->putJson('/api/settings', ['detection' => ['fusion' => ['enabled' => true]]])
            ->assertOk()
            ->assertJsonMissingPath('detection.fusion');

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->getJson('/api/settings/detection')
            ->assertOk()
            ->assertJsonMissingPath('fusion');
    }
}
