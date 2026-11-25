<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function login(Request $request): JsonResponse
    {
        $credentials = $request->validate([
            // Username (e.g. "admin") or email; the field keeps its old name.
            'email' => ['required_without:username', 'nullable', 'string', 'max:160'],
            'username' => ['required_without:email', 'nullable', 'string', 'max:160'],
            'password' => ['required', 'string'],
        ]);
        $login = trim((string) ($credentials['username'] ?? $credentials['email'] ?? ''));

        $user = User::query()
            ->whereRaw('LOWER(username) = ?', [mb_strtolower($login)])
            ->first()
            ?? User::query()->where('email', $login)->first();

        if (! $user || ! Hash::check($credentials['password'], $user->password)) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials are incorrect.'],
            ]);
        }

        $token = $user->createToken('tidalwatch')->plainTextToken;

        return response()->json([
            'token' => $token,
            'user' => $this->userPayload($user),
        ]);
    }

    public function me(Request $request): JsonResponse
    {
        return response()->json($this->userPayload($request->user()));
    }

    /**
     * Profile photo. The browser crops it to a square and shrinks it to 256 px
     * before upload, so the server only checks it and stores it.
     */
    public function updateAvatar(Request $request): JsonResponse
    {
        $request->validate([
            'photo' => ['required', 'file', 'mimes:jpg,jpeg,png,webp', 'max:2048', 'dimensions:max_width=1024,max_height=1024'],
        ]);
        $user = $request->user();
        $file = $request->file('photo');
        $extension = strtolower($file->extension() ?: 'jpg');
        $path = $file->storeAs('avatars', 'user-'.$user->id.'-'.now()->format('YmdHis').'.'.$extension, 'public');

        $old = $user->avatar_path;
        $user->avatar_path = $path;
        $user->save();
        if ($old && $old !== $path) {
            \Illuminate\Support\Facades\Storage::disk('public')->delete($old);
        }

        return response()->json($this->userPayload($user->fresh()));
    }

    public function removeAvatar(Request $request): JsonResponse
    {
        $user = $request->user();
        if ($user->avatar_path) {
            \Illuminate\Support\Facades\Storage::disk('public')->delete($user->avatar_path);
            $user->avatar_path = null;
            $user->save();
        }

        return response()->json($this->userPayload($user->fresh()));
    }

    private function userPayload(User $user): array
    {
        return [
            'id' => $user->id,
            'name' => $user->name,
            'username' => $user->username,
            'email' => $user->email,
            'role' => $user->role,
            // Version query so a new photo shows at once (no stale browser cache).
            'avatar_url' => $user->avatar_path
                ? '/storage/'.$user->avatar_path.'?v='.($user->updated_at?->timestamp ?? time())
                : null,
        ];
    }
}
