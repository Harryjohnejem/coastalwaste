<?php

namespace App\Support;

use App\Models\MissedDetectionReport;
use App\Models\SystemSetting;
use App\Models\TrainingJobItem;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/** Deterministic, balanced snapshots from approved, verified reviews. */
class TrainingSamplePlan
{
    public const REQUIRED = 50;

    public const OPTIONS = [10, 20, 50, 100, 200, 500, 1000];

    public const DEFAULT = self::REQUIRED;

    public const SETTING_KEY = 'training_sample_limit';

    /** Classes the live model leaves out. They stay in the dataset but do not block training. */
    public const OPTIONAL_CLASSES = ['Cardboard', 'Paper Bag', 'Paper Drink Carton', 'Plastic Bag'];

    /**
     * Classes that must reach the per-class threshold before training.
     *
     * @return list<string>
     */
    public static function requiredClasses(): array
    {
        return ClassRegistry::requiredForTraining();
    }

    public static function current(): int
    {
        $value = SystemSetting::query()->find(self::SETTING_KEY)?->value;
        $limit = is_array($value) ? (int) ($value['per_class'] ?? self::DEFAULT) : self::DEFAULT;

        return in_array($limit, self::OPTIONS, true) ? $limit : self::DEFAULT;
    }

    public static function save(int $limit): int
    {
        if (! in_array($limit, self::OPTIONS, true)) {
            throw new \InvalidArgumentException('Choose a supported sample threshold.');
        }
        SystemSetting::query()->updateOrCreate(
            ['key' => self::SETTING_KEY],
            ['value' => ['per_class' => $limit]],
        );

        return $limit;
    }

    /** @return list<int> */
    public static function selectedIds(): array
    {
        return self::summary()['selected_ids'];
    }

    /**
     * @return array{
     *   limit:int, required:int, ready:bool, total_approved_samples:int,
     *   eligible_reviews:int, selected_reviews:int, classes_ready:int,
     *   classes_below_minimum:int, classes_with_samples:int, classes_at_limit:int,
     *   classes:list<array{name:string,eligible:int,selected:int,remaining:int,status:string}>,
     *   selected_ids:list<int>
     * }
     */
    public static function summary(): array
    {
        $required = self::current();
        // Original classes plus classes from the deployed model and the waste catalog.
        $names = array_values(array_unique(array_merge(WasteClassMap::CLASSES, ClassRegistry::trainable())));
        $requiredSet = array_map('strtolower', self::requiredClasses());
        $eligible = array_fill_keys($names, 0);
        $rows = [];
        $seenHashes = [];
        foreach (self::eligibleReports() as $report) {
            if (! $report->image_path || ! Storage::disk('public')->exists($report->image_path)) {
                continue;
            }
            $extension = strtolower(pathinfo((string) $report->image_name, PATHINFO_EXTENSION));
            if (! in_array($extension, ['jpg', 'jpeg', 'png', 'webp'], true)) {
                continue;
            }
            $bytes = Storage::disk('public')->get($report->image_path);
            if (! is_string($bytes) || $bytes === '') {
                continue;
            }
            $hash = sha1($bytes);
            if (isset($seenHashes[$hash]) || $report->annotations->isEmpty()) {
                continue;
            }
            $classes = [];
            $valid = true;
            foreach ($report->annotations as $box) {
                if (! in_array($box->class_name, $names, true) || $box->toYoloLine() === null) {
                    $valid = false;
                    break;
                }
                $classes[$box->class_name] = $box->class_name;
            }
            if (! $valid || $classes === []) {
                continue;
            }
            $seenHashes[$hash] = true;
            $classes = array_values($classes);
            $rows[] = ['id' => (int) $report->id, 'classes' => $classes];
            foreach ($classes as $name) {
                $eligible[$name]++;
            }
        }

        $selectedLookup = [];
        $selectedCounts = array_fill_keys($names, 0);
        if (self::hasPreviousVersion()) {
            // Each new version is a cumulative snapshot of all currently valid, approved samples.
            foreach ($rows as $row) {
                $selectedLookup[$row['id']] = true;
                foreach ($row['classes'] as $name) {
                    $selectedCounts[$name]++;
                }
            }
        } else {
            // First version takes the deterministic minimum needed to cover each class.
            $order = $names;
            usort($order, fn (string $a, string $b) => ($eligible[$a] <=> $eligible[$b]) ?: strcmp($a, $b));
            foreach ($order as $name) {
                if ($selectedCounts[$name] >= $required) {
                    continue;
                }
                foreach ($rows as $row) {
                    if (! in_array($name, $row['classes'], true) || isset($selectedLookup[$row['id']])) {
                        continue;
                    }
                    $selectedLookup[$row['id']] = true;
                    foreach ($row['classes'] as $className) {
                        $selectedCounts[$className]++;
                    }
                    if ($selectedCounts[$name] >= $required) {
                        break;
                    }
                }
            }
        }

        $selectedIds = array_map('intval', array_keys($selectedLookup));
        sort($selectedIds);
        $classes = [];
        $classesReady = 0;
        $classesWithSamples = 0;
        $requiredNames = self::requiredClasses();
        foreach ($names as $name) {
            $count = $eligible[$name];
            $ready = $count >= $required;
            // Excluded classes, and new classes nobody has labelled yet, do not block training.
            $optional = in_array($name, self::OPTIONAL_CLASSES, true) || ! in_array(strtolower($name), $requiredSet, true);
            if (! $optional) {
                $classesReady += $ready ? 1 : 0;
                $classesWithSamples += $count > 0 ? 1 : 0;
            }
            $classes[] = [
                'name' => $name,
                'eligible' => $count,
                'selected' => $selectedCounts[$name],
                'remaining' => max(0, $required - $count),
                'status' => $ready ? 'ready' : 'waiting',
                'optional' => $optional,
            ];
        }

        return [
            'limit' => $required,
            'required' => $required,
            'ready' => $classesReady === count($requiredNames),
            'total_approved_samples' => count($rows),
            'eligible_reviews' => count($rows),
            'selected_reviews' => count($selectedIds),
            'classes_ready' => $classesReady,
            'classes_below_minimum' => count($requiredNames) - $classesReady,
            'classes_with_samples' => $classesWithSamples,
            'classes_at_limit' => $classesReady,
            'classes' => $classes,
            'selected_ids' => $selectedIds,
        ];
    }

