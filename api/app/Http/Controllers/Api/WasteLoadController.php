<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\WasteLoad;
use Illuminate\Http\JsonResponse;

class WasteLoadController extends Controller
{
    /** Cleanup threshold per camera. Detector frames keep it fresh; a stale value runs a new check. */
    public function show(): JsonResponse
    {
        return response()->json(WasteLoad::latest())->header('Cache-Control', 'no-store');
    }
}
