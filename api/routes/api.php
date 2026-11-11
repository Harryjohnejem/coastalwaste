<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\CameraController;
use App\Http\Controllers\Api\DetectionController;
use App\Http\Controllers\Api\ReportController;
use App\Http\Controllers\Api\SettingsController;
use App\Http\Controllers\Api\StatsController;
use App\Http\Controllers\Api\NotificationController;
use App\Http\Controllers\Api\MissedDetectionController;
use App\Http\Controllers\Api\TrainingJobController;
use App\Http\Controllers\Api\WasteCatalogController;
use Illuminate\Support\Facades\Route;

Route::post('/login', [AuthController::class, 'login']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', [AuthController::class, 'me']);
    Route::get('/cameras', [CameraController::class, 'index']);
    Route::post('/cameras', [CameraController::class, 'store']);
    Route::put('/cameras/{camera}', [CameraController::class, 'update']);
    Route::delete('/cameras/{camera}', [CameraController::class, 'destroy']);
    Route::post('/cameras/{camera}/test', [CameraController::class, 'test']);

    Route::get('/detections', [DetectionController::class, 'index']);
    Route::post('/detections', [DetectionController::class, 'store']);
    Route::get('/detections/live', [DetectionController::class, 'live']);
    Route::post('/detections/{detection}/review', [DetectionController::class, 'moveToReview']);
    Route::delete('/detections/{detection}', [DetectionController::class, 'destroy']);

    Route::get('/stats/today', [StatsController::class, 'today']);
    Route::get('/stats/composition', [StatsController::class, 'composition']);
    Route::get('/stats/trends', [StatsController::class, 'trends']);

    Route::get('/settings', [SettingsController::class, 'show']);
    Route::put('/settings', [SettingsController::class, 'update']);

    Route::post('/reports', [ReportController::class, 'store']);
    Route::post('/reports/email', [ReportController::class, 'email']);

    Route::get('/notifications', [NotificationController::class, 'index']);
    Route::post('/notifications/read-all', [NotificationController::class, 'markAllRead']);
    Route::post('/notifications/{notification}/read', [NotificationController::class, 'markRead']);

    Route::get('/missed-detections/classes', [MissedDetectionController::class, 'classes']);
    Route::get('/missed-detections', [MissedDetectionController::class, 'index']);
    Route::post('/missed-detections', [MissedDetectionController::class, 'store']);
    Route::put('/missed-detections/{missedDetection}/annotations', [MissedDetectionController::class, 'updateAnnotations']);
    Route::post('/missed-detections/{missedDetection}/review', [MissedDetectionController::class, 'review']);
    Route::delete('/missed-detections/{missedDetection}', [MissedDetectionController::class, 'destroy']);
    Route::get('/missed-detections/export', [MissedDetectionController::class, 'export']);

    Route::get('/training-jobs', [TrainingJobController::class, 'index']);
    Route::post('/training-jobs', [TrainingJobController::class, 'store']);
    Route::post('/training-jobs/{trainingJob}/retry', [TrainingJobController::class, 'retry']);
    Route::post('/training-jobs/{trainingJob}/evaluate', [TrainingJobController::class, 'evaluate']);
    Route::post('/training-jobs/{trainingJob}/approve-deployment', [TrainingJobController::class, 'approveDeployment']);
    Route::post('/training-jobs/{trainingJob}/reject', [TrainingJobController::class, 'reject']);
    Route::post('/training-jobs/{trainingJob}/deploy', [TrainingJobController::class, 'deploy']);
    Route::post('/training-jobs/{trainingJob}/rollback', [TrainingJobController::class, 'rollback']);

    Route::get('/waste-catalog', [WasteCatalogController::class, 'index']);
    Route::post('/waste-catalog/categories', [WasteCatalogController::class, 'storeCategory']);
    Route::post('/waste-catalog/classifications', [WasteCatalogController::class, 'storeClassification']);
});

Route::post('/detections/live', [DetectionController::class, 'ingestLive'])
    ->middleware('detector.key');

Route::post('/missed-detections/unfamiliar', [MissedDetectionController::class, 'proposeUnfamiliar'])
    ->middleware('detector.key');

Route::get('/settings/detection', [SettingsController::class, 'detectionRuntime'])
    ->middleware('detector.key');
