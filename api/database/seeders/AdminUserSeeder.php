<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * The station's one administrator: username "admin", shown as "Admin".
 *
 * No password is written in this file. Set ADMIN_PASSWORD in api/.env before
 * seeding a new install; if it is missing, a strong random password is made
 * and printed once. An existing account keeps its password unless
 * ADMIN_PASSWORD is set.
 */
class AdminUserSeeder extends Seeder
{
    public function run(): void
    {
        $user = User::query()->where('username', 'admin')->first()
            ?? User::query()->where('role', 'Admin')->orderBy('id')->first()
            ?? new User;

        $user->fill([
            'name' => 'Admin',
            'username' => 'admin',
            'email' => $user->email ?: 'admin@brgy-gracia.local',
            'role' => 'Admin',
        ]);

        $password = (string) env('ADMIN_PASSWORD', '');
        if ($password !== '') {
            $user->password = Hash::make($password);
        } elseif (! $user->exists) {
            $password = Str::password(16);
            $user->password = Hash::make($password);
            $this->command?->warn("Admin password (save it now, it is not shown again): {$password}");
        }

        $user->save();
    }
}