    /**
     * Reviews already used by a training run that finished (it has a mAP
     * result, reached evaluation, or was deployed). They stay in the Roboflow
     * project, so the next version still contains them; they no longer count
     * toward "Approved by class" or "Ready for training".
     *
     * @return list<int>
     */
    public static function trainedReportIds(): array
    {
        $finished = [
            \App\Models\TrainingJob::AWAITING_EVALUATION,
            \App\Models\TrainingJob::APPROVED_FOR_DEPLOYMENT,
            \App\Models\TrainingJob::DEPLOYED,
        ];
        $jobIds = \App\Models\TrainingJob::query()
            ->get(['id', 'status', 'metrics', 'deployed_at'])
            ->filter(fn ($job) => $job->deployed_at !== null
                || in_array($job->status, $finished, true)
                || filled(is_array($job->metrics) ? ($job->metrics['map'] ?? null) : null))
            ->pluck('id')
            ->all();
        if ($jobIds === []) {
            return [];
        }

        return TrainingJobItem::query()
            ->whereIn('training_job_id', $jobIds)
            ->pluck('report_id')
            ->map(fn ($id) => (int) $id)
            ->unique()
            ->values()
            ->all();
    }

    /** @return \Illuminate\Support\Collection<int, MissedDetectionReport> */
    private static function eligibleReports()
    {
        $trained = self::trainedReportIds();
        $query = MissedDetectionReport::query()
            ->with('annotations')
            ->whereIn('status', [MissedDetectionReport::APPROVED, MissedDetectionReport::EXPORTED])
            ->where('include_in_export', true)
            ->when($trained !== [], fn ($q) => $q->whereNotIn('id', $trained))
            ->orderBy('id');
        if (DB::getDriverName() !== 'sqlite' && DB::transactionLevel() > 0) {
            $query->lockForUpdate();
        }

        return $query->get();
    }

    private static function hasPreviousVersion(): bool
    {
        return TrainingJobItem::query()
            ->whereHas('job', fn ($query) => $query->whereNotNull('dataset_version'))
            ->exists();
    }
}
