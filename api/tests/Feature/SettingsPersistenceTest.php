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
            ->assertJsonPath('classes', ['Can', 'Plastic Bottle'])
            ->assertJsonPath('enabled', true);
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
}
