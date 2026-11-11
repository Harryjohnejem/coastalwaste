<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

function missed_jpeg(): UploadedFile
{
    $source = dirname(__DIR__).'/fixtures/pixel.jpg';

    return new UploadedFile($source, 'frame.jpg', 'image/jpeg', null, true);
}

class MissedDetectionExportTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
    }

    public function test_only_verified_annotations_are_exported_as_yolo(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'email' => 'admin-missed@example.com']);
        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff-missed@example.com']);
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);

        $verified = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-01',
            'description' => 'Bottle was not boxed by the live model.',
            'image' => missed_jpeg(),
            'annotations' => [[
                'class_name' => 'Can',
                'x' => 0.1,
                'y' => 0.2,
                'width' => 0.3,
                'height' => 0.4,
            ]],
        ]);
        $verified->assertCreated();
        $verifiedId = $verified->json('id');

        $this->actingAs($staff)->postJson("/api/missed-detections/{$verifiedId}/review", [
            'decision' => 'verified',
        ])->assertForbidden();

        $this->actingAs($admin)->postJson("/api/missed-detections/{$verifiedId}/review", [
            'decision' => 'verified',
        ])->assertOk()->assertJsonPath('status', MissedDetectionReport::VERIFIED);

        $this->actingAs($admin)->getJson('/api/missed-detections/export')
            ->assertStatus(422)
            ->assertJsonPath('message', 'There are no reviews marked for export.');

        $this->actingAs($admin)->postJson("/api/missed-detections/{$verifiedId}/review", [
            'decision' => 'approved',
            'include_in_export' => true,
        ])->assertOk()->assertJsonPath('status', MissedDetectionReport::APPROVED)
            ->assertJsonPath('include_in_export', true);

        $this->actingAs($admin)->postJson("/api/missed-detections/{$verifiedId}/review", [
            'decision' => 'approved',
        ])->assertStatus(422);

        $pending = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-01',
            'description' => 'Still waiting.',
            'image' => missed_jpeg(),
            'annotations' => [[
                'class_name' => 'Styrofoam',
                'x' => 0.5,
                'y' => 0.5,
                'width' => 0.2,
                'height' => 0.2,
            ]],
        ])->assertCreated();

        $held = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-01',
            'description' => 'Verified, not yet approved.',
            'image' => missed_jpeg(),
            'annotations' => [[
                'class_name' => 'Paper Bag',
                'x' => 0.2,
                'y' => 0.2,
                'width' => 0.2,
                'height' => 0.2,
            ]],
        ])->assertCreated();
        $heldId = $held->json('id');
        $this->actingAs($admin)->postJson("/api/missed-detections/{$heldId}/review", [
            'decision' => 'verified',
        ])->assertOk();

        $keptOut = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-01',
            'description' => 'Approved, but not for export.',
            'image' => missed_jpeg(),
            'annotations' => [[
                'class_name' => 'Can',
                'x' => 0.15,
                'y' => 0.15,
                'width' => 0.2,
                'height' => 0.2,
            ]],
        ])->assertCreated();
        $keptOutId = $keptOut->json('id');
        $this->actingAs($admin)->postJson("/api/missed-detections/{$keptOutId}/review", [
            'decision' => 'approved',
            'include_in_export' => false,
        ])->assertOk()->assertJsonPath('include_in_export', false);

        $this->actingAs($staff)->get('/api/missed-detections/export')->assertForbidden();

        $download = $this->actingAs($admin)->get('/api/missed-detections/export');
        $download->assertOk();

        $zipPath = $download->baseResponse->getFile()->getPathname();
        $entries = stored_zip_entries($zipPath);
        $label = $entries['labels/train/missed-'.$verifiedId.'.txt'] ?? false;
        $yaml = $entries['data.yaml'] ?? '';
        $this->assertArrayHasKey('images/train/missed-'.$verifiedId.'.jpg', $entries);
        $this->assertArrayHasKey('images/val/missed-'.$verifiedId.'.jpg', $entries);
        $this->assertArrayHasKey('labels/train/missed-'.$verifiedId.'.txt', $entries);
        $this->assertArrayHasKey('labels/val/missed-'.$verifiedId.'.txt', $entries);
        $this->assertStringContainsString('train: images/train', $yaml);
        $this->assertStringContainsString('val: images/val', $yaml);
        $this->assertArrayNotHasKey('labels/missed-'.$pending->json('id').'.txt', $entries);
        $this->assertArrayNotHasKey('labels/missed-'.$heldId.'.txt', $entries);
        $this->assertArrayNotHasKey('labels/missed-'.$keptOutId.'.txt', $entries);
        $this->assertSame(0, Detection::query()->count());

        $this->assertSame("0 0.250000 0.400000 0.300000 0.400000\n", $label);
        $this->assertStringContainsString('7: Plastic Bottle', $yaml);
        $this->assertStringContainsString('12: Styrofoam', $yaml);
        $this->assertStringNotContainsString('Plastic Bag', $yaml);
        $this->assertSame(
            MissedDetectionReport::EXPORTED,
            MissedDetectionReport::query()->find($verifiedId)->status,
        );
        $this->assertSame(
            MissedDetectionReport::PENDING,
            MissedDetectionReport::query()->find($pending->json('id'))->status,
        );
        $this->assertSame(
            MissedDetectionReport::VERIFIED,
            MissedDetectionReport::query()->find($heldId)->status,
        );
        $this->assertSame($camera->camera_code, $verified->json('camera_id'));
    }

    public function test_unfamiliar_proposal_is_queued_without_a_live_detection(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'email' => 'admin-unfamiliar@example.com']);
        Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);

        $created = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'shoe',
                'confidence' => 0.46,
                'x' => 0.2,
                'y' => 0.2,
                'width' => 0.3,
                'height' => 0.3,
                'image' => missed_jpeg(),
            ]);
        $created->assertCreated();
        $created->assertJsonPath('status', MissedDetectionReport::PENDING);
        $created->assertJsonPath('prediction', 'shoe');
        $created->assertJsonPath('model_boxes.0.source', 'proposal');
        $created->assertJsonPath('annotations', []);
        $this->assertSame(0, Detection::query()->count());
        $this->assertSame($admin->id, MissedDetectionReport::query()->find($created->json('id'))->user_id);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'Can',
                'x' => 0.1,
                'y' => 0.1,
                'width' => 0.2,
                'height' => 0.2,
                'image' => missed_jpeg(),
            ])->assertStatus(422);

        $again = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'shoe',
                'x' => 0.2,
                'y' => 0.2,
                'width' => 0.3,
                'height' => 0.3,
                'image' => missed_jpeg(),
            ]);
        $again->assertOk();
        $again->assertJsonPath('id', $created->json('id'));
        $this->assertSame(1, MissedDetectionReport::query()->count());

        $uncertain = $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->post('/api/missed-detections/unfamiliar', [
                'camera_id' => 'CAM-01',
                'label' => 'Plastic Wrapper',
                'reason' => 'uncertain',
                'confidence' => 0.74,
                'x' => 0.4,
                'y' => 0.4,
                'width' => 0.2,
                'height' => 0.2,
                'image' => missed_jpeg(),
            ]);
        $uncertain->assertCreated();
        $uncertain->assertJsonPath('prediction', 'Plastic Wrapper');
        $this->assertSame(0, Detection::query()->count());
    }

    public function test_guest_cannot_export_and_invalid_boxes_are_rejected(): void
    {
        $this->getJson('/api/missed-detections/export')->assertUnauthorized();

        $admin = User::factory()->create(['role' => 'Admin', 'email' => 'admin-box@example.com']);
        Camera::query()->create([
            'camera_code' => 'CAM-02',
            'camera_name' => 'Second Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);

        $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-02',
            'description' => 'Box hangs off the frame.',
            'image' => missed_jpeg(),
            'annotations' => [[
                'class_name' => 'Can',
                'x' => 0.8,
                'y' => 0.8,
                'width' => 0.5,
                'height' => 0.5,
            ]],
        ])->assertStatus(422);
    }

    public function test_invalid_verified_annotation_blocks_export(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'email' => 'admin-invalid@example.com']);
        Camera::query()->create([
            'camera_code' => 'CAM-03',
            'camera_name' => 'Paco Wide-Angle',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);

        $created = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-03',
            'description' => 'Will be corrupted after approval.',
            'image' => missed_jpeg(),
            'annotations' => [[
                'class_name' => 'Can',
                'x' => 0.1,
                'y' => 0.1,
                'width' => 0.2,
                'height' => 0.2,
            ]],
        ])->assertCreated();

        $id = $created->json('id');
        $this->actingAs($admin)->postJson("/api/missed-detections/{$id}/review", [
            'decision' => 'approved',
            'include_in_export' => true,
        ])->assertOk();

        MissedDetectionReport::query()->find($id)->annotations()->update([
            'class_index' => 99,
        ]);

        $export = $this->actingAs($admin)->getJson('/api/missed-detections/export');
        $export->assertStatus(422);
        $export->assertJsonPath('issues.0', "Report {$id} has an invalid annotation.");
        $this->assertSame(
            MissedDetectionReport::APPROVED,
            MissedDetectionReport::query()->find($id)->status,
        );
    }
}

function stored_zip_entries(string $path): array
{
    $data = file_get_contents($path);
    $entries = [];
    $offset = 0;
    $length = strlen($data);
    while ($offset + 30 <= $length) {
        $sig = unpack('V', substr($data, $offset, 4))[1];
        if ($sig !== 0x04034b50) {
            break;
        }
        $header = unpack('vver/vflag/vmethod/vtime/vdate/Vcrc/Vcomp/Vuncomp/vnamelen/vextra', substr($data, $offset + 4, 26));
        $name = substr($data, $offset + 30, $header['namelen']);
        $start = $offset + 30 + $header['namelen'] + $header['extra'];
        $entries[$name] = substr($data, $start, $header['uncomp']);
        $offset = $start + $header['comp'];
    }

    return $entries;
}
