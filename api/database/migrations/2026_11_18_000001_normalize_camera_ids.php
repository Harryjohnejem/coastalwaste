<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        DB::transaction(function () {
            $target = DB::table('cameras')->where('camera_code', 'CAM-03')->first()
                ?? DB::table('cameras')->where('camera_code', 'CAM-02')->first();

            if ($target) {
                $sourceIds = DB::table('cameras')
                    ->whereIn('camera_code', ['CAM-02', 'CAM-04'])
                    ->where('id', '!=', $target->id)
                    ->pluck('id');

                foreach (['detection_observations', 'detections', 'missed_detection_reports'] as $table) {
                    if ($sourceIds->isNotEmpty() && Schema::hasTable($table) && Schema::hasColumn($table, 'camera_id')) {
                        DB::table($table)->whereIn('camera_id', $sourceIds)->update(['camera_id' => $target->id]);
                    }
                }

                if ($sourceIds->isNotEmpty()) {
                    DB::table('cameras')->whereIn('id', $sourceIds)->delete();
                }

                DB::table('cameras')->where('id', $target->id)->update([
                    'camera_code' => 'CAM-02',
                    'camera_name' => 'Paco Wide-Angle',
                    'monitoring_location' => 'Paco Beach',
                    'updated_at' => now(),
                ]);
            }

            DB::table('cameras')->where('camera_code', 'CAM-01')->update([
                'camera_name' => 'Paco Wide-Angle',
                'monitoring_location' => 'Paco Beach',
                'updated_at' => now(),
            ]);
        });
    }

    public function down(): void
    {
        // Historical camera references are intentionally consolidated and cannot be split safely.
    }
};
