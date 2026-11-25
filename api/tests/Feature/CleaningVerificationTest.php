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

/** The system never claims cleaning that nobody checked. */
class CleaningVerificationTest extends TestCase
{
    use RefreshDatabase;

    private Camera $camera;

    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
        SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
        $this->camera = Camera::query()->create(['camera_code' => 'CAM-01', 'camera_name' => 'Paco', 'monitoring_location' => 'Paco Beach', 'status' => 'Online']);
    }

    private function waste(string $status = Detection::PRESENT, array $extra = []): Detection
    {
        return Detection::query()->create([
            'camera_id' => $this->camera->id,
            'classification_id' => WasteClassifier::resolve('Plastic Bottle')->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'last_seen_at' => now(),
            'object_key' => uniqid('obj', true),
            'status' => $status,
            ...$extra,
        ]);
    }

    private function ingest(array $payload)
    {
        return $this->withHeader('X-Detector-Key', (string) config('services.detector.key'))
            ->postJson('/api/detections/live', ['camera_id' => 'CAM-01', 'detections' => [], ...$payload]);
    }

    public function test_status_labels(): void
    {
        $this->assertSame('Waste Detected', $this->waste()->statusLabel());
        $this->assertSame('Still Present', $this->waste(Detection::PRESENT, [
            'detected_at' => now()->subMinutes(5), 'last_seen_at' => now(),
        ])->statusLabel());
        $this->assertSame('No Longer Visible', $this->waste(Detection::NOT_VISIBLE)->statusLabel());
        $this->assertSame('Waste Detected', $this->waste(Detection::DETECTED)->statusLabel());
    }

    public function test_disappearance_is_no_longer_visible_never_cleaning_verified(): void
    {
        $row = $this->waste();
        // An older detector still sends "Confirmed Cleaned".
        $this->ingest(['status_updates' => [['detection_id' => $row->id, 'status' => 'Confirmed Cleaned']]])->assertOk();

        $this->assertSame(Detection::NOT_VISIBLE, $row->fresh()->status);
        $this->assertNull($row->fresh()->cleaning_verified_at);
    }

    public function test_administrator_verifies_cleaning_with_name_and_time(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'name' => 'Admin']);
        $gone = $this->waste(Detection::NOT_VISIBLE);
        $ignored = $this->waste(Detection::IGNORED);

        $this->actingAs($admin)->postJson('/api/detections/verify-cleaning', ['ids' => [$gone->id, $ignored->id]])
            ->assertOk()
            ->assertJsonPath('verified', [$gone->id])
            ->assertJsonPath('verified_by', 'Admin');

        $fresh = $gone->fresh();
        $this->assertSame(Detection::VERIFIED, $fresh->status);
        $this->assertSame($admin->id, $fresh->cleaning_verified_by);
        $this->assertNotNull($fresh->cleaning_verified_at);
        $api = $fresh->toApiArray();
        $this->assertSame('Cleaning Verified', $api['status_label']);
        $this->assertSame('Admin', $api['cleaning_verified_by']);
        $this->assertSame(Detection::IGNORED, $ignored->fresh()->status);
    }

    public function test_only_inspector_or_administrator_can_verify(): void
    {
        $staff = User::factory()->create(['role' => 'Staff']);
        $row = $this->waste(Detection::NOT_VISIBLE);

        $this->actingAs($staff)->postJson('/api/detections/verify-cleaning', ['ids' => [$row->id]])->assertForbidden();
        $this->assertSame(Detection::NOT_VISIBLE, $row->fresh()->status);

        $inspector = User::factory()->create(['role' => 'Sanitary Inspector']);
        $this->actingAs($inspector)->postJson('/api/detections/verify-cleaning', ['ids' => [$row->id]])->assertOk();
        $this->assertSame(Detection::VERIFIED, $row->fresh()->status);
    }

    public function test_cameras_do_not_change_a_verified_record(): void
    {
        $row = $this->waste(Detection::VERIFIED, ['cleaning_verified_at' => now()]);

        $this->ingest(['visible_detection_ids' => [$row->id]])->assertOk();
        $this->ingest(['status_updates' => [['detection_id' => $row->id, 'status' => 'Present']]])->assertOk();

        $this->assertSame(Detection::VERIFIED, $row->fresh()->status);
    }

    public function test_stats_keep_inferred_and_verified_apart(): void
    {
        $this->waste(Detection::NOT_VISIBLE, ['removed_at' => now()]);
        $this->waste(Detection::NOT_VISIBLE, ['removed_at' => now()]);
        $this->waste(Detection::VERIFIED, ['removed_at' => now(), 'cleaning_verified_at' => now()]);

        $this->actingAs(User::factory()->create())->getJson('/api/stats/today')
            ->assertOk()
            ->assertJsonPath('no_longer_visible', 2)
            ->assertJsonPath('cleaning_verified', 1)
            ->assertJsonPath('cleaning_verified_today', 1);
    }
}
