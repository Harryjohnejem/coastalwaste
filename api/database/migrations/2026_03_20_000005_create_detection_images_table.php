<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('detection_images', function (Blueprint $table) {
            $table->id();
            $table->foreignId('detection_id')
                ->constrained('detections')
                ->cascadeOnDelete();
            $table->string('image_path', 500);
            $table->string('image_name', 255);
            $table->dateTime('captured_at');
            $table->timestamps();

            $table->index('detection_id');
            $table->index('captured_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('detection_images');
    }
};
