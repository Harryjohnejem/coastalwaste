<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CameraController;
use App\Http\Controllers\Api\DetectionController;
use App\Http\Controllers\Api\ReportController;
use App\Http\Controllers\Api\SettingsController;
use App\Http\Controllers\Api\StatsController;
use App\Http\Controllers\Api\WasteQuotaController;
use App\Http\Controllers\Api\NotificationController;
use App\Http\Controllers\Api\WasteCatalogController;
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
    Route::get('/stats/trends', [StatsController::class, 'trends']);

    Route::get('/settings', [SettingsController::class, 'show']);
    Route::put('/settings', [SettingsController::class, 'update']);

    Route::post('/reports', [ReportController::class, 'store']);

    Route::get('/quotas', [WasteQuotaController::class, 'index']);
    Route::post('/quotas', [WasteQuotaController::class, 'store']);
    Route::put('/quotas/{quota}', [WasteQuotaController::class, 'update']);

    Route::get('/notifications', [NotificationController::class, 'index']);
    Route::post('/notifications/read-all', [NotificationController::class, 'markAllRead']);
    Route::post('/notifications/{notification}/read', [NotificationController::class, 'markRead']);

    Route::get('/waste-catalog', [WasteCatalogController::class, 'index']);
    Route::post('/waste-catalog/categories', [WasteCatalogController::class, 'storeCategory']);
    Route::post('/waste-catalog/classifications', [WasteCatalogController::class, 'storeClassification']);
});

Route::post('/detections/live', [DetectionController::class, 'ingestLive'])
    ->middleware('detector.key');
