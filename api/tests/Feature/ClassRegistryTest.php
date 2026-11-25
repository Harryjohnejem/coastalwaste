<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\SystemSetting;
use App\Models\User;
use App\Support\ClassRegistry;
use App\Support\TrainingSamplePlan;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

/** New classes (waste catalog or a newly trained model) reach the whole system. */
class ClassRegistryTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
        ClassRegistry::forget();
    }

    public function test_starts_with_the_eleven_live_classes(): void
    {
        $this->assertCount(11, ClassRegistry::live());
        $this->assertNotContains('Plastic Bag', ClassRegistry::live());
        $this->assertSame(['Plastic', 'Metal', 'Glass'], ClassRegistry::categories());
    }

    public function test_catalog_category_and_classification_join_the_lists(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $category = $this->actingAs($admin)->postJson('/api/waste-catalog/categories', ['name' => 'Rubber'])
            ->assertCreated()->json('id');
        $this->actingAs($admin)->postJson('/api/waste-catalog/classifications', ['category_id' => $category, 'name' => 'Tsinelas'])
            ->assertCreated();

        $this->actingAs($admin)->getJson('/api/classes')
            ->assertOk()
            ->assertJsonPath('categories', ['Plastic', 'Metal', 'Glass', 'Rubber'])
            ->assertJsonPath('category_of.Tsinelas', 'Rubber')
            ->assertJsonFragment(['Tsinelas']);

        // Not detected by the cameras until a model is trained with it.
        $this->assertNotContains('Tsinelas', ClassRegistry::live());
        $this->assertContains('Tsinelas', ClassRegistry::trainable());
    }

    public function test_a_new_model_class_is_detected_and_saved(): void
    {
        SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
        Camera::query()->create(['camera_code' => 'CAM-01', 'camera_name' => 'Paco', 'monitoring_location' => 'Paco Beach', 'status' => 'Online']);
        ClassRegistry::saveModelClasses([...ClassRegistry::live(), 'Tsinelas']);

        $this->assertContains('Tsinelas', ClassRegistry::live());
        $this->withHeader('X-Detector-Key', (string) config('services.detector.key'))
            ->getJson('/api/settings/detection')
            ->assertOk()
            ->assertJsonFragment(['Tsinelas']);

        $this->withHeader('X-Detector-Key', (string) config('services.detector.key'))
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [[
                    'class' => 'Tsinelas',
                    'confidence' => 0.88,
                    'left' => 10, 'top' => 20, 'width' => 15, 'height' => 25,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $detection = Detection::query()->with('classification.category')->firstOrFail();
        $this->assertSame('Tsinelas', $detection->classification->waste_type);
    }

    public function test_new_class_blocks_training_only_once_it_has_samples(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $category = $this->actingAs($admin)->postJson('/api/waste-catalog/categories', ['name' => 'Rubber'])->json('id');
        $this->actingAs($admin)->postJson('/api/waste-catalog/classifications', ['category_id' => $category, 'name' => 'Tsinelas']);

        $plan = collect(TrainingSamplePlan::summary()['classes'])->firstWhere('name', 'Tsinelas');
        $this->assertNotNull($plan, 'The new class is listed in Approved by class.');
        $this->assertTrue($plan['optional'], 'No samples yet: it does not block training.');
        $this->assertNotContains('Tsinelas', TrainingSamplePlan::requiredClasses());
    }

    public function test_rollback_list_falls_back_to_the_original_classes(): void
    {
        ClassRegistry::saveModelClasses(['Can', 'Tsinelas']);
        $this->assertSame(['Can', 'Tsinelas'], ClassRegistry::live());

        ClassRegistry::saveModelClasses([]);
        $this->assertCount(11, ClassRegistry::live());
    }
}
