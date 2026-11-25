<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * IP cameras added from the dashboard: the gateway stream name, RTSP port and
 * path. The camera password is stored encrypted from now on.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('cameras', function (Blueprint $table) {
            $table->string('go2rtc_src', 64)->nullable()->unique()->after('stream_url');
            $table->unsignedInteger('rtsp_port')->nullable()->after('go2rtc_src');
            $table->string('rtsp_path', 255)->nullable()->after('rtsp_port');
        });
        Schema::table('cameras', function (Blueprint $table) {
            $table->text('password')->nullable()->change();
        });

        // Encrypt any password saved before this change.
        DB::table('cameras')->whereNotNull('password')->where('password', '!=', '')
            ->orderBy('id')->get(['id', 'password'])
            ->each(function ($row) {
                DB::table('cameras')->where('id', $row->id)
                    ->update(['password' => Crypt::encryptString((string) $row->password)]);
            });
    }

    public function down(): void
    {
        DB::table('cameras')->whereNotNull('password')->where('password', '!=', '')
            ->orderBy('id')->get(['id', 'password'])
            ->each(function ($row) {
                try {
                    $plain = Crypt::decryptString((string) $row->password);
                } catch (\Throwable) {
                    return;
                }
                DB::table('cameras')->where('id', $row->id)->update(['password' => $plain]);
            });
        Schema::table('cameras', function (Blueprint $table) {
            $table->dropUnique(['go2rtc_src']);
            $table->dropColumn(['go2rtc_src', 'rtsp_port', 'rtsp_path']);
        });
    }
};
