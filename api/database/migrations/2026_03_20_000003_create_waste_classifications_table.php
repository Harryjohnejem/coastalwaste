<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('waste_classifications', function (Blueprint $table) {
            $table->id();
            $table->foreignId('category_id')
                ->constrained('waste_categories')
                ->cascadeOnDelete();
            $table->string('waste_type', 120);
            $table->timestamps();

            $table->unique(['category_id', 'waste_type']);
            $table->index('waste_type');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('waste_classifications');
    }
};
