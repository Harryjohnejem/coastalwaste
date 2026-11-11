<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('detection_observations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('detection_id')
                ->constrained('detections')
                ->cascadeOnDelete();
            $table->foreignId('camera_id')
                ->constrained('cameras')
                ->cascadeOnDelete();
            $table->unsignedBigInteger('track_id')->nullable();
            $table->string('tracker_session', 64)->nullable();
            $table->string('raw_label', 120);
            $table->decimal('confidence', 5, 2)->nullable();
            $table->decimal('box_left', 8, 2)->nullable();
            $table->decimal('box_top', 8, 2)->nullable();
            $table->decimal('box_width', 8, 2)->nullable();
            $table->decimal('box_height', 8, 2)->nullable();
            $table->json('histogram')->nullable();
            $table->dateTime('observed_at');
            $table->timestamps();

            $table->index(['detection_id', 'observed_at']);
            $table->index(['camera_id', 'observed_at']);
            $table->unique(['camera_id', 'tracker_session', 'track_id'], 'detection_observations_camera_track_unique');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('detection_observations');
    }
};
