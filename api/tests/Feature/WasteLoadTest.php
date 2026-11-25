<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\Notification;
use App\Models\SystemSetting;
use App\Models\User;
use App\Support\WasteClassifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

class WasteLoadTest extends TestCase
{
    use RefreshDatabase;

    private Camera $camera;

    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
        SystemSetting::saveDefault(['detection' => ['enabled' => true], 'alerts' => ['densityAlerts' => true, 'cleanupLimit' => 5, 'densityThreshold' => 60]]);
        $this->camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Paco Wide-Angle',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
    }

    private function addWaste(int $n, string $status = 'Present'): void
    {
        $bottle = WasteClassifier::resolve('Plastic Bottle');
        for ($i = 0; $i < $n; $i++) {
            Detection::query()->create([
                'camera_id' => $this->camera->id,
                'classification_id' => $bottle->id,
                'confidence' => 90,
                'quantity' => 1,
                'location' => 'Paco Beach',
                'detected_at' => now(),
                'last_seen_at' => now(),
                'object_key' => uniqid('obj', true),
                'status' => $status,
            ]);
        }
    }

    private function poll(User $user)
    {
        Cache::forget('waste-load:check-lock');
        Cache::forget('waste-load:status');

        return $this->actingAs($user)->getJson('/api/waste-load')->assertOk();
    }

    public function test_levels_follow_the_cleanup_limit(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->addWaste(2);
        $this->poll($admin)->assertJsonPath('level', 'normal')->assertJsonPath('warn_at', 3);

        $this->addWaste(1);
        $this->poll($admin)->assertJsonPath('level', 'warning')->assertJsonPath('cameras.0.count', 3);

        $this->addWaste(2);
        $this->poll($admin)->assertJsonPath('level', 'full')->assertJsonPath('cameras.0.percent', 100);
    }

    public function test_admin_is_alerted_once_per_level(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->addWaste(5);
        $this->poll($admin);
        $this->poll($admin);
        $this->assertSame(1, Notification::query()->where('title', 'Cleanup needed · CAM-01')->count());
        $this->assertSame('danger', Notification::query()->first()->type);

        // Slipping just under the limit must not alert again.
        Detection::query()->first()->update(['status' => 'No Longer Visible']);
        $this->poll($admin);
        $this->addWaste(1);
        $this->poll($admin);
        $this->assertSame(1, Notification::query()->count());
    }

    public function test_cleaning_below_warning_resets_and_reports_cleared(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $this->addWaste(5);
        $this->poll($admin);

        Detection::query()->update(['status' => 'No Longer Visible']);
        $this->poll($admin)->assertJsonPath('level', 'normal');
        $this->assertSame(1, Notification::query()->where('title', 'Back to normal · CAM-01')->count());

        $this->addWaste(5);
        $this->poll($admin);
        $this->assertSame(2, Notification::query()->where('title', 'Cleanup needed · CAM-01')->count());
    }

    public function test_full_level_holds_when_one_item_flickers(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $this->addWaste(5);
        $this->poll($admin)->assertJsonPath('level', 'full');

        // One item missed for a frame: 4 of 5 is still above the warning level (3).
        Detection::query()->first()->update(['status' => 'No Longer Visible']);
        $this->poll($admin)
            ->assertJsonPath('level', 'full')
            ->assertJsonPath('cameras.0.count', 4)
            ->assertJsonPath('cameras.0.level', 'full');
    }

    public function test_counts_the_boxes_shown_on_live_monitoring(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $this->addWaste(1);
        config(['services.detector.live_counts' => true, 'services.detector.url' => 'http://detector.test']);
        $box = fn (float $conf, $track = null, bool $prov = false) => [
            'class' => 'Plastic Bottle', 'confidence' => $conf, 'track_id' => $track, 'provisional' => $prov, 'camera_id' => 'CAM-01',
        ];
        \Illuminate\Support\Facades\Http::fake([
            'detector.test/*' => \Illuminate\Support\Facades\Http::response([
                'connected' => true,
                'overlay_age_ms' => 1200,
                'boxes' => [
                    $box(0.86, 1), $box(0.71, 2), $box(0.41, 3),   // tracked: drawn at any score
                    $box(0.55, null, true),                          // provisional, 50%+: drawn
                    $box(0.45, null, true), $box(0.70),              // not drawn
                ],
            ]),
        ]);

        $this->poll($admin)
            ->assertJsonPath('cameras.0.count', 4)
            ->assertJsonPath('cameras.0.source', 'live')
            ->assertJsonPath('cameras.0.level', 'warning');
    }

    public function test_alerts_can_be_turned_off(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        SystemSetting::saveDefault(['detection' => ['enabled' => true], 'alerts' => ['densityAlerts' => false, 'cleanupLimit' => 5]]);
        $this->addWaste(6);

        $this->poll($admin)->assertJsonPath('level', 'normal')->assertJsonPath('enabled', false);
        $this->assertSame(0, Notification::query()->count());
    }
}
