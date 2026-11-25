<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\MissedDetectionReport;
use App\Models\User;
use App\Support\TrainingSamplePlan;
use App\Support\WasteClassMap;
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

    public function test_admin_correction_is_separate_from_original_and_counts_only_after_approval(): void
    {
        $admin = User::factory()->create(['role' => 'Admin', 'email' => 'admin-correction@example.com']);
        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff-correction@example.com']);
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $path = 'missed-detections/correction-original.jpg';
        Storage::disk('public')->put($path, file_get_contents(dirname(__DIR__).'/fixtures/pixel.jpg'));
        $report = MissedDetectionReport::query()->create([
            'user_id' => $admin->id,
            'camera_id' => $camera->id,
            'description' => 'The model confused a bag with a bottle.',
            'image_path' => $path,
            'image_name' => 'correction-original.jpg',
            'status' => MissedDetectionReport::PENDING,
            'include_in_export' => false,
            'original_prediction' => 'Plastic Bag',
            'original_prediction_confidence' => 0.73,
            'original_model_boxes' => [[
                'class_name' => 'Plastic Bag', 'x' => 0.2, 'y' => 0.2, 'width' => 0.3, 'height' => 0.3,
            ]],
        ]);
        $report->annotations()->create([
            'class_name' => 'Plastic Bag',
            'class_index' => WasteClassMap::index('Plastic Bag'),
            'x' => 0.2, 'y' => 0.2, 'width' => 0.3, 'height' => 0.3,
        ]);
        $annotations = [[
            'class_name' => 'Plastic Bottle',
            'x' => 0.18, 'y' => 0.2, 'width' => 0.34, 'height' => 0.31,
        ]];

        $this->actingAs($staff)->putJson("/api/missed-detections/{$report->id}/annotations", ['annotations' => $annotations])
            ->assertForbidden();
        $corrected = $this->actingAs($admin)->putJson("/api/missed-detections/{$report->id}/annotations", ['annotations' => $annotations])
            ->assertOk()
            ->assertJsonPath('status', MissedDetectionReport::CORRECTED)
            ->assertJsonPath('original_prediction', 'Plastic Bag')
            ->assertJsonPath('annotations.0.class_name', 'Plastic Bottle')
            ->assertJsonPath('include_in_export', false);

        $this->assertSame($admin->id, $corrected->json('corrected_by'));
        $this->assertNotNull($corrected->json('corrected_at'));
        $this->assertNull($corrected->json('approved_at'));
        $beforeApproval = TrainingSamplePlan::summary();
        $this->assertSame(0, collect($beforeApproval['classes'])->firstWhere('name', 'Plastic Bottle')['eligible']);

        $this->actingAs($admin)->postJson("/api/missed-detections/{$report->id}/review", [
            'decision' => 'approved',
            'include_in_export' => true,
        ])->assertOk()->assertJsonPath('status', MissedDetectionReport::APPROVED)
            ->assertJsonPath('approved_by', $admin->id);
        $afterApproval = TrainingSamplePlan::summary();
        $this->assertSame(1, collect($afterApproval['classes'])->firstWhere('name', 'Plastic Bottle')['eligible']);
        $this->assertSame(0, collect($afterApproval['classes'])->firstWhere('name', 'Plastic Bag')['eligible']);
        $this->actingAs($admin)->postJson("/api/missed-detections/{$report->id}/review", [
            'decision' => 'corrected',
        ])->assertOk()->assertJsonPath('status', MissedDetectionReport::CORRECTED)
            ->assertJsonPath('include_in_export', false)
            ->assertJsonPath('approved_at', null);
        $this->assertSame(0, collect(TrainingSamplePlan::summary()['classes'])->firstWhere('name', 'Plastic Bottle')['eligible']);
        $this->actingAs($admin)->postJson("/api/missed-detections/{$report->id}/review", [
            'decision' => 'approved',
            'include_in_export' => true,
        ])->assertOk();

        $rejectedPath = 'missed-detections/rejected-distinct.jpg';
        Storage::disk('public')->put($rejectedPath, file_get_contents(dirname(__DIR__).'/fixtures/pixel.jpg').'rejected-distinct');
        $rejected = MissedDetectionReport::query()->create([
            'user_id' => $admin->id,
            'camera_id' => $camera->id,
            'description' => 'Rejected bottle review.',
            'image_path' => $rejectedPath,
            'image_name' => 'rejected-distinct.jpg',
            'status' => MissedDetectionReport::PENDING,
            'include_in_export' => false,
        ]);
        $rejected->annotations()->create([
            'class_name' => 'Plastic Bottle',
            'class_index' => WasteClassMap::index('Plastic Bottle'),
            'x' => 0.2, 'y' => 0.2, 'width' => 0.3, 'height' => 0.3,
        ]);
        $this->actingAs($admin)->postJson("/api/missed-detections/{$rejected->id}/review", [
            'decision' => 'rejected',
        ])->assertOk()->assertJsonPath('status', MissedDetectionReport::REJECTED);
        $afterReject = TrainingSamplePlan::summary();
        $this->assertSame(1, collect($afterReject['classes'])->firstWhere('name', 'Plastic Bottle')['eligible']);
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
            'decision' => 'corrected',
        ])->assertForbidden();

        $this->actingAs($admin)->postJson("/api/missed-detections/{$verifiedId}/review", [
            'decision' => 'verified',
        ])->assertOk()->assertJsonPath('status', MissedDetectionReport::CORRECTED);

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
        $this->assertStringContainsString('7: Plastic Bag', $yaml);
        $this->assertStringContainsString('8: Plastic Bottle', $yaml);
        $this->assertStringContainsString('14: Styrofoam', $yaml);
        $this->assertSame(
            MissedDetectionReport::EXPORTED,
            MissedDetectionReport::query()->find($verifiedId)->status,
        );
        $this->assertSame(
            MissedDetectionReport::PENDING,
            MissedDetectionReport::query()->find($pending->json('id'))->status,
        );
        $this->assertSame(
            MissedDetectionReport::CORRECTED,
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

    public function test_admin_can_delete_approved_reviews_unless_a_running_job_uses_them(): void
    {
        Storage::fake('public');
        $admin = User::factory()->create(['role' => 'Admin', 'email' => 'admin-delete@example.com']);
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $make = function (string $status, string $name) use ($admin, $camera) {
            $path = 'missed-detections/'.$name.'.jpg';
            Storage::disk('public')->put($path, file_get_contents(dirname(__DIR__).'/fixtures/pixel.jpg'));

            return MissedDetectionReport::query()->create([
                'user_id' => $admin->id,
                'camera_id' => $camera->id,
                'description' => 'Delete test.',
                'image_path' => $path,
                'image_name' => $name.'.jpg',
                'status' => $status,
                'include_in_export' => true,
            ]);
        };
        $approved = $make(MissedDetectionReport::APPROVED, 'approved');
        $exported = $make(MissedDetectionReport::EXPORTED, 'exported');
        $busy = $make(MissedDetectionReport::APPROVED, 'busy');
        $job = \App\Models\TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => \App\Models\TrainingJob::TRAINING,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
            'started_at' => now(),
        ]);
        \App\Models\TrainingJobItem::query()->create([
            'training_job_id' => $job->id,
            'report_id' => $busy->id,
            'image_hash' => str_repeat('a', 40),
            'filename' => 'busy.jpg',
        ]);

        $this->actingAs($admin)
            ->postJson('/api/missed-detections/bulk-delete', ['ids' => [$approved->id, $exported->id, $busy->id]])
            ->assertOk()
            ->assertJsonPath('kept', [$busy->id]);

        $this->assertNull(MissedDetectionReport::query()->find($approved->id));
        $this->assertNull(MissedDetectionReport::query()->find($exported->id));
        $this->assertNotNull(MissedDetectionReport::query()->find($busy->id));
        Storage::disk('public')->assertMissing('missed-detections/approved.jpg');

        $this->actingAs($admin)->deleteJson("/api/missed-detections/{$busy->id}")->assertStatus(422);
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
