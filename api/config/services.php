<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    'detector' => [
        'key' => env('DETECTOR_KEY', 'tidalwatch-detector-local'),
        'match_threshold' => (float) env('CROSS_CAMERA_MATCH_THRESHOLD', 0.82),
        'match_window_seconds' => (int) env('CROSS_CAMERA_WINDOW_SECONDS', 120),
    ],

    'roboflow' => [
        'key' => env('ROBOFLOW_API_KEY'),
        'workspace' => env('ROBOFLOW_WORKSPACE'),
        'project' => env('ROBOFLOW_PROJECT'),
        'model_type' => env('ROBOFLOW_MODEL_TYPE', 'yolov11'),
        'speed' => env('ROBOFLOW_SPEED', 'fast'),
        'base_url' => env('ROBOFLOW_API_URL', 'https://api.roboflow.com'),
    ],

];
