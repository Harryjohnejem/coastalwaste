<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Waste statuses that do not claim cleaning that nobody checked:
 *   "Confirmed Cleaned" (set automatically when waste left the camera view)
 *   becomes "No Longer Visible". Only a person can set "Cleaning Verified",
 *   and who did it and when is stored here. Records are kept; only the
 *   status name of the automatic ones changes.
 * Safe to run again if an earlier attempt stopped half way.
 */
return new class extends Migration
{
    private const ALL = "'Detected', 'Verified', 'Ignored', 'Present', 'Confirmed Cleaned', 'No Longer Visible', 'Cleaning Verified'";

    public function up(): void
    {
        if (Schema::getConnection()->getDriverName() === 'mysql') {
            DB::statement('ALTER TABLE detections MODIFY status ENUM('.self::ALL.") NOT NULL DEFAULT 'Detected'");
        }

        if (! Schema::hasColumn('detections', 'cleaning_verified_by')) {
            Schema::table('detections', function (Blueprint $table) {
                $table->foreignId('cleaning_verified_by')->nullable()->after('removal_reason')
                    ->constrained('users')->nullOnDelete();
            });
        }
        if (! Schema::hasColumn('detections', 'cleaning_verified_at')) {
            Schema::table('detections', function (Blueprint $table) {
                $table->timestamp('cleaning_verified_at')->nullable()->after('cleaning_verified_by');
            });
        }

        DB::table('detections')->where('status', 'Confirmed Cleaned')->update(['status' => 'No Longer Visible']);
    }

    public function down(): void
    {
        DB::table('detections')->whereIn('status', ['No Longer Visible', 'Cleaning Verified'])
            ->update(['status' => 'Confirmed Cleaned']);

        if (Schema::hasColumn('detections', 'cleaning_verified_by')) {
            Schema::table('detections', function (Blueprint $table) {
                $table->dropConstrainedForeignId('cleaning_verified_by');
            });
        }
        if (Schema::hasColumn('detections', 'cleaning_verified_at')) {
            Schema::table('detections', function (Blueprint $table) {
                $table->dropColumn('cleaning_verified_at');
            });
        }

        if (Schema::getConnection()->getDriverName() === 'mysql') {
            DB::statement(
                "ALTER TABLE detections MODIFY status ENUM('Detected', 'Verified', 'Ignored', 'Present', 'Confirmed Cleaned') NOT NULL DEFAULT 'Detected'"
            );
        }
    }
};
