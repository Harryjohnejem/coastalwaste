<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('training_jobs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('started_by')->constrained('users')->cascadeOnDelete();
            $table->string('status', 40)->default('preparing');
            $table->string('workspace', 120)->nullable();
            $table->string('project', 160)->nullable();
            $table->unsignedInteger('dataset_version')->nullable();
            $table->string('model_type', 64)->nullable();
            $table->string('hosted_model_id', 200)->nullable();
            $table->string('training_speed', 32)->nullable();
            $table->json('manifest')->nullable();
            $table->json('preprocessing')->nullable();
            $table->json('augmentation')->nullable();
            $table->json('metrics')->nullable();
            $table->text('error_message')->nullable();
            $table->text('evaluation_notes')->nullable();
            $table->string('previous_model_path', 500)->nullable();
            $table->string('backup_model_path', 500)->nullable();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->timestamp('deployed_at')->nullable();
            $table->timestamps();

            $table->index('status');
            $table->index('created_at');
        });

        Schema::create('training_job_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('training_job_id')->constrained('training_jobs')->cascadeOnDelete();
            $table->foreignId('report_id')->constrained('missed_detection_reports')->cascadeOnDelete();
            $table->string('image_hash', 40);
            $table->string('split', 16)->default('train');
            $table->string('filename', 180);
            $table->string('roboflow_image_id', 80)->nullable();
            $table->string('upload_status', 24)->default('pending');
            $table->text('upload_error')->nullable();
            $table->timestamps();

            $table->unique(['training_job_id', 'report_id']);
            $table->index('image_hash');
        });

        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->foreignId('training_job_id')->nullable()->after('include_in_export')->constrained('training_jobs')->nullOnDelete();
        });

        if (! Schema::hasTable('jobs')) {
            Schema::create('jobs', function (Blueprint $table) {
                $table->id();
                $table->string('queue')->index();
                $table->longText('payload');
                $table->unsignedTinyInteger('attempts');
                $table->unsignedInteger('reserved_at')->nullable();
                $table->unsignedInteger('available_at');
                $table->unsignedInteger('created_at');
            });
        }

        if (! Schema::hasTable('failed_jobs')) {
            Schema::create('failed_jobs', function (Blueprint $table) {
                $table->id();
                $table->string('uuid')->unique();
                $table->text('connection');
                $table->string('queue');
                $table->longText('payload');
                $table->longText('exception');
                $table->timestamp('failed_at')->useCurrent();
            });
        }
    }

    public function down(): void
    {
        Schema::table('missed_detection_reports', function (Blueprint $table) {
            $table->dropConstrainedForeignId('training_job_id');
        });
        Schema::dropIfExists('training_job_items');
        Schema::dropIfExists('training_jobs');
        Schema::dropIfExists('jobs');
        Schema::dropIfExists('failed_jobs');
    }
};
