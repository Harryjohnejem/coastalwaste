<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Mail\CoastalReportMail;
use App\Models\Detection;
use App\Models\Report;
use App\Models\User;
use App\Support\DashboardCache;
use App\Support\DatasetClasses;
use App\Support\OfficialReportPdf;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

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

        DashboardCache::flush();

        return response()->json([
            'id' => $report->id,
            'report_number' => $report->report_number,
            'report_type' => $report->report_type,
            'generated_at' => $report->generated_at?->toIso8601String(),
            'created_at' => $report->created_at?->toIso8601String(),
        ], 201);
    }

    /**
     * Every saved record for Reports & Analytics and the report form, in a
     * compact shape (only the fields the reports use), so totals are not cut
     * at the 1000-row limit of the detections list.
     */
    public function records(): JsonResponse
    {
        $rows = [];
        Detection::query()
            ->notMovedToReview()
            ->where('status', '!=', 'Ignored')
            ->with(['camera:id,camera_code', 'classification.category', 'latestLog'])
            ->lazyById(1000)
            ->each(function (Detection $d) use (&$rows) {
                $class = DatasetClasses::match($d->latestLog?->raw_label);
                $category = DatasetClasses::categoryOf($class);
                $confidence = (float) $d->confidence;
                $rows[] = [
                    'id' => $d->id,
                    'camera_id' => $d->camera?->camera_code,
                    'class' => $class ?? $d->classification?->waste_type,
                    'dataset_class' => $class,
                    'waste_category' => $category ?? $d->classification?->category?->category_name,
                    'parent_category' => $category,
                    'confidence' => $confidence > 1 ? round($confidence / 100, 4) : $confidence,
                    'count' => $d->quantity,
                    'location' => $d->location,
                    'sector' => $d->location,
                    'detected_at' => $d->detected_at?->format('Y-m-d H:i:s'),
                    'detected_at_iso' => $d->detected_at?->toIso8601String(),
                    'removed_at' => $d->removed_at?->format('Y-m-d H:i:s'),
                    'status' => $d->status,
                    'status_label' => $d->statusLabel(),
                    'cleaning_verified_at' => $d->cleaning_verified_at?->format('Y-m-d H:i:s'),
                ];
            });
        usort($rows, fn ($a, $b) => strcmp((string) $b['detected_at'], (string) $a['detected_at']));

        return response()->json($rows)->header('Cache-Control', 'no-store');
    }

    public function email(Request $request): JsonResponse
    {
        $user = $request->user();
        if (! $user) {
            return response()->json(['message' => 'Unauthenticated.'], 401);
        }
        if (! $this->isAdmin($user)) {
            abort(403);
        }

        $data = $request->validate([
            'recipients' => ['required', 'array', 'min:1', 'max:10'],
            'recipients.*' => ['required', 'email', 'max:160', 'distinct'],
            'html' => ['required', 'string', 'max:1500000'],
            'report_number' => ['required', 'string', 'max:64'],
            'monitoring_period' => ['nullable', 'string', 'max:200'],
            'message' => ['nullable', 'string', 'max:2000'],
        ]);

        $html = $this->officialHtml($data['html']);
        $recipients = array_values($data['recipients']);
        $reportNumber = trim($data['report_number']);
        $period = trim((string) ($data['monitoring_period'] ?? ''));
        $body = trim((string) ($data['message'] ?? ''));
        if ($body === '') {
            $body = CoastalReportMail::MESSAGE;
        }
        $lock = 'report-email:'.$user->id.':'.sha1($html.'|'.implode(',', $recipients).'|'.$body);
        if (! Cache::add($lock, true, now()->addSeconds(20))) {
            return response()->json([
                'message' => 'This report was just sent. Wait a moment before sending it again.',
            ], 429);
        }

        try {
            $pdf = OfficialReportPdf::render($html);
            if (! str_starts_with($pdf, '%PDF')) {
                throw new \RuntimeException('The report PDF could not be created.');
            }
            $filename = preg_replace('/[^A-Za-z0-9._-]/', '', $reportNumber).'.pdf';
            if ($filename === '.pdf') {
                $filename = 'coastal-waste-report.pdf';
            }

            Mail::to($recipients)->send(new CoastalReportMail(
                $pdf,
                $filename,
                $reportNumber,
                $period,
                $body,
            ));
        } catch (\Throwable $e) {
            Cache::forget($lock);
            if ($this->isGmailAuthFailure($e)) {
                return response()->json([
                    'message' => 'Gmail rejected the mailbox login. Create a new App Password for coastalwasterm@gmail.com (Google Account → Security → 2-Step Verification → App passwords), set it as MAIL_PASSWORD in api/.env, then restart the API. Do not use the normal Gmail password.',
                ], 422);
            }
            throw $e;
        }

        return response()->json([
            'sent' => true,
            'recipients' => $recipients,
            'report_number' => $reportNumber,
        ]);
    }

    private function isAdmin(?User $user): bool
    {
        return $user !== null && strcasecmp((string) $user->role, 'Admin') === 0;
    }

    private function isGmailAuthFailure(\Throwable $e): bool
    {
        $text = $e->getMessage();
        return str_contains($text, '535')
            || str_contains($text, 'Username and Password not accepted')
            || str_contains($text, 'Failed to authenticate on SMTP server');
    }

    private function officialHtml(string $html): string
    {
        $html = trim($html);
        if (! str_contains($html, 'Computer Vision-Based Coastal Waste Monitoring and Reporting System')) {
            throw ValidationException::withMessages([
                'html' => 'The report does not match the official monitoring form.',
            ]);
        }
        if (preg_match('/<\s*(script|iframe|object|embed)\b|javascript\s*:|onerror\s*=/i', $html)) {
            throw ValidationException::withMessages([
                'html' => 'The report HTML is not allowed.',
            ]);
        }

        return $html;
    }
}
