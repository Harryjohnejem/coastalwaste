<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class DetectorKey
{
    public function handle(Request $request, Closure $next): Response
    {
        $expected = (string) config('services.detector.key', '');
        $provided = (string) $request->header('X-Detector-Key', '');

        if ($expected === '' || ! hash_equals($expected, $provided)) {
            return response()->json(['message' => 'Invalid detector key.'], 401);
        }

        return $next($request);
    }
}
