<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('reports', function (Blueprint $table) {
            $table->id();
            $table->string('report_number', 64)->unique();
            $table->enum('report_type', ['Summary', 'Detailed']);
            $table->foreignId('generated_by')
                ->constrained('users')
                ->restrictOnDelete();
            $table->string('monitoring_period', 120);
            $table->decimal('average_confidence', 5, 2)->nullable();
            $table->dateTime('generated_at');
            $table->text('remarks')->nullable();
            $table->text('recommendations')->nullable();
            $table->timestamps();

            $table->index('report_type');
            $table->index('generated_at');
            $table->index('generated_by');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('reports');
    }
};
