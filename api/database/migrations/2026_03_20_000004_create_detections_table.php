<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('detections', function (Blueprint $table) {
            $table->id();
            $table->foreignId('camera_id')
                ->constrained('cameras')
                ->cascadeOnDelete();
            $table->foreignId('classification_id')
                ->constrained('waste_classifications')
                ->restrictOnDelete();
            $table->decimal('confidence', 5, 2);
            $table->unsignedInteger('quantity')->default(1);
            $table->string('location', 120);
            $table->dateTime('detected_at');
            $table->enum('status', ['Detected', 'Verified', 'Ignored'])->default('Detected');
            $table->timestamps();

            $table->index('detected_at');
            $table->index('status');
            $table->index(['camera_id', 'detected_at']);
            $table->index(['classification_id', 'detected_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('detections');
    }
};
