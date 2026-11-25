<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->string('original_prediction', 120)->nullable()->after('proposal_label');
            $table->decimal('original_prediction_confidence', 7, 5)->nullable()->after('original_prediction');
            $table->json('original_model_boxes')->nullable()->after('original_prediction_confidence');
            $table->foreignId('corrected_by')->nullable()->after('reviewed_by')->constrained('users')->nullOnDelete();
            $table->timestamp('corrected_at')->nullable()->after('corrected_by');
            $table->foreignId('approved_by')->nullable()->after('corrected_at')->constrained('users')->nullOnDelete();
            $table->timestamp('approved_at')->nullable()->after('approved_by');
        });
        DB::table('missed_detection_reports')
            ->where('status', 'verified')
            ->update(['status' => 'corrected']);
        DB::table('missed_detection_reports')
            ->whereNull('original_prediction')
            ->whereNotNull('proposal_label')
            ->update(['original_prediction' => DB::raw('proposal_label')]);
    }

    public function down(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->dropConstrainedForeignId('corrected_by');
            $table->dropConstrainedForeignId('approved_by');
            $table->dropColumn([
                'original_prediction',
                'original_prediction_confidence',
                'original_model_boxes',
                'corrected_at',
                'approved_at',
            ]);
        });
    }
};
