<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::getConnection()->getDriverName() === 'mysql') {
            DB::statement(
                "ALTER TABLE detections MODIFY status ENUM('Detected', 'Verified', 'Ignored', 'Present', 'Confirmed Cleaned') NOT NULL DEFAULT 'Detected'"
            );
        } else {
            Schema::table('detections', function (Blueprint $table) {
                $table->string('status', 32)->default('Detected')->change();
            });
        }

        Schema::table('detections', function (Blueprint $table) {
            $table->dateTime('last_seen_at')->nullable()->after('detected_at');
            $table->dateTime('removed_at')->nullable()->after('last_seen_at');
            $table->string('removal_reason', 64)->nullable()->after('removed_at');
            $table->uuid('object_key')->nullable()->after('removal_reason');
            $table->index('last_seen_at');
            $table->index('object_key');
        });
    }

    public function down(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->dropIndex(['last_seen_at']);
            $table->dropIndex(['object_key']);
            $table->dropColumn(['last_seen_at', 'removed_at', 'removal_reason', 'object_key']);
        });

        if (Schema::getConnection()->getDriverName() === 'mysql') {
            DB::statement(
                "ALTER TABLE detections MODIFY status ENUM('Detected', 'Verified', 'Ignored') NOT NULL DEFAULT 'Detected'"
            );
        }
    }
};
