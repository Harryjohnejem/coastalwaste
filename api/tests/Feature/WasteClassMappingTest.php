<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\Notification;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use App\Support\DetectionNotifier;
use App\Support\WasteClassifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WasteClassMappingTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        \App\Models\SystemSetting::saveDefault(['detection' => ['enabled' => true], 'alerts' => ['detectionAlerts' => true]]);
    }

    private function catalog(): WasteCategory
    {
        $category = WasteCategory::query()->create([
            'category_name' => 'Plastic',
        ]);
        foreach (['Ecobag', 'Plastic Bag', 'Other Plastic', 'Plastic Bottle'] as $type) {
            WasteClassification::query()->create([
                'category_id' => $category->id,
                'waste_type' => $type,
            ]);
        }

        return $category;
    }

    public function test_ecobag_and_plastic_bag_resolve_to_different_classifications(): void
    {
        $this->catalog();

        $ecobag = WasteClassifier::resolve('Ecobag');
        $plasticBag = WasteClassifier::resolve('Plastic Bag');

        $this->assertSame('Ecobag', $ecobag->waste_type);
        $this->assertSame('Plastic Bag', $plasticBag->waste_type);
        $this->assertNotSame($ecobag->id, $plasticBag->id);
        $this->assertSame('Face Mask', WasteClassifier::resolve('Face Mask')->waste_type);
    }

    public function test_styrofoam_and_ecobag_keep_their_own_names(): void
    {
        $category = $this->catalog();
        WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => 'Styrofoam',
        ]);

        $this->assertSame('Styrofoam', WasteClassifier::resolve('Styrofoam')->waste_type);
        $this->assertSame('Ecobag', WasteClassifier::resolve('Ecobag')->waste_type);
        $this->assertSame('Can', WasteClassifier::resolve('Can')->waste_type);
        $this->assertSame('Paper Drink Carton', WasteClassifier::resolve('Paper Drink Carton')->waste_type);
        $this->assertSame('Plastic Wrapper', WasteClassifier::resolve('Plastic Wrapper')->waste_type);
        $this->assertSame('Styro Cup', WasteClassifier::resolve('Styro Cup')->waste_type);
        $this->assertNotSame(
            WasteClassifier::resolve('Styrofoam')->id,
            WasteClassifier::resolve('Ecobag')->id,
        );
    }

    public function test_ecobag_detection_notifies_ecobag_not_plastic_bag(): void
    {
        $this->catalog();
        Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Sector B',
            'status' => 'Online',
        ]);
        User::factory()->create([
            'role' => 'Admin',
            'email' => 'admin@example.com',
        ]);

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-ecobag',
                'model' => 'YOLOv11n ONNX · best.onnx',
                'detections' => [[
                    'class' => 'Ecobag',
                    'confidence' => 0.8113,
                    'subtitle' => 'Track 19 · YOLO · CAM-01',
                    'sector' => 'Sector B',
                ]],
            ])
            ->assertOk();

        $detection = Detection::query()->with('classification')->first();
        $this->assertNotNull($detection);
        $this->assertSame('Ecobag', $detection->classification->waste_type);
        $this->assertSame('Ecobag', $detection->logs()->value('raw_label'));

        $message = Notification::query()->where('detection_id', $detection->id)->value('message');
        $this->assertIsString($message);
        $this->assertStringContainsString('A new Ecobag was detected', $message);
        $this->assertStringNotContainsString('Plastic Bag', $message);
    }

    public function test_plastic_bag_notification_keeps_its_own_label(): void
    {
        $this->catalog();
        $camera = Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Sector B',
            'status' => 'Online',
        ]);
        User::factory()->create([
            'role' => 'Admin',
            'email' => 'admin@example.com',
        ]);
        $classification = WasteClassification::query()->where('waste_type', 'Plastic Bag')->first();
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Sector B',
            'detected_at' => now(),
            'status' => 'Present',
        ]);

        DetectionNotifier::notifyNewDetection($detection);

        $message = Notification::query()->value('message');
        $this->assertStringContainsString('A new Plastic Bag was detected', $message);
        $this->assertStringNotContainsString('Ecobag', $message);
    }
}
