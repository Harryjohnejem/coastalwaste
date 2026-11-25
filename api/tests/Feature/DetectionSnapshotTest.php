<?php

namespace Tests\Feature;

use App\Models\Camera;
use App\Models\Detection;
use App\Models\DetectionImage;
use App\Models\DetectionLog;
use App\Models\MissedDetectionAnnotation;
use App\Models\MissedDetectionReport;
use App\Models\User;
use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class DetectionSnapshotTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        \App\Models\SystemSetting::saveDefault(['detection' => ['enabled' => true]]);
    }

    private function camera(): Camera
    {
        return Camera::query()->create([
            'camera_code' => 'CAM-01',
            'camera_name' => 'Wide-Angle Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
    }

    private function classification(string $type = 'Plastic Bottle'): WasteClassification
    {
        $category = WasteCategory::query()->firstOrCreate(['category_name' => 'Plastic']);

        return WasteClassification::query()->create([
            'category_id' => $category->id,
            'waste_type' => $type,
        ]);
    }

    public function test_detection_list_returns_present_and_no_longer_visible_rows(): void
    {
        $camera = $this->camera();
        $classification = $this->classification();
        $admin = User::factory()->create(['role' => 'Admin']);
        $present = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 86,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        $cleaned = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 84,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinute(),
            'status' => 'No Longer Visible',
        ]);

        $this->actingAs($admin)
            ->getJson('/api/detections')
            ->assertOk()
            ->assertJsonFragment(['id' => $present->id, 'status' => 'Present'])
            ->assertJsonFragment(['id' => $cleaned->id, 'status' => 'No Longer Visible']);
    }

    public function test_live_query_returns_only_the_selected_cameras_present_rows(): void
    {
        $camera = $this->camera();
        $other = Camera::query()->create([
            'camera_code' => 'CAM-02',
            'camera_name' => 'Second Lens',
            'monitoring_location' => 'Paco Beach',
            'status' => 'Online',
        ]);
        $classification = $this->classification();
        $admin = User::factory()->create(['role' => 'Admin']);
        $here = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        Detection::query()->create([
            'camera_id' => $other->id,
            'classification_id' => $classification->id,
            'confidence' => 88,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 80,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now()->subMinute(),
            'status' => 'No Longer Visible',
        ]);

        $response = $this->actingAs($admin)
            ->getJson('/api/detections?camera_id=CAM-01&status=Present')
            ->assertOk()
            ->json();

        $this->assertCount(1, $response);
        $this->assertSame($here->id, $response[0]['id']);
        $this->assertSame('Present', $response[0]['status']);
        $this->assertSame('CAM-01', $response[0]['camera_id']);
    }

    public function test_api_keeps_styrofoam_class_and_plastic_category(): void
    {
        $camera = $this->camera();
        $classification = $this->classification('Styrofoam');
        $detection = Detection::query()->create([
            'camera_id' => $camera->id,
            'classification_id' => $classification->id,
            'confidence' => 90,
            'quantity' => 1,
            'location' => 'Paco Beach',
            'detected_at' => now(),
            'status' => 'Present',
        ]);
        DetectionLog::query()->create([
            'detection_id' => $detection->id,
            'raw_label' => 'Styrofoam',
            'confidence' => 90,
            'model_name' => 'YOLOv11n ONNX · best.onnx',
            'created_at' => now(),
        ]);

        $payload = $detection->fresh()->toApiArray();

        $this->assertSame('Styrofoam', $payload['class']);
        $this->assertSame('Plastic', $payload['waste_category']);
        $this->assertNull($payload['snapshot_url']);
    }

    public function test_successful_snapshot_is_stored_and_linked(): void
    {
        Storage::fake('public');
        $this->camera();
        $this->classification();
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-snap',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 4 · YOLO · CAM-01',
                    'sector' => 'Paco Beach',
                    'snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $image = DetectionImage::query()->first();
        $this->assertNotNull($image);
        Storage::disk('public')->assertExists($image->image_path);
        $this->assertSame('/storage/'.$image->image_path, Detection::query()->first()->toApiArray()['snapshot_url']);
    }

    public function test_failed_snapshot_write_does_not_create_an_image_row(): void
    {
        $this->camera();
        $this->classification();
        $disk = new class
        {
            public function put(string $path, string $contents): bool
            {
                return false;
            }
        };
        Storage::shouldReceive('disk')->twice()->with('public')->andReturn($disk);
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-snap-fail',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 8 · YOLO · CAM-01',
                    'sector' => 'Paco Beach',
                    'snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $this->assertSame(1, Detection::query()->count());
        $this->assertSame(0, DetectionImage::query()->count());
        $this->assertNull(Detection::query()->first()->toApiArray()['snapshot_url']);
    }

    public function test_per_class_limit_keeps_the_newest_hits_of_each_class(): void
    {
        $camera = $this->camera();
        $bottle = $this->classification('Plastic Bottle');
        $can = $this->classification('Can');
        $admin = User::factory()->create(['role' => 'Admin']);
        $store = function (WasteClassification $class, int $minutesAgo) use ($camera): Detection {
            return Detection::query()->create([
                'camera_id' => $camera->id,
                'classification_id' => $class->id,
                'confidence' => 80,
                'quantity' => 1,
                'location' => 'Paco Beach',
                'detected_at' => now()->subMinutes($minutesAgo),
                'status' => 'Present',
            ]);
        };
        $oldBottle = $store($bottle, 30);
        $midBottle = $store($bottle, 10);
        $newBottle = $store($bottle, 1);
        $oldCan = $store($can, 25);
        $midCan = $store($can, 12);
        $newCan = $store($can, 2);

        $ids = collect($this->actingAs($admin)
            ->getJson('/api/detections?per_class=1&limit=2')
            ->assertOk()
            ->json())
            ->pluck('id')
            ->all();

        sort($ids);
        $expected = [$midBottle->id, $newBottle->id, $midCan->id, $newCan->id];
        sort($expected);
        $this->assertSame($expected, $ids);
        $this->assertNotContains($oldBottle->id, $ids);
        $this->assertNotContains($oldCan->id, $ids);
    }

    public function test_review_list_caps_the_newest_hits_of_each_class(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);
        $make = function (string $class) use ($admin): MissedDetectionReport {
            $report = MissedDetectionReport::query()->create([
                'user_id' => $admin->id,
                'description' => $class,
                'image_path' => 'missed/test.jpg',
                'image_name' => 'test.jpg',
                'status' => 'pending',
                'proposal_label' => $class,
            ]);
            MissedDetectionAnnotation::query()->create([
                'report_id' => $report->id,
                'class_name' => $class,
                'class_index' => 0,
                'x' => 0.5,
                'y' => 0.5,
                'width' => 0.2,
                'height' => 0.2,
            ]);

            return $report;
        };
        $oldBottle = $make('Plastic Bottle');
        $midBottle = $make('Plastic Bottle');
        $newBottle = $make('Plastic Bottle');
        MissedDetectionAnnotation::query()->create([
            'report_id' => $newBottle->id,
            'class_name' => 'Plastic Bottle',
            'class_index' => 0,
            'x' => 0.2,
            'y' => 0.2,
            'width' => 0.2,
            'height' => 0.2,
        ]);
        $oldCan = $make('Can');
        $newCan = $make('Can');

        $ids = collect($this->actingAs($admin)
            ->getJson('/api/missed-detections?per_class=1&per_page=2')
            ->assertOk()
            ->json('data'))
            ->pluck('id')
            ->all();

        sort($ids);
        $expected = [$midBottle->id, $newBottle->id, $oldCan->id, $newCan->id];
        sort($expected);
        $this->assertSame($expected, $ids);
        $this->assertNotContains($oldBottle->id, $ids);

        $pageOne = $this->actingAs($admin)
            ->getJson('/api/missed-detections?per_class=1&per_page=2&page_size=3&page=1')
            ->assertOk()
            ->assertJsonPath('meta.total', 4)
            ->assertJsonPath('meta.per_page', 3)
            ->assertJsonPath('meta.last_page', 2)
            ->assertJsonCount(3, 'data')
            ->json('data');
        $pageTwo = $this->actingAs($admin)
            ->getJson('/api/missed-detections?per_class=1&per_page=2&page_size=3&page=2')
            ->assertOk()
            ->assertJsonPath('meta.page', 2)
            ->assertJsonCount(1, 'data')
            ->json('data');
        $paged = collect([...$pageOne, ...$pageTwo])->pluck('id')->sort()->values()->all();
        $this->assertSame($expected, $paged);

        $newBottle->update(['status' => 'approved']);
        $counts = collect($this->actingAs($admin)
            ->getJson('/api/missed-detections?class_counts=1&per_class=1&per_page=2')
            ->assertOk()
            ->json('classes'))
            ->pluck('count', 'name');
        $this->assertSame(2, (int) $counts['Plastic Bottle']);
        $this->assertSame(2, (int) $counts['Can']);

        $approved = collect($this->actingAs($admin)
            ->getJson('/api/missed-detections?class_counts=1&per_class=1&per_page=2&status=approved')
            ->assertOk()
            ->json('classes'))
            ->pluck('count', 'name');
        $this->assertSame(1, (int) $approved['Plastic Bottle']);
        $this->assertFalse($approved->has('Can'));
    }

    public function test_eighty_percent_and_up_is_not_copied_to_reviews(): void
    {
        Storage::fake('public');
        User::factory()->create(['role' => 'Admin']);
        $this->camera();
        $this->classification();
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-auto',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.86,
                    'subtitle' => 'Track 7 · YOLO · CAM-01',
                    'left' => 10, 'top' => 20, 'width' => 15, 'height' => 25,
                    'snapshot' => $jpeg,
                    'review_snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 1);

        $this->assertSame(1, Detection::query()->count(), '80%+ is saved in Waste Detections.');
        $this->assertSame(0, MissedDetectionReport::query()->count(), 'Detection Reviews gets 60-79% only.');
    }

    public function test_below_eighty_percent_goes_to_reviews_only(): void
    {
        Storage::fake('public');
        User::factory()->create(['role' => 'Admin']);
        $this->camera();
        $this->classification();
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'tracker_session' => 'session-low',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.72,
                    'subtitle' => 'Track 9 · YOLO · CAM-01',
                    'left' => 10, 'top' => 20, 'width' => 15, 'height' => 25,
                    'review_only' => true,
                    'review_snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 0)
            ->assertJsonPath('reviews.0.subtitle', 'Track 9');

        $this->assertSame(0, Detection::query()->count(), 'Below 80% is not saved in Waste Detections.');
        $review = MissedDetectionReport::query()->firstOrFail();
        $this->assertNull($review->source_detection_id);
        $this->assertSame('pending', $review->status);
        $this->assertSame(1, $review->annotations()->count());
        Storage::disk('public')->assertExists($review->image_path);
    }

    public function test_below_sixty_percent_is_not_saved_for_review(): void
    {
        Storage::fake('public');
        User::factory()->create(['role' => 'Admin']);
        $this->camera();
        $this->classification();
        $jpeg = base64_encode((string) file_get_contents(base_path('tests/fixtures/pixel.jpg')));

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.55,
                    'left' => 10, 'top' => 20, 'width' => 15, 'height' => 25,
                    'review_only' => true,
                    'review_snapshot' => $jpeg,
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('logged', 0)
            ->assertJsonCount(0, 'reviews');

        $this->assertSame(0, MissedDetectionReport::query()->count(), 'Default review range is 60-79%.');
        $this->assertSame(0, Detection::query()->count());
    }

    public function test_server_keeps_low_confidence_out_of_waste_detections(): void
    {
        Storage::fake('public');
        User::factory()->create(['role' => 'Admin']);
        $this->camera();
        $this->classification();

        $this->withHeader('X-Detector-Key', 'tidalwatch-detector-local')
            ->postJson('/api/detections/live', [
                'camera_id' => 'CAM-01',
                'detections' => [[
                    'class' => 'Plastic Bottle',
                    'confidence' => 0.79,
                    'subtitle' => 'Track 3 · YOLO · CAM-01',
                ]],
            ])
            ->assertOk();

        $this->assertSame(0, Detection::query()->count());
    }
}
