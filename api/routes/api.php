<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CameraController;
use App\Http\Controllers\Api\DetectionController;
use App\Http\Controllers\Api\ReportController;
use App\Http\Controllers\Api\SettingsController;
use App\Http\Controllers\Api\StatsController;
use Illuminate\Support\Facades\Route;

Route::post('/login', [AuthController::class, 'login']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/cameras', [CameraController::class, 'index']);
    Route::post('/cameras', [CameraController::class, 'store']);
    Route::put('/cameras/{camera}', [CameraController::class, 'update']);
    Route::delete('/cameras/{camera}', [CameraController::class, 'destroy']);
    Route::post('/cameras/{camera}/test', [CameraController::class, 'test']);

    Route::get('/detections', [DetectionController::class, 'index']);
    Route::post('/detections', [DetectionController::class, 'store']);
    Route::get('/detections/live', [DetectionController::class, 'live']);

    Route::get('/stats/today', [StatsController::class, 'today']);
    Route::get('/stats/composition', [StatsController::class, 'composition']);

    Route::get('/settings', [SettingsController::class, 'show']);
    Route::put('/settings', [SettingsController::class, 'update']);

    Route::post('/reports', [ReportController::class, 'store']);
});

Route::post('/detections/live', [DetectionController::class, 'ingestLive'])
    ->middleware('detector.key');
