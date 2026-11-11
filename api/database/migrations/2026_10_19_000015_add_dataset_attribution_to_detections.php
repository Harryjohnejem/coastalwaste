<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Training-dataset metadata vs per-detection attribution.
 *
 * Local 1 + Local 2 were merged into one YOLO model, so live predictions
 * cannot be attributed to either training subset. New rows store an explicit
 * "not attributable" status. Historical rows stay NULL (shown as Unknown).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            // Which training set(s) the live model was built from (model metadata).
            $table->string('training_dataset', 80)->nullable()->after('status');
            // Per-detection attribution: local_1 | local_2 | combined_not_attributable | unknown
            $table->string('dataset_attribution', 40)->nullable()->after('training_dataset');
        });
    }

    public function down(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->dropColumn(['training_dataset', 'dataset_attribution']);
        });
    }
};
