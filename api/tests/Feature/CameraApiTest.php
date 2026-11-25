<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CameraApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_operator_can_create_and_list_cameras(): void
    {
        $user = User::factory()->create();

        $create = $this->actingAs($user, 'sanctum')->postJson('/api/cameras', [
            'name' => 'Paco Shore Cam',
            'sector' => 'Sector B',
            'id' => 'CAM-01',
            'stream_url' => 'http://127.0.0.1:1990/api/stream.m3u8?src=cam01',
            'protocol' => 'WebRTC',
        ]);

        $create->assertCreated()
            ->assertJsonPath('id', 'CAM-01')
            ->assertJsonPath('name', 'Paco Shore Cam')
            ->assertJsonPath('sector', 'Sector B');

        $this->assertDatabaseHas('cameras', [
            'camera_code' => 'CAM-01',
            'camera_name' => 'Paco Shore Cam',
        ]);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/cameras')
            ->assertOk()
            ->assertJsonCount(1);
    }

    public function test_operator_can_delete_camera(): void
    {
        $user = User::factory()->create();
        Camera::query()->create([
            'camera_code' => 'CAM-09',
            'camera_name' => 'Temp',
            'monitoring_location' => 'Paco Beach',
        ]);

        $this->actingAs($user, 'sanctum')
            ->deleteJson('/api/cameras/CAM-09')
            ->assertOk();

        $this->assertDatabaseMissing('cameras', ['camera_code' => 'CAM-09']);
    }

    public function test_operator_can_delete_camera_that_has_detections(): void
    {
        $user = User::factory()->create();
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-07',
            'camera_name' => 'Temp',
            'monitoring_location' => 'Paco Beach',
        ]);
        $category = WasteCategory::query()->create(['category_name' => 'Plastic']);
        $classification = WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => 'Plastic Bottle',
        ]);
        Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);

        $this->actingAs($user, 'sanctum')
            ->deleteJson('/api/cameras/CAM-07')
            ->assertOk();

        $this->assertDatabaseMissing('cameras', ['camera_code' => 'CAM-07']);
        $this->assertDatabaseMissing('detections', ['camera_id' => $camera->id]);
    }

    public function test_operator_can_update_camera_and_it_persists(): void
    {
        $user = User::factory()->create();
        Camera::query()->create([
            'camera_code' => 'CAM-08',
            'camera_name' => 'Temp',
            'monitoring_location' => 'Paco Beach',
            'stream_url' => 'http://127.0.0.1:1990/api/stream.mp4?src=cam08',
            'protocol' => 'MSE',
        ]);

        $this->actingAs($user, 'sanctum')
            ->putJson('/api/cameras/CAM-08', [
                'name' => 'North dune cam',
                'sector' => 'Paco Beach',
                'stream_url' => 'http://127.0.0.1:1990/api/stream.mp4?src=cam08b',
            ])
            ->assertOk()
            ->assertJsonPath('name', 'North dune cam');

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/cameras')
            ->assertOk()
            ->assertJsonPath('0.name', 'North dune cam')
            ->assertJsonPath('0.stream_url', 'http://127.0.0.1:1990/api/stream.mp4?src=cam08b');
    }

    public function test_zoom_lenses_stay_stored_but_are_hidden_from_the_list(): void
    {
        $user = User::factory()->create();
        Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'stream_url' => 'http://127.0.0.1:1990/api/stream.mp4?src=cam01',
        ]);
        Camera::query()->create([
            'camera_code' => 'CAM-02',
            'camera_name' => 'Second Lens',
            'monitoring_location' => 'Paco Beach',
            'stream_url' => 'http://127.0.0.1:1990/api/stream.mp4?src=cam02',
        ]);
        Camera::query()->create([
            'camera_code' => 'CAM-04',
            'camera_name' => 'Paco Telephoto',
            'monitoring_location' => 'Paco Beach',
            'stream_url' => 'http://127.0.0.1:1990/api/stream.mp4?src=cam04',
        ]);

        $this->actingAs($user, 'sanctum')
            ->getJson('/api/cameras')
            ->assertOk()
            ->assertJsonCount(1)
            ->assertJsonPath('0.id', 'CAM-01');

        $this->assertDatabaseHas('cameras', ['camera_code' => 'CAM-02']);
        $this->assertDatabaseHas('cameras', ['camera_code' => 'CAM-04']);
    }
}
