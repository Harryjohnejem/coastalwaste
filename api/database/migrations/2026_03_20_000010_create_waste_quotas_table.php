<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('waste_quotas', function (Blueprint $table) {
            $table->id();
            $table->string('name', 160);
            $table->foreignId('camera_id')
                ->nullable()
                ->constrained('cameras')
                ->nullOnDelete();
            $table->foreignId('category_id')
                ->nullable()
                ->constrained('waste_categories')
                ->nullOnDelete();
            $table->unsignedInteger('quota_limit');
            $table->enum('period', ['daily', 'weekly', 'monthly'])->default('daily');
            $table->text('cleanup_recommendation');
            $table->boolean('is_active')->default(true);
            $table->timestamps();

            $table->index(['is_active', 'period']);
            $table->index(['camera_id', 'category_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('waste_quotas');
    }
};
