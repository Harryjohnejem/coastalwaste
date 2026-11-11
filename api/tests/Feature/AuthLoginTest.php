<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthLoginTest extends TestCase
{
    use RefreshDatabase;

    public function test_login_returns_token_for_valid_credentials(): void
    {
        $user = User::factory()->create([
            'email' => 'operator@example.test',
            'password' => 'secret-pass',
        ]);

        $response = $this->postJson('/api/login', [
            'email' => $user->email,
            'password' => 'secret-pass',
        ]);

        $response->assertOk()
            ->assertJsonPath('user.email', $user->email)
            ->assertJsonStructure(['token', 'user' => ['id', 'name', 'email']]);
    }

    public function test_login_rejects_wrong_password(): void
    {
        User::factory()->create([
            'email' => 'operator@example.test',
            'password' => 'secret-pass',
        ]);

        $this->postJson('/api/login', [
            'email' => 'operator@example.test',
            'password' => 'wrong',
        ])->assertStatus(422);
    }

    public function test_cameras_require_sanctum_token(): void
    {
        $this->getJson('/api/cameras')->assertUnauthorized();
    }
}
