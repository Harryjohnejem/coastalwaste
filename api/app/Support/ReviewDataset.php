<?php

namespace App\Support;

use App\Models\MissedDetectionReport;
use Illuminate\Support\Facades\Storage;

class ReviewDataset
{
    /**
     * Approved reviews marked for export, validated for YOLO / Roboflow.
     *
     * @return array{items: list<array<string, mixed>>, issues: list<string>}
     */
    public static function collectExportable(): array
    {
        $reports = MissedDetectionReport::query()
            ->with('annotations')
            ->where('status', MissedDetectionReport::APPROVED)
            ->where('include_in_export', true)
            ->whereNull('training_job_id')
            ->orderBy('id')
            ->get();

        return self::build($reports);
    }

    /**
     * @param  list<int>  $reportIds
     * @return array{items: list<array<string, mixed>>, issues: list<string>}
     */
    public static function collectByIds(array $reportIds): array
    {
        if ($reportIds === []) {
            return ['items' => [], 'issues' => []];
        }
        $reports = MissedDetectionReport::query()
            ->with('annotations')
            ->whereIn('id', $reportIds)
            ->whereIn('status', [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED])
            ->where('include_in_export', true)
            ->orderBy('id')
            ->get();
        $result = self::build($reports);
        $found = $reports->pluck('id')->map(fn ($id) => (int) $id)->all();
        $missing = array_values(array_diff(array_map('intval', $reportIds), $found));
        foreach ($missing as $id) {
            $result['issues'][] = "Report {$id} is no longer approved for training.";
        }

        return $result;
    }

    /**
     * @param  \Illuminate\Support\Collection<int, MissedDetectionReport>  $reports
     * @return array{items: list<array<string, mixed>>, issues: list<string>}
     */
    private static function build($reports): array
    {

        $issues = [];
        $items = [];
        $seenImages = [];
        $allowed = WasteClassMap::classes();

        foreach ($reports as $index => $report) {
            if (! $report->image_path || ! Storage::disk('public')->exists($report->image_path)) {
                $issues[] = "Report {$report->id} is missing its image.";
                continue;
            }
            $bytes = Storage::disk('public')->get($report->image_path);
            if (! is_string($bytes) || $bytes === '') {
                $issues[] = "Report {$report->id} has an empty image file.";
                continue;
            }
            $hash = sha1($bytes);
            if (isset($seenImages[$hash])) {
                $issues[] = "Report {$report->id} duplicates the image in report {$seenImages[$hash]}.";
                continue;
            }
            $seenImages[$hash] = $report->id;

            $fileLines = [];
            $seenLines = [];
            foreach ($report->annotations as $box) {
                if (! in_array($box->class_name, $allowed, true)) {
                    $issues[] = "Report {$report->id} uses class '{$box->class_name}', which is not a dataset class.";
                    $fileLines = [];
                    break;
                }
                $line = $box->toYoloLine();
                if ($line === null) {
                    $issues[] = "Report {$report->id} has an invalid annotation.";
                    $fileLines = [];
                    break;
                }
                if (! isset($seenLines[$line])) {
                    $seenLines[$line] = true;
                    $fileLines[] = $line;
                }
            }
            if ($fileLines === []) {
                if (! collect($issues)->contains(fn ($msg) => str_contains($msg, "Report {$report->id}"))) {
                    $issues[] = "Report {$report->id} has no annotations.";
                }
                continue;
            }

            $ext = strtolower(pathinfo((string) $report->image_name, PATHINFO_EXTENSION) ?: 'jpg');
            if (! in_array($ext, ['jpg', 'jpeg', 'png', 'webp'], true)) {
                $issues[] = "Report {$report->id} image type .{$ext} is not supported.";
                continue;
            }
            $split = $reports->count() > 1 && $index % 5 === 0 ? 'valid' : 'train';
            $items[] = [
                'report' => $report,
                'report_id' => $report->id,
                'hash' => $hash,
                'bytes' => $bytes,
                'yolo' => implode("\n", $fileLines)."\n",
                'split' => $split,
                'filename' => 'missed-'.$report->id.'.'.$ext,
                'mime' => $ext === 'png' ? 'image/png' : ($ext === 'webp' ? 'image/webp' : 'image/jpeg'),
            ];
        }

        return ['items' => $items, 'issues' => $issues];
    }

    /**
     * @return array<string, string>
     */
    public static function labelmap(): array
    {
        $map = [];
        foreach (WasteClassMap::classes() as $index => $name) {
            $map[(string) $index] = $name;
        }

        return $map;
    }
}
