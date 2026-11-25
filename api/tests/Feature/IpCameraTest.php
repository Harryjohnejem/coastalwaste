<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class IpCameraTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        config(['services.go2rtc.base' => 'http://go2rtc.test', 'services.go2rtc.public_base' => 'http://go2rtc.test']);
        $this->admin = User::factory()->create(['role' => 'Admin']);
        // The two hand-configured cameras, as they are today.
        foreach (['CAM-01' => 'cam01', 'CAM-02' => 'cam02'] as $code => $src) {
            Camera::query()->create([
                'camera_code' => $code,
                'camera_name' => 'Paco Wide-Angle',
                'monitoring_location' => 'Paco Beach',
                'ip_address' => '192.168.1.'.substr($code, -1),
                'stream_url' => "http://127.0.0.1:1990/api/stream.mp4?src={$src}",
                'protocol' => 'MSE',
                'status' => 'Online',
            ]);
        }
    }

    private function jpeg(): string
    {
        return "\xFF\xD8".str_repeat('x', 2000);
    }

    public function test_adding_by_ip_registers_a_gateway_stream(): void
    {
        Http::fake(['go2rtc.test/*' => Http::response('', 200)]);

        $this->actingAs($this->admin)->postJson('/api/cameras', [
            'name' => 'Paco north',
            'sector' => 'Paco Beach',
            'ip_address' => '192.168.1.80',
            'rtsp_path' => '/stream1',
            'username' => 'camuser',
            'password' => 'p@ss:w/rd',
            'stream_url' => '',
        ])->assertCreated()
            ->assertJsonPath('id', 'CAM-03')
            ->assertJsonPath('managed', true)
            ->assertJsonPath('stream_url', 'http://go2rtc.test/api/stream.mp4?src=ipcam03')
            ->assertJsonMissingPath('password');

        Http::assertSent(function (Request $request) {
            if ($request->method() !== 'PUT') {
                return false;
            }
            parse_str(parse_url($request->url(), PHP_URL_QUERY), $q);

            return $q['name'] === 'ipcam03'
                && $q['src'] === 'rtsp://camuser:p%40ss%3Aw%2Frd@192.168.1.80:554/stream1#transport=tcp#timeout=5s';
        });

        // Stored encrypted, read back as plain text.
        $raw = DB::table('cameras')->where('camera_code', 'CAM-03')->value('password');
        $this->assertNotSame('p@ss:w/rd', $raw);
        $this->assertSame('p@ss:w/rd', Camera::query()->where('camera_code', 'CAM-03')->first()->password);
    }

    public function test_hand_configured_cameras_are_never_touched(): void
    {
        Http::fake(['go2rtc.test/*' => Http::response('', 200)]);

        $this->actingAs($this->admin)->putJson('/api/cameras/CAM-01', ['name' => 'Paco wide renamed'])
            ->assertOk()
            ->assertJsonPath('managed', false)
            ->assertJsonPath('stream_url', 'http://127.0.0.1:1990/api/stream.mp4?src=cam01');

        Http::assertNothingSent();
        $this->assertNull(Camera::query()->where('camera_code', 'CAM-01')->value('go2rtc_src'));
    }

    public function test_detector_list_has_only_dashboard_cameras(): void
    {
        Http::fake(['go2rtc.test/*' => Http::response('', 200)]);
        $this->actingAs($this->admin)->postJson('/api/cameras', [
            'name' => 'Paco north', 'ip_address' => '192.168.1.80', 'username' => 'u', 'password' => 'p',
        ])->assertCreated();

        $this->getJson('/api/detector/cameras')->assertUnauthorized();
        $this->withHeader('X-Detector-Key', (string) config('services.detector.key'))
            ->getJson('/api/detector/cameras')
            ->assertOk()
            ->assertJsonCount(1, 'cameras')
            ->assertJsonPath('cameras.0.camera_id', 'CAM-03')
            ->assertJsonPath('cameras.0.go2rtc_src', 'ipcam03')
            ->assertJsonPath('cameras.0.source', 'rtsp://u:p@192.168.1.80:554/stream1#transport=tcp#timeout=5s');
    }

    public function test_probe_needs_a_real_picture(): void
    {
        // Wrong login: go2rtc answers 200 with no picture. Then a real JPEG.
        Http::fake([
            'go2rtc.test/api/frame.jpeg*' => Http::sequence()->push('', 200)->push($this->jpeg(), 200),
            'go2rtc.test/*' => Http::response('', 200),
        ]);
        $this->actingAs($this->admin)->postJson('/api/cameras/probe', ['ip_address' => '192.168.1.99'])
            ->assertOk()->assertJsonPath('ok', false);

        $this->actingAs($this->admin)->postJson('/api/cameras/probe', ['ip_address' => '192.168.1.99'])
            ->assertOk()->assertJsonPath('ok', true);
    }

    public function test_removing_the_camera_removes_its_stream(): void
    {
        Http::fake(['go2rtc.test/*' => Http::response('', 200)]);
        $this->actingAs($this->admin)->postJson('/api/cameras', ['name' => 'X', 'ip_address' => '192.168.1.80'])->assertCreated();

        $this->actingAs($this->admin)->deleteJson('/api/cameras/CAM-03')->assertOk();

        Http::assertSent(fn (Request $r) => $r->method() === 'DELETE' && str_contains($r->url(), 'src=ipcam03'));
    }
}
