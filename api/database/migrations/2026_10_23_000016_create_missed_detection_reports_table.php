<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('missed_detection_reports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('camera_id')->nullable()->constrained('cameras')->nullOnDelete();
            $table->foreignId('source_detection_id')->nullable()->constrained('detections')->nullOnDelete();
            $table->text('description');
            $table->string('image_path', 500);
            $table->string('image_name', 255);
            $table->string('status', 32)->default('pending');
            $table->foreignId('reviewed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('reviewed_at')->nullable();
            $table->string('rejection_note', 500)->nullable();
            $table->timestamps();

            $table->index('status');
            $table->index('created_at');
        });

        Schema::create('missed_detection_annotations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('report_id')
                ->constrained('missed_detection_reports')
                ->cascadeOnDelete();
            $table->string('class_name', 120);
            $table->unsignedSmallInteger('class_index');
            $table->decimal('x', 8, 6);
            $table->decimal('y', 8, 6);
            $table->decimal('width', 8, 6);
            $table->decimal('height', 8, 6);
            $table->timestamps();

            $table->index('report_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('missed_detection_annotations');
        Schema::dropIfExists('missed_detection_reports');
    }
};
