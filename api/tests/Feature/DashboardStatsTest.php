<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DashboardStatsTest extends TestCase
{
    use RefreshDatabase;

    public function test_today_stats_count_each_detection_once(): void
    {
        $user = User::factory()->create();
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'CAM-01',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $category = WasteCategory::query()->create(['category_name' => 'Plastic']);
        $classification = WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => 'Plastic Bottle',
        ]);

        Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 4,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 70,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subDay(),
            'removed_at' => now(),
            'status' => 'Confirmed Cleaned',
            'removal_reason' => 'inferred_disappearance',
        ]);

        $response = $this->actingAs($user)->getJson('/api/stats/today');

        $response->assertOk();
        $response->assertJsonPath('total_detections', 2);
        $response->assertJsonPath('detections', 1);
        $response->assertJsonPath('present', 1);
        $response->assertJsonPath('confirmed_cleaned', 1);
        $response->assertJsonPath('confirmed_cleaned_today', 1);
        $this->assertNotNull($response->json('last_removed_at'));
    }

    public function test_composition_aggregates_without_loading_detection_logs(): void
    {
        $user = User::factory()->create();
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'CAM-01',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $category = WasteCategory::query()->create(['category_name' => 'Plastic']);
        $classification = WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => 'Plastic Bottle',
        ]);
        Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 90,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);

        $this->actingAs($user)->getJson('/api/stats/composition?range=all')
            ->assertOk()
            ->assertJsonFragment(['label' => 'Plastic']);
    }
}
