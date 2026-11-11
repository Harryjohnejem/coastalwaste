<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cameras', function (Blueprint $table) {
            $table->id();
            $table->string('camera_code', 32)->unique();
            $table->string('camera_name');
            $table->string('monitoring_location');
            $table->string('ip_address', 45)->nullable();
            $table->enum('status', ['Online', 'Offline'])->default('Offline');
            $table->timestamp('last_seen')->nullable();

            // Live-stream fields (depend only on camera PK — still 3NF)
            $table->string('stream_url', 2048)->nullable();
            $table->string('protocol', 64)->default('RTSP');
            $table->string('transport', 16)->default('TCP');
            $table->string('username')->nullable();
            $table->string('password')->nullable();
            $table->string('resolution')->default('1920 × 1080');
            $table->string('fps')->default('25 FPS');
            $table->boolean('detection_enabled')->default(true);
            $table->boolean('in_grid')->default(true);

            $table->timestamps();

            $table->index('status');
            $table->index('monitoring_location');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cameras');
    }
};
