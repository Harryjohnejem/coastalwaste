<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * When a saved live detection was copied into Detection Reviews.
 * Set once, so a review the user deletes is not created again.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->timestamp('auto_reviewed_at')->nullable()->after('moved_to_review');
        });
    }

    public function down(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->dropColumn('auto_reviewed_at');
        });
    }
};
