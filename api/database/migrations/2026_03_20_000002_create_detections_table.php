<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('detections', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('camera_id', 32)->nullable();
            $table->string('class_label');
            $table->decimal('confidence', 5, 4)->nullable();
            $table->unsignedSmallInteger('count')->default(1);
            $table->string('sector')->nullable();
            $table->timestamp('detected_at');
            $table->string('severity')->default('alert');
            $table->string('subtitle')->nullable();
            $table->timestamps();

            $table->foreign('camera_id')->references('id')->on('cameras')->nullOnDelete();
            $table->index('detected_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('detections');
    }
};
