<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cameras', function (Blueprint $table) {
            $table->string('id', 32)->primary();
            $table->string('name');
            $table->string('sector')->default('Sector A');
            $table->string('stream_url')->nullable();
            $table->string('protocol')->default('RTSP');
            $table->string('transport')->default('TCP');
            $table->string('username')->nullable();
            $table->string('password')->nullable();
            $table->string('status')->default('offline');
            $table->unsignedSmallInteger('detections_per_hour')->nullable();
            $table->string('resolution')->default('1920 × 1080');
            $table->string('fps')->default('25 FPS');
            $table->boolean('detection_enabled')->default(true);
            $table->boolean('in_grid')->default(true);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cameras');
    }
};
