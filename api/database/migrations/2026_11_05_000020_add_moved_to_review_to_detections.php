<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->boolean('moved_to_review')->default(false)->after('status');
            $table->index(['moved_to_review', 'detected_at']);
            $table->index(['moved_to_review', 'status']);
        });

        $ids = DB::table('missed_detection_reports')
            ->whereNotNull('source_detection_id')
            ->pluck('source_detection_id');
        if ($ids->isNotEmpty()) {
            DB::table('detections')->whereIn('id', $ids)->update(['moved_to_review' => true]);
        }
    }

    public function down(): void
    {
        Schema::table('detections', function (Blueprint $table) {
            $table->dropIndex(['moved_to_review', 'detected_at']);
            $table->dropIndex(['moved_to_review', 'status']);
            $table->dropColumn('moved_to_review');
        });
    }
};
