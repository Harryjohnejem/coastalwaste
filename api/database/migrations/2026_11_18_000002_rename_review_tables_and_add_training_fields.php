<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Detection Reviews schema:
 * - missed_detection_reports     -> detection_reviews
 * - missed_detection_annotations -> detection_review_annotations (+ status)
 * - training_jobs                -> + total_valid_samples
 * - training_job_items           -> + annotation_id, class_name, inclusion_status, validation_status
 *
 * Tables are renamed, not recreated, so every review row and foreign key is kept.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::rename('missed_detection_reports', 'detection_reviews');
        Schema::rename('missed_detection_annotations', 'detection_review_annotations');

        Schema::table('detection_review_annotations', function (Blueprint $table) {
            $table->string('status', 32)->default('pending')->after('height');
            $table->index('status');
        });

        Schema::table('training_jobs', function (Blueprint $table) {
            $table->unsignedInteger('total_valid_samples')->default(0)->after('dataset_version');
        });

        Schema::table('training_job_items', function (Blueprint $table) {
            $table->foreignId('annotation_id')->nullable()->after('report_id')
                ->constrained('detection_review_annotations')->nullOnDelete();
            $table->string('class_name', 255)->nullable()->after('annotation_id');
            $table->string('inclusion_status', 24)->default('included')->after('split');
            $table->string('validation_status', 24)->default('pending')->after('inclusion_status');
        });

        // Fill the new columns from the data already stored.
        DB::table('detection_review_annotations')->update([
            'status' => DB::raw('(SELECT detection_reviews.status FROM detection_reviews WHERE detection_reviews.id = detection_review_annotations.report_id)'),
        ]);

        DB::table('training_jobs')->update([
            'total_valid_samples' => DB::raw('(SELECT COUNT(*) FROM training_job_items WHERE training_job_items.training_job_id = training_jobs.id)'),
        ]);

        DB::table('training_job_items')->orderBy('id')->each(function ($item) {
            $annotations = DB::table('detection_review_annotations')
                ->where('report_id', $item->report_id)
                ->orderBy('id')
                ->get(['id', 'class_name']);
            DB::table('training_job_items')->where('id', $item->id)->update([
                'annotation_id' => $annotations->first()?->id,
                'class_name' => $annotations->pluck('class_name')->unique()->implode(', ') ?: null,
                'validation_status' => $item->upload_status === 'failed' ? 'invalid' : 'valid',
            ]);
        });
    }

    public function down(): void
    {
        Schema::table('training_job_items', function (Blueprint $table) {
            $table->dropConstrainedForeignId('annotation_id');
            $table->dropColumn(['class_name', 'inclusion_status', 'validation_status']);
        });

        Schema::table('training_jobs', function (Blueprint $table) {
            $table->dropColumn('total_valid_samples');
        });

        Schema::table('detection_review_annotations', function (Blueprint $table) {
            $table->dropIndex(['status']);
            $table->dropColumn('status');
        });

        Schema::rename('detection_review_annotations', 'missed_detection_annotations');
        Schema::rename('detection_reviews', 'missed_detection_reports');
    }
};
