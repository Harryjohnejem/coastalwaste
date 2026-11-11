<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->boolean('include_in_export')->default(false)->after('status');
        });
    }

    public function down(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->dropColumn('include_in_export');
        });
    }
};
