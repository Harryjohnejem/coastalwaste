<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\MissedDetectionReport;
use App\Models\TrainingJob;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Config;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class TrainingJobTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Config::set('services.roboflow.key', 'test-roboflow-key');
        Config::set('services.roboflow.workspace', 'test-workspace');
        Config::set('services.roboflow.project', 'test-project');
        Config::set('services.roboflow.model_type', 'yolov11');
        Config::set('services.roboflow.speed', 'fast');
        Config::set('services.roboflow.base_url', 'https://api.roboflow.com');
    }

    public function test_staff_cannot_start_training(): void
    {
        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff-train@example.com']);
        $this->actingAs($staff)->postJson('/api/training-jobs')->assertForbidden();
        $this->actingAs($staff)->getJson('/api/training-jobs')->assertForbidden();
    }

    public function test_unconfigured_roboflow_is_rejected(): void
    {
        Config::set('services.roboflow.key', '');
        $admin = $this->admin();
        $this->seedApproved($admin);
        $this->actingAs($admin)->postJson('/api/training-jobs')
            ->assertStatus(422)
            ->assertJsonPath('message', 'Set ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and ROBOFLOW_PROJECT in the API environment before training.');
    }

    public function test_approved_reviews_upload_create_version_and_start_training(): void
    {
        Http::fake(function ($request) {
            $url = $request->url();
            if (str_contains($url, '/upload')) {
                return Http::response(['id' => 'img-1', 'duplicate' => false], 200);
            }
            if (str_contains($url, '/annotate')) {
                return Http::response(['success' => true], 200);
            }
            if (str_contains($url, '/generate')) {
                return Http::response(['version' => 7], 200);
            }
            if (str_contains($url, '/train')) {
                return Http::response(['message' => 'training'], 200);
            }

            return Http::response([
                'version' => 7,
                'train' => ['status' => 'finished'],
                'model' => ['map' => 0.71],
            ], 200);
        });

        $admin = $this->admin();
        $reportId = $this->seedApproved($admin);

        $created = $this->actingAs($admin)->postJson('/api/training-jobs');
        $created->assertCreated()
            ->assertJsonPath('status', TrainingJob::TRAINING)
            ->assertJsonPath('dataset_version', 7);

        $this->assertSame(MissedDetectionReport::EXPORTED, MissedDetectionReport::query()->find($reportId)->status);
        $this->assertSame($created->json('id'), MissedDetectionReport::query()->find($reportId)->training_job_id);

        $this->actingAs($admin)->postJson('/api/training-jobs')
            ->assertStatus(422)
            ->assertJsonPath('message', 'A training job is already running.');

        $body = $created->getContent();
        $this->assertStringNotContainsString('test-roboflow-key', $body);

        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('latest.status', TrainingJob::AWAITING_EVALUATION)
            ->assertJsonPath('configured', true)
            ->assertJsonPath('dataset.eligible_reviews', 0)
            ->assertJsonMissing(['key' => 'test-roboflow-key']);
    }

    public function test_failed_upload_redacts_api_key(): void
    {
        Http::fake(fn () => Http::response(['error' => 'Unauthorized test-roboflow-key'], 401));
        $admin = $this->admin();
        $this->seedApproved($admin);
        $created = $this->actingAs($admin)->postJson('/api/training-jobs')->assertCreated();
        $this->assertSame(TrainingJob::FAILED, $created->json('status'));
        $this->assertStringNotContainsString('test-roboflow-key', (string) $created->json('error_message'));
    }

    public function test_evaluation_and_reject_do_not_replace_weights(): void
    {
        $admin = $this->admin();
        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::AWAITING_EVALUATION,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
            'dataset_version' => 3,
            'hosted_model_id' => 'test-project/3',
            'started_at' => now(),
            'completed_at' => now(),
        ]);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$job->id}/evaluate", [
            'notes' => 'mAP looks usable on the hosted version.',
        ])->assertOk()->assertJsonPath('evaluation_notes', 'mAP looks usable on the hosted version.');

        $this->actingAs($admin)->postJson("/api/training-jobs/{$job->id}/approve-deployment")
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::APPROVED_FOR_DEPLOYMENT);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$job->id}/reject")
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::REJECTED);
    }

    public function test_dataset_summary_and_review_counts_before_training(): void
    {
        $admin = $this->admin();
        $this->seedApproved($admin);

        $this->actingAs($admin)->getJson('/api/missed-detections')
            ->assertOk()
            ->assertJsonPath('counts.training_eligible', 1)
            ->assertJsonPath('data.0.training_job_id', null);

        $this->actingAs($admin)->getJson('/api/training-jobs?validate=1')
            ->assertOk()
            ->assertJsonPath('dataset.eligible_reviews', 1)
            ->assertJsonPath('dataset.images', 1)
            ->assertJsonPath('dataset.annotations', 1)
            ->assertJsonPath('dataset.valid', true)
            ->assertJsonPath('dataset.issues', []);
    }

    private function admin(): User
    {
        return User::factory()->create(['role' => 'Admin', 'email' => 'admin-train@example.com']);
    }

    private function seedApproved(User $admin): int
    {
        Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $created = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-01',
            'description' => 'Approved bottle for retraining.',
            'image' => new UploadedFile(dirname(__DIR__).'/fixtures/pixel.jpg', 'frame.jpg', 'image/jpeg', null, true),
            'annotations' => [[
                'class_name' => 'Plastic Bottle',
                'x' => 0.2,
                'y' => 0.2,
                'width' => 0.3,
                'height' => 0.3,
            ]],
        ]);
        $created->assertCreated();
        $id = (int) $created->json('id');
        $this->actingAs($admin)->postJson("/api/missed-detections/{$id}/review", [
            'decision' => 'approved',
            'include_in_export' => true,
        ])->assertOk();

        return $id;
    }
}
