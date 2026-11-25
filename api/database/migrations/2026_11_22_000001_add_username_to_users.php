<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Sign in with a username ("admin") instead of an email address. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('username', 60)->nullable()->unique()->after('name');
        });

        // The station has one administrator: give that account the username "admin".
        $adminId = DB::table('users')->where('role', 'Admin')->orderBy('id')->value('id');
        if ($adminId !== null) {
            DB::table('users')->where('id', $adminId)->update(['username' => 'admin']);
        }
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['username']);
            $table->dropColumn('username');
        });
    }
};
