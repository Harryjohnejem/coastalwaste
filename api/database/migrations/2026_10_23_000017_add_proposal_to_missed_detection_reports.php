<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->string('proposal_label', 120)->nullable()->after('description');
            $table->json('proposal')->nullable()->after('proposal_label');
        });
    }

    public function down(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->dropColumn(['proposal_label', 'proposal']);
        });
    }
};
