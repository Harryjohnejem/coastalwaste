<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            // The live model that made the detection, e.g. "YOLO11l".
            $table->string('training_model', 120)->nullable()->after('training_dataset');
        });
    }

    public function down(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->dropColumn('training_model');
        });
    }
};
