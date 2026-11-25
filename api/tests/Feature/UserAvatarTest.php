<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class UserAvatarTest extends TestCase
{
    use RefreshDatabase;

    private function photo(string $name = 'me.jpg'): UploadedFile
    {
        return new UploadedFile(base_path('tests/fixtures/pixel.jpg'), $name, 'image/jpeg', null, true);
    }

    public function test_upload_replace_and_remove_photo(): void
    {
        Storage::fake('public');
        $user = User::factory()->create(['role' => 'Admin']);

        $first = $this->actingAs($user)->post('/api/user/avatar', ['photo' => $this->photo()], ['Accept' => 'application/json'])
            ->assertOk()->json('avatar_url');
        $this->assertStringStartsWith('/storage/avatars/user-'.$user->id.'-', $first);
        $firstPath = $user->fresh()->avatar_path;
        Storage::disk('public')->assertExists($firstPath);

        $this->travel(2)->seconds();
        $this->actingAs($user)->post('/api/user/avatar', ['photo' => $this->photo('new.jpg')], ['Accept' => 'application/json'])
            ->assertOk();
        Storage::disk('public')->assertMissing($firstPath);

        $this->actingAs($user)->getJson('/api/user')->assertOk()->assertJsonPath('avatar_url', fn ($url) => is_string($url));

        $this->actingAs($user)->deleteJson('/api/user/avatar')->assertOk()->assertJsonPath('avatar_url', null);
        $this->assertNull($user->fresh()->avatar_path);
    }

    public function test_only_images_are_accepted(): void
    {
        Storage::fake('public');
        $user = User::factory()->create();
        $file = UploadedFile::fake()->create('notes.pdf', 10, 'application/pdf');

        $this->actingAs($user)->post('/api/user/avatar', ['photo' => $file], ['Accept' => 'application/json'])
            ->assertStatus(422);
        $this->assertNull($user->fresh()->avatar_path);
    }

    public function test_photo_needs_sign_in(): void
    {
        $this->postJson('/api/user/avatar')->assertUnauthorized();
    }
}
