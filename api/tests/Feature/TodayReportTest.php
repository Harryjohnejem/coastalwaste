<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\User;
use App\Support\WasteClassifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

class TodayReportTest extends TestCase
{
    use RefreshDatabase;

    public function test_today_report_counts_todays_detections(): void
    {
        // Noon, so "5 and 10 minutes ago" are still today even when tests run just after midnight.
        $this->travelTo(now()->startOfDay()->setTime(12, 0));
        Cache::flush();
        \App\Models\SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
        $user = User::factory()->create(['role' => 'Admin']);
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Paco Wide-Angle',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $bottle = WasteClassifier::resolve('Plastic Bottle');
        $make = fn (string $status, $at) => Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $bottle->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => $at,
            // Present waste is still on camera; it was last seen just now.
            'last_seen_at' => $status === 'Present' ? now() : $at,
            'removed_at' => $status === 'No Longer Visible' ? $at : null,
            'object_key' => uniqid('obj', true),
            'status' => $status,
        ]);
        $make('Present', now()->subMinutes(5));
        $make('No Longer Visible', now()->subMinutes(10));
        $make('Present', now()->subDays(2));

        $this->actingAs($user)->getJson('/api/reports/today')
            ->assertOk()
            ->assertJsonPath('kpis.detections.value', 2)
            ->assertJsonPath('kpis.cleaned.value', 1)
            ->assertJsonPath('classes.0.name', 'Plastic Bottle')
            ->assertJsonPath('classes.0.count', 2)
            ->assertJsonPath('cameras.0.code', 'CAM-01')
            ->assertJsonPath('cameras.0.today', 2)
            // No live stream in the test: nothing is on camera right now.
            ->assertJsonPath('cameras.0.count', 0);
    }

    public function test_today_report_needs_sign_in(): void
    {
        $this->getJson('/api/reports/today')->assertUnauthorized();
    }

    public function test_today_report_is_for_admins_only(): void
    {
        $staff = User::factory()->create(['role' => 'Staff']);
        $this->actingAs($staff)->getJson('/api/reports/today')->assertForbidden();
    }
}
