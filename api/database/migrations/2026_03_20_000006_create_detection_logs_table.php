<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('detection_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('detection_id')
                ->constrained('detections')
                ->cascadeOnDelete();
            $table->unsignedBigInteger('frame_number')->nullable();
            $table->string('model_name', 120)->nullable();
            $table->string('model_version', 64)->nullable();
            $table->string('raw_label', 120);
            $table->decimal('confidence', 5, 2);
            $table->unsignedInteger('processing_time_ms')->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index('detection_id');
            $table->index('created_at');
            $table->index('model_name');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('detection_logs');
    }
};
