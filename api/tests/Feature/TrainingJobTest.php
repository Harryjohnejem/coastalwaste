<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Services\TrainedModelInstaller;
use Illuminate\Support\Facades\File;
use App\Models\MissedDetectionReport;
use App\Models\TrainingJob;
use App\Models\TrainingJobItem;
use App\Models\User;
use App\Support\TrainingSamplePlan;
use App\Support\WasteClassMap;
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
        Config::set('services.roboflow.model_type', 'yolov11s');
        Config::set('services.roboflow.speed', 'fast');
        Config::set('services.roboflow.epochs', 350);
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

    public function test_approved_reviews_upload_and_wait_for_yolov11_large(): void
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
            if (str_contains($url, '/yolov5pytorch')) {
                return Http::response(['export' => ['link' => 'https://example.test/export.zip']], 200);
            }
            if (str_contains($url, '/train')) {
                return Http::response(['message' => 'training'], 200);
            }

            return Http::response([
                'version' => 7,
                'train' => ['status' => 'training'],
            ], 200);
        });

        $admin = $this->admin();
        $balanced = $this->seedBalanced($admin);
        $reportId = $balanced[0];
        $readiness = TrainingSamplePlan::summary();
        $this->assertTrue($readiness['ready']);
        $this->assertSame(11, $readiness['classes_ready']);
        $this->assertSame(50, collect($readiness['classes'])->firstWhere('name', 'Plastic Spoon')['eligible']);

        $created = $this->actingAs($admin)->postJson('/api/training-jobs');
        $created->assertCreated()
            ->assertJsonPath('status', TrainingJob::READY_TO_PICK)
            ->assertJsonPath('dataset_version', null);

        $this->assertSame(MissedDetectionReport::APPROVED, MissedDetectionReport::query()->find($reportId)->status);
        $this->assertSame($created->json('id'), MissedDetectionReport::query()->find($reportId)->training_job_id);
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/train'));
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/generate'));

        $this->actingAs($admin)->postJson('/api/training-jobs')
            ->assertStatus(422)
            ->assertJsonPath('message', 'A training job is already running.');

        $body = $created->getContent();
        $this->assertStringNotContainsString('test-roboflow-key', $body);

        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('latest.status', TrainingJob::READY_TO_PICK)
            ->assertJsonPath('configured', true)
            ->assertJsonPath('recipe.architecture', 'yolov11')
            ->assertJsonPath('recipe.model_size', 'large')
            ->assertJsonPath('recipe.model_type', 'yolov11l')
            ->assertJsonPath('recipe.epochs', 350)
            ->assertJsonPath('dataset.eligible_reviews', 750)
            ->assertJsonMissing(['key' => 'test-roboflow-key']);

        $jobId = $created->json('id');
        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/start-training", [
            'architecture' => 'yolov11',
            'model_size' => 'small',
            'epochs' => 350,
        ])->assertStatus(422);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/pick-data")
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::READY_TO_TRAIN)
            ->assertJsonPath('dataset_version', 7);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/start-training", [
            'architecture' => 'yolov8',
            'model_size' => 'small',
        ])->assertStatus(422);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/start-training", [
            'architecture' => 'yolov11',
            'model_size' => 'accurate',
        ])->assertStatus(422);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/start-training", [
            'architecture' => 'yolov11',
            'model_size' => 'small',
            'epochs' => 100,
        ])->assertStatus(422);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/start-training", [
            'architecture' => 'yolov11',
            'model_size' => 'large',
            'epochs' => 350,
        ])
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::TRAINING)
            ->assertJsonPath('model_type', 'yolov11l');

        $this->assertSame(MissedDetectionReport::EXPORTED, MissedDetectionReport::query()->find($reportId)->status);
        $this->assertSame(TrainingJob::TRAINING, TrainingJob::query()->find($jobId)->status);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/generate'));
        Http::assertSent(function ($request) {
            if (! str_contains($request->url(), '/train')) {
                return false;
            }
            $payload = $request->data();

            return ($payload['modelType'] ?? null) === 'yolov11l'
                && (int) ($payload['epochs'] ?? 0) === 350;
        });
    }

    public function test_finished_roboflow_training_waits_for_admin_deployment_approval(): void
    {
        Http::fake(fn () => Http::response([
            'version' => 4,
            'train' => ['status' => 'finished'],
            'model' => ['map' => 0.71],
        ], 200));

        $admin = $this->admin();
        $live = storage_path('framework/testing-auto-live.onnx');
        File::ensureDirectoryExists(dirname($live));
        File::put($live, 'old-onnx');
        config(['services.detector.onnx_path' => $live]);
        $this->app->instance(TrainedModelInstaller::class, new class extends TrainedModelInstaller
        {
            public function __construct() {}

            public function install(int $version): array
            {
                $live = config('services.detector.onnx_path');
                $backup = $live.'.bak';
                File::copy($live, $backup);
                File::put($live, 'new-onnx');

                return ['backup' => $backup, 'reloaded' => true, 'live' => $live];
            }
        });

        TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::TRAINING,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
            'dataset_version' => 4,
            'hosted_model_id' => 'test-project/4',
            'started_at' => now(),
        ]);

        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('latest.status', TrainingJob::AWAITING_EVALUATION);

        $this->assertSame('old-onnx', File::get($live));
        File::delete($live);
    }

    public function test_staff_cannot_start_yolov11_large_training(): void
    {
        $admin = $this->admin();
        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::READY_TO_TRAIN,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
            'dataset_version' => 3,
            'hosted_model_id' => 'test-project/3',
            'started_at' => now(),
        ]);
        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff-recipe@example.com']);

        $this->actingAs($staff)->postJson("/api/training-jobs/{$job->id}/start-training", [
            'architecture' => 'yolov11',
            'model_size' => 'large',
        ])->assertForbidden();
        $this->actingAs($staff)->postJson("/api/training-jobs/{$job->id}/pick-data")->assertForbidden();
    }

    public function test_failed_upload_redacts_api_key(): void
    {
        Http::fake(fn () => Http::response(['error' => 'Unauthorized test-roboflow-key'], 401));
        $admin = $this->admin();
        $this->seedBalanced($admin);
        $created = $this->actingAs($admin)->postJson('/api/training-jobs')->assertCreated();
        $this->assertSame(TrainingJob::FAILED, $created->json('status'));
        $this->assertStringNotContainsString('test-roboflow-key', (string) $created->json('error_message'));
        $this->assertSame(750, TrainingSamplePlan::summary()['eligible_reviews']);
    }

    public function test_clear_failed_job_returns_reviews_to_the_pool(): void
    {
        Http::fake(fn () => Http::response(['error' => 'Unauthorized'], 401));
        $admin = $this->admin();
        $balanced = $this->seedBalanced($admin);
        $reportId = $balanced[0];
        $created = $this->actingAs($admin)->postJson('/api/training-jobs')->assertCreated();
        $jobId = (int) $created->json('id');
        $this->assertSame($jobId, MissedDetectionReport::query()->find($reportId)->training_job_id);

        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff-clear@example.com']);
        $this->actingAs($staff)->postJson("/api/training-jobs/{$jobId}/dismiss")->assertForbidden();

        $this->actingAs($admin)->postJson("/api/training-jobs/{$jobId}/dismiss")
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::DISMISSED);

        $report = MissedDetectionReport::query()->find($reportId);
        $this->assertNull($report->training_job_id);
        $this->assertSame(MissedDetectionReport::APPROVED, $report->status);
        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('latest', null)
            ->assertJsonPath('dataset.eligible_reviews', 750);
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

    public function test_deploy_installs_the_downloaded_weights(): void
    {
        $admin = $this->admin();
        $live = storage_path('framework/testing-live.onnx');
        File::ensureDirectoryExists(dirname($live));
        File::put($live, 'old-onnx');
        config(['services.detector.onnx_path' => $live]);
        $this->app->instance(TrainedModelInstaller::class, new class extends TrainedModelInstaller
        {
            public function __construct() {}

            public function install(int $version): array
            {
                $live = config('services.detector.onnx_path');
                $backup = $live.'.bak';
                File::copy($live, $backup);
                File::put($live, 'new-onnx');

                return ['backup' => $backup, 'reloaded' => true, 'live' => $live];
            }
        });

        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::APPROVED_FOR_DEPLOYMENT,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
            'dataset_version' => 4,
            'hosted_model_id' => 'test-project/4',
            'started_at' => now(),
            'completed_at' => now(),
        ]);

        $this->actingAs($admin)->postJson("/api/training-jobs/{$job->id}/deploy")
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::DEPLOYED);

        $this->assertSame('new-onnx', File::get($live));
        $this->assertSame('old-onnx', File::get($live.'.bak'));
        File::delete($live);
        File::delete($live.'.bak');
    }

    public function test_deploying_a_new_project_model_switches_the_live_model_and_rollback_restores_it(): void
    {
        $admin = $this->admin();
        \Illuminate\Support\Facades\Cache::flush();
        \App\Support\ClassRegistry::forget();
        Http::fake(['*' => Http::response(['ok' => true], 200)]); // detector reload
        $live = storage_path('framework/testing-live-switch.onnx');
        File::ensureDirectoryExists(dirname($live));
        File::put($live, 'weights-10');
        config(['services.detector.onnx_path' => $live]);
        $this->app->instance(TrainedModelInstaller::class, new class extends TrainedModelInstaller
        {
            public function __construct() {}

            public function install(int $version): array
            {
                $live = config('services.detector.onnx_path');
                File::copy($live, $live.'.bak');
                File::put($live, 'ruwza-v5');

                return [
                    'backup' => $live.'.bak',
                    'reloaded' => true,
                    'live' => $live,
                    // The new model has the 11 classes plus a new one.
                    'classes' => [...\App\Support\ClassRegistry::live(), 'Tsinelas'],
                ];
            }
        });

        // Before: the cameras run weights 10 from local-ortk7 v2.
        $this->assertSame('local-ortk7 v2', \App\Support\LiveModel::current()['dataset']);
        $this->actingAs($admin)->getJson('/api/settings')
            ->assertJsonPath('live_model.label', 'YOLOv11l / Roboflow · local-ortk7 v2');

        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::APPROVED_FOR_DEPLOYMENT,
            'workspace' => 'dirks-workspace-aiipj',
            'project' => 'local-ruwza-dgl85',
            'dataset_version' => 5,
            'hosted_model_id' => 'local-ruwza-dgl85/5',
            'started_at' => now(),
            'completed_at' => now(),
        ]);
        $this->actingAs($admin)->postJson("/api/training-jobs/{$job->id}/deploy")
            ->assertOk()
            ->assertJsonPath('status', TrainingJob::DEPLOYED);

        // After Deploy: the new project and version everywhere, and the new class is live.
        $this->actingAs($admin)->getJson('/api/settings')
            ->assertJsonPath('live_model.label', 'YOLOv11l / Roboflow · local-ruwza-dgl85 v5');
        $this->assertContains('Tsinelas', \App\Support\ClassRegistry::live());

        // Rollback: back to weights 10 and its classes.
        $this->actingAs($admin)->postJson("/api/training-jobs/{$job->id}/rollback")->assertOk();
        $this->actingAs($admin)->getJson('/api/settings')
            ->assertJsonPath('live_model.label', 'YOLOv11l / Roboflow · local-ortk7 v2');
        $this->assertNotContains('Tsinelas', \App\Support\ClassRegistry::live());
        $this->assertSame('weights-10', File::get($live));

        File::delete($live);
        File::delete($live.'.bak');
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

    public function test_nested_roboflow_version_marks_training_finished(): void
    {
        Http::fake([
            'https://api.roboflow.com/*' => Http::response([
                'workspace' => ['name' => 'New Workspace'],
                'project' => ['name' => 'Local 1'],
                'version' => [
                    'id' => 'test-workspace/test-project/3',
                    'progress' => 1,
                    'model' => [
                        'id' => 'local-1/3',
                        'map' => 89.81,
                        'precision' => 86.4,
                        'recall' => 86.3,
                    ],
                    'train' => [
                        'status' => 'finished',
                        'results' => ['finished_epochs' => 168, 'map' => 0.898],
                    ],
                ],
            ], 200),
        ]);
        $admin = $this->admin();
        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::TRAINING,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
            'dataset_version' => 3,
            'model_type' => 'yolov11s',
            'hosted_model_id' => 'test-project/3',
            'training_speed' => 'fast',
            'manifest' => ['epochs' => 350, 'training_started' => true],
            'started_at' => now(),
        ]);

        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('latest.status', TrainingJob::AWAITING_EVALUATION)
            ->assertJsonPath('latest.metrics.map', 89.81);

        $this->assertSame(TrainingJob::AWAITING_EVALUATION, $job->fresh()->status);
    }

    public function test_samples_from_a_finished_training_no_longer_count_as_approved(): void
    {
        $admin = $this->admin();
        $trainedId = $this->seedApproved($admin);

        $this->actingAs($admin)->getJson('/api/missed-detections')
            ->assertOk()->assertJsonPath('counts.training_eligible', 1);

        // A run that finished training (it has a mAP result), later dismissed.
        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::DISMISSED,
            'dataset_version' => 4,
            'metrics' => ['map' => '91.25'],
        ]);
        TrainingJobItem::query()->create([
            'training_job_id' => $job->id,
            'report_id' => $trainedId,
            'image_hash' => str_repeat('a', 40),
            'filename' => 'trained.jpg',
        ]);

        $this->actingAs($admin)->getJson('/api/missed-detections')
            ->assertOk()->assertJsonPath('counts.training_eligible', 0);
        $bottle = collect(TrainingSamplePlan::summary()['classes'])->firstWhere('name', 'Plastic Bottle');
        $this->assertSame(0, $bottle['eligible']);

        // A failed run did not train anything: its samples still count.
        $job->update(['status' => TrainingJob::FAILED, 'metrics' => null]);
        $this->actingAs($admin)->getJson('/api/missed-detections')
            ->assertOk()->assertJsonPath('counts.training_eligible', 1);
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

    /** @param array<string, int> $extras @return list<int> */
    private function seedBalanced(User $admin, array $extras = []): array
    {
        $camera = Camera::query()->firstOrCreate(
            ['camera_code' => 'CAM-01'],
            [
                'camera_name' => 'Wide-Angle Lens',
                'monitoring_location' => 'Paco Beach',
                'status' => 'Online',
            ],
        );
        $ids = [];
        $jpeg = file_get_contents(dirname(__DIR__).'/fixtures/pixel.jpg');
        foreach (WasteClassMap::CLASSES as $className) {
            $count = max(0, TrainingSamplePlan::REQUIRED + (int) ($extras[$className] ?? 0));
            for ($i = 0; $i < $count; $i++) {
                $path = 'training-test/'.strtolower(str_replace(' ', '-', $className)).'-'.$i.'-'.uniqid('', true).'.jpg';
                Storage::disk('public')->put($path, $jpeg.$className.$i.uniqid('', true));
                $report = MissedDetectionReport::query()->create([
                    'user_id' => $admin->id,
                    'camera_id' => $camera->id,
                    'description' => $className.' verified training sample',
                    'image_path' => $path,
                    'image_name' => basename($path),
                    'status' => MissedDetectionReport::APPROVED,
                    'include_in_export' => true,
                    'approved_by' => $admin->id,
                    'approved_at' => now(),
                    'reviewed_by' => $admin->id,
                    'reviewed_at' => now(),
                ]);
                $report->annotations()->create([
                    'class_name' => $className,
                    'class_index' => WasteClassMap::index($className),
                    'x' => 0.2,
                    'y' => 0.2,
                    'width' => 0.3,
                    'height' => 0.3,
                ]);
                $ids[] = (int) $report->id;
            }
        }

        return $ids;
    }

    public function test_sample_limit_is_saved_and_controls_the_readiness_requirement(): void
    {
        $admin = $this->admin();
        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('sample_limit', 50);

        $this->actingAs($admin)->putJson('/api/training-jobs/sample-limit', ['per_class' => 75])
            ->assertStatus(422);

        $twentyPerClass = array_fill_keys(WasteClassMap::CLASSES, -30);
        $this->seedBalanced($admin, $twentyPerClass);

        $this->actingAs($admin)->putJson('/api/training-jobs/sample-limit', ['per_class' => 20])
            ->assertOk()
            ->assertJsonPath('sample_limit', 20)
            ->assertJsonPath('sample_plan.limit', 20)
            ->assertJsonPath('sample_plan.ready', true)
            ->assertJsonPath('sample_plan.classes_ready', 11)
            ->assertJsonPath('sample_plan.classes.0.remaining', 0);

        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('sample_limit', 20)
            ->assertJsonPath('dataset.sample_plan.required', 20);

        $this->actingAs($admin)->putJson('/api/training-jobs/sample-limit', ['per_class' => 1000])
            ->assertOk()
            ->assertJsonPath('sample_limit', 1000)
            ->assertJsonPath('sample_plan.required', 1000)
            ->assertJsonPath('sample_plan.ready', false)
            ->assertJsonPath('sample_plan.classes.0.remaining', 980);

        $this->actingAs($admin)->putJson('/api/training-jobs/sample-limit', ['per_class' => 50])
            ->assertOk()
            ->assertJsonPath('sample_limit', 50)
            ->assertJsonPath('sample_plan.limit', 50)
            ->assertJsonPath('sample_plan.ready', false)
            ->assertJsonPath('sample_plan.classes.0.remaining', 30);

        $this->actingAs($admin)->getJson('/api/training-jobs')
            ->assertOk()
            ->assertJsonPath('sample_limit', 50);

        $staff = User::factory()->create(['role' => 'Staff', 'email' => 'staff-limit@example.com']);
        $this->actingAs($staff)->putJson('/api/training-jobs/sample-limit', ['per_class' => 50])
            ->assertForbidden();
    }

    public function test_balanced_threshold_and_cumulative_versions_retain_excess_samples(): void
    {
        $admin = $this->admin();
        $seededIds = $this->seedBalanced($admin, ['Plastic Bottle' => 5]);
        $plan = TrainingSamplePlan::summary();
        $this->assertTrue($plan['ready']);
        $this->assertSame(11, $plan['classes_ready']);
        $classes = collect($plan['classes']);
        $this->assertSame(55, $classes->firstWhere('name', 'Plastic Bottle')['eligible']);
        $this->assertSame(50, $classes->firstWhere('name', 'Plastic Bottle')['selected']);
        $this->assertSame('ready', $classes->firstWhere('name', 'Plastic Bottle')['status']);
        $this->assertSame(750, $plan['selected_reviews']);

        $firstVersionIds = $plan['selected_ids'];
        $job = TrainingJob::query()->create([
            'started_by' => $admin->id,
            'status' => TrainingJob::COMPLETED,
            'dataset_version' => 1,
            'workspace' => 'test-workspace',
            'project' => 'test-project',
        ]);
        foreach ($firstVersionIds as $id) {
            $report = MissedDetectionReport::query()->findOrFail($id);
            TrainingJobItem::query()->create([
                'training_job_id' => $job->id,
                'report_id' => $id,
                'image_hash' => sha1(Storage::disk('public')->get($report->image_path)),
                'split' => 'train',
                'filename' => "missed-{$id}.jpg",
                'upload_status' => 'uploaded',
            ]);
        }
        $newSample = $this->seedClass($admin, 'Plastic Bottle', 'approved', true);
        $nextVersion = TrainingSamplePlan::summary();
        $this->assertTrue($nextVersion['ready']);
        $this->assertSame(756, $nextVersion['selected_reviews']);
        $this->assertEqualsCanonicalizing(
            array_merge($seededIds, [$newSample]),
            $nextVersion['selected_ids'],
        );
    }

    public function test_training_is_blocked_when_one_class_is_below_fifty(): void
    {
        $admin = $this->admin();
        $this->seedBalanced($admin, ['Plastic Bottle' => 10, 'Plastic Spoon' => -31]);
        $plan = TrainingSamplePlan::summary();
        $classes = collect($plan['classes']);

        $this->assertFalse($plan['ready']);
        $this->assertSame(10, $plan['classes_ready']);
        $this->assertSame(60, $classes->firstWhere('name', 'Plastic Bottle')['eligible']);
        $this->assertSame(19, $classes->firstWhere('name', 'Plastic Spoon')['eligible']);
        $this->assertSame(31, $classes->firstWhere('name', 'Plastic Spoon')['remaining']);

        $this->actingAs($admin)->postJson('/api/training-jobs')
            ->assertStatus(422)
            ->assertJsonPath('message', 'Training requires at least 50 valid approved samples for every configured waste class.')
            ->assertJsonFragment(['name' => 'Plastic Spoon', 'remaining' => 31]);
    }

    public function test_training_starts_without_samples_for_optional_classes(): void
    {
        Http::fake(fn ($request) => str_contains($request->url(), '/upload')
            ? Http::response(['id' => 'img-1', 'duplicate' => false], 200)
            : Http::response(['success' => true], 200));
        $admin = $this->admin();
        $none = array_fill_keys(TrainingSamplePlan::OPTIONAL_CLASSES, -TrainingSamplePlan::REQUIRED);
        $this->seedBalanced($admin, $none);

        $this->assertTrue(TrainingSamplePlan::summary()['ready']);
        $this->actingAs($admin)->postJson('/api/training-jobs')->assertCreated();
    }

    public function test_training_is_blocked_when_no_class_has_samples(): void
    {
        $admin = $this->admin();
        $response = $this->actingAs($admin)->postJson('/api/training-jobs');
        $response->assertStatus(422)->assertJsonPath(
            'message',
            'Training requires at least 50 valid approved samples for every configured waste class.',
        );
        $this->assertSame(11, count($response->json('classes')));
    }

    private function seedClass(User $admin, string $className, string $decision, bool $include): int
    {
        if (! Camera::query()->where('camera_code', 'CAM-01')->exists()) {
            Camera::query()->create([
                'camera_code' => 'CAM-01',
                'camera_name' => 'Wide-Angle Lens',
                'monitoring_location' => 'Paco Beach',
                'status' => 'Online',
            ]);
        }
        $imagePath = tempnam(sys_get_temp_dir(), 'review');
        $jpeg = file_get_contents(dirname(__DIR__).'/fixtures/pixel.jpg');
        file_put_contents($imagePath, $jpeg.uniqid('', true));
        $created = $this->actingAs($admin)->post('/api/missed-detections', [
            'camera_id' => 'CAM-01',
            'description' => $className.' sample',
            'image' => new UploadedFile($imagePath, 'frame.jpg', 'image/jpeg', null, true),
            'annotations' => [[
                'class_name' => $className,
                'x' => 0.2,
                'y' => 0.2,
                'width' => 0.3,
                'height' => 0.3,
            ]],
        ]);
        $created->assertCreated();
        $id = (int) $created->json('id');
        $this->actingAs($admin)->postJson("/api/missed-detections/{$id}/review", [
            'decision' => $decision,
            'include_in_export' => $include,
        ])->assertOk();

        return $id;
    }
}
