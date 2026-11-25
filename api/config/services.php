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

    'go2rtc' => [
        // Gateway the API and the detector call to add or remove IP cameras.
        'base' => env('GO2RTC_BASE', 'http://127.0.0.1:1990'),
        // Address saved in each camera's stream URL for the browser.
        'public_base' => env('GO2RTC_PUBLIC_BASE', env('GO2RTC_BASE', 'http://127.0.0.1:1990')),
    ],

    'detector' => [
        'key' => env('DETECTOR_KEY', 'tidalwatch-detector-local'),
        'url' => env('DETECTOR_URL', 'http://127.0.0.1:8092'),
        // Cleanup threshold counts the boxes on the live cameras (off in tests).
        'live_counts' => (bool) env('DETECTOR_LIVE_COUNTS', true),
        'python' => env('DETECTOR_PYTHON', 'python'),
        'onnx_path' => env('DETECTOR_ONNX_PATH', ''),
        'match_threshold' => (float) env('CROSS_CAMERA_MATCH_THRESHOLD', 0.82),
        'match_window_seconds' => (int) env('CROSS_CAMERA_WINDOW_SECONDS', 120),
        // Longer than one detector frame per camera (~9-13 s), so one missed frame
        // does not mark waste cleaned and then bring it back.
        'absence_grace_seconds' => (int) env('DETECTOR_ABSENCE_GRACE_SECONDS', 20),
    ],

    'roboflow' => [
        'key' => env('ROBOFLOW_API_KEY'),
        'workspace' => env('ROBOFLOW_WORKSPACE'),
        'project' => env('ROBOFLOW_PROJECT'),
        'model_type' => env('ROBOFLOW_MODEL_TYPE', 'yolov11l'),
        'speed' => env('ROBOFLOW_SPEED', 'fast'),
        'epochs' => (int) env('ROBOFLOW_EPOCHS', 350),
        'base_url' => env('ROBOFLOW_API_URL', 'https://api.roboflow.com'),
        'verify_ssl' => filter_var(env('ROBOFLOW_VERIFY_SSL', true), FILTER_VALIDATE_BOOLEAN),
    ],

];
