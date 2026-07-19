<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Report;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ReportController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'sector' => ['nullable', 'string', 'max:64'],
            'notes' => ['nullable', 'string'],
            'payload' => ['nullable', 'array'],
        ]);

        $report = Report::query()->create([
            'user_id' => $request->user()?->id,
            'sector' => $data['sector'] ?? null,
            'notes' => $data['notes'] ?? null,
            'payload' => $data['payload'] ?? null,
            'status' => 'filed',
        ]);

        return response()->json([
            'id' => $report->id,
            'status' => $report->status,
            'sector' => $report->sector,
            'created_at' => $report->created_at?->toIso8601String(),
        ], 201);
    }
}
