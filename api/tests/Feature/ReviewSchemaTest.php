<?php

namespace Tests\Feature;

use App\Models\MissedDetectionAnnotation;
use App\Models\MissedDetectionReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class ReviewSchemaTest extends TestCase
{
    use RefreshDatabase;

    public function test_review_tables_use_the_new_names_and_columns(): void
    {
        $this->assertTrue(Schema::hasTable('detection_reviews'));
        $this->assertTrue(Schema::hasTable('detection_review_annotations'));
        $this->assertFalse(Schema::hasTable('missed_detection_reports'));
        $this->assertFalse(Schema::hasTable('missed_detection_annotations'));
        $this->assertTrue(Schema::hasColumn('detection_review_annotations', 'status'));
        $this->assertTrue(Schema::hasColumn('training_jobs', 'total_valid_samples'));
        $this->assertTrue(Schema::hasColumns('training_job_items', [
            'annotation_id', 'class_name', 'inclusion_status', 'validation_status',
        ]));
    }

    public function test_annotation_status_follows_its_review(): void
    {
        $user = User::factory()->create(['role' => 'Admin']);
        $report = MissedDetectionReport::query()->create([
            'user_id' => $user->id,
            'description' => 'Can',
            'image_path' => 'missed/test.jpg',
            'image_name' => 'test.jpg',
            'status' => MissedDetectionReport::PENDING,
        ]);
        $box = MissedDetectionAnnotation::query()->create([
            'report_id' => $report->id,
            'class_name' => 'Can',
            'class_index' => 0,
            'x' => 0.1,
            'y' => 0.1,
            'width' => 0.2,
            'height' => 0.2,
        ]);
        $this->assertSame('pending', $box->fresh()->status);

        $report->update(['status' => MissedDetectionReport::APPROVED]);
        $this->assertSame('approved', $box->fresh()->status);

        MissedDetectionReport::query()->whereKey($report->id)->update(['status' => MissedDetectionReport::EXPORTED]);
        MissedDetectionReport::syncAnnotationStatus([$report->id]);
        $this->assertSame('exported', $box->fresh()->status);
    }
}
