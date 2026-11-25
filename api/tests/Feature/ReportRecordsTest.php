<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\User;
use App\Support\WasteClassifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** Reports read every record, not only the newest 1000. */
class ReportRecordsTest extends TestCase
{
    use RefreshDatabase;

    public function test_returns_every_record_past_the_list_limit(): void
    {
        $user = User::factory()->create(['role' => 'Admin']);
        $camera = Camera::query()->create(['camera_code' => 'CAM-02', 'camera_name' => 'Paco', 'monitoring_location' => 'Paco Beach', 'status' => 'Online']);
        $bottle = WasteClassifier::resolve('Plastic Bottle');
        $rows = [];
        for ($i = 0; $i < 1005; $i++) {
            $at = now()->subMinutes($i)->format('Y-m-d H:i:s');
            $rows[] = [
                'camera_id' => $camera->id, 'classification_id' => $bottle->id, 'confidence' => 85, 'quantity' => 1,
                'location' => 'Paco Beach', 'detected_at' => $at, 'object_key' => 'obj'.$i,
                'status' => 'No Longer Visible', 'created_at' => $at, 'updated_at' => $at,
            ];
        }
        foreach (array_chunk($rows, 200) as $chunk) {
            DB::table('detections')->insert($chunk);
        }
        Detection::query()->first()->update(['status' => 'Ignored']);

        $this->actingAs($user)->getJson('/api/reports/records')
            ->assertOk()
            ->assertJsonCount(1004)
            ->assertJsonPath('0.class', 'Plastic Bottle')
            ->assertJsonPath('0.camera_id', 'CAM-02')
            ->assertJsonPath('0.confidence', 0.85);
    }

    public function test_needs_sign_in(): void
    {
        $this->getJson('/api/reports/records')->assertUnauthorized();
    }
}
