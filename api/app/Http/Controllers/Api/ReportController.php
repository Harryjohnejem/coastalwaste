<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Detection;
use App\Models\Report;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class ReportController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'report_type' => ['nullable', 'in:Summary,Detailed'],
            'monitoring_period' => ['nullable', 'string', 'max:120'],
            'remarks' => ['nullable', 'string'],
            'recommendations' => ['nullable', 'string'],
            'notes' => ['nullable', 'string'],
            'sector' => ['nullable', 'string', 'max:120'],
        ]);

        $user = $request->user();
        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }

        $avg = Detection::query()->avg('confidence');

        $report = Report::query()->create([
            'report_number' => 'RPT-'.now()->format('Ymd').'-'.Str::upper(Str::random(6)),
            'report_type' => $data['report_type'] ?? 'Summary',
            'generated_by' => $user->id,
            'monitoring_period' => $data['monitoring_period']
                ?? ($data['sector'] ?? 'Paco Beach · '.now()->format('M Y')),
            'average_confidence' => $avg !== null ? round((float) $avg, 2) : null,
            'generated_at' => now(),
            'remarks' => $data['remarks'] ?? $data['notes'] ?? null,
            'recommendations' => $data['recommendations'] ?? null,
        ]);

        return response()->json([
            'id' => $report->id,
            'report_number' => $report->report_number,
            'report_type' => $report->report_type,
            'generated_at' => $report->generated_at?->toIso8601String(),
            'created_at' => $report->created_at?->toIso8601String(),
        ], 201);
    }
}
