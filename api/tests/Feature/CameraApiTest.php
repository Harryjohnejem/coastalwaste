<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\User;
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
}
