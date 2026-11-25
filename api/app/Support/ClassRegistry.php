<?php

namespace App\Support;

use App\Models\MissedDetectionAnnotation;
use App\Models\SystemSetting;
use App\Models\WasteCategory;
use Illuminate\Support\Facades\Cache;

/**
 * One list of waste classes for the whole system, so it is not stuck at the
 * classes the first model was trained on.
 *
 *   base     the original dataset classes (DatasetClasses::NAMES)
 *   model    the classes of the model on the cameras now (saved on Deploy/Rollback)
 *   catalog  classifications added in Settings > Waste catalog
 *
 * live()      what the cameras detect: the deployed model's classes, minus excluded
 * all()       every class the system knows (reports, filters, review labels)
 * trainable() all() minus excluded (classes that can be labelled for training)
 */
class ClassRegistry
{
    private const MODEL_KEY = 'live_model_classes';

    private const CACHE_KEY = 'class-registry:v1';

    /** Switched off for live detection (detector EXCLUDED_CLASSES). */
    public const EXCLUDED = ['Cardboard', 'Paper Bag', 'Paper Drink Carton', 'Plastic Bag'];

    /** Catalog names that are not offered anywhere (old seed data). */
    public const HIDDEN_CATEGORIES = ['paper', 'fishing gear', 'other', 'styrofoam', 'wood'];

    public const HIDDEN_CLASSIFICATIONS = [
        'cardboard', 'paper bag', 'paper drink carton', 'plastic bag', 'other plastic', 'aluminum',
        'scrap metal', 'tin can', 'glass fragment', 'fishing line', 'fishing net',
        'coastal debris', 'litter', 'unknown', 'driftwood', 'drift wood',
        'pallet / lumber', 'pallet/lumber', 'wood debris',
        // Old free-text labels from before the dataset classes.
        'paper carton', 'newspaper', 'tissue / packaging', 'cigarette', 'straw', 'bottle cap',
    ];

    /** @var array<string, mixed>|null */
    private static ?array $memo = null;

    /** @return list<string> classes of the deployed model (empty until a deploy saves them) */
    public static function modelClasses(): array
    {
        return self::state()['model'];
    }

    /** @param list<string> $names */
    public static function saveModelClasses(array $names): void
    {
        $clean = [];
        foreach ($names as $name) {
            $name = trim((string) $name);
            if ($name !== '' && ! self::containsName($clean, $name)) {
                $clean[] = DatasetClasses::matchBase($name) ?? $name;
            }
        }
        SystemSetting::query()->updateOrCreate(['key' => self::MODEL_KEY], ['value' => ['classes' => $clean]]);
        self::forget();
    }

    /** @return list<string> */
    public static function all(): array
    {
        return self::state()['all'];
    }

    /** @return list<string> */
    public static function live(): array
    {
        $model = self::modelClasses();
        $source = $model !== [] ? $model : DatasetClasses::NAMES;

        return array_values(array_filter($source, fn (string $name) => ! self::isExcluded($name)));
    }

    /** @return list<string> */
    public static function trainable(): array
    {
        return array_values(array_filter(self::all(), fn (string $name) => ! self::isExcluded($name)));
    }

    /** @return list<string> Plastic, Metal, Glass, then categories added in the catalog */
    public static function categories(): array
    {
        return self::state()['categories'];
    }

    /** @return array<string, string> class => category */
    public static function categoryMap(): array
    {
        return self::state()['category_of'];
    }

    public static function categoryOf(?string $name): ?string
    {
        $needle = strtolower(trim((string) $name));
        foreach (self::categoryMap() as $class => $category) {
            if (strtolower($class) === $needle) {
                return $category;
            }
        }

        return null;
    }

    /** Spelling the system uses for a label, or null when it is not a known class. */
    public static function match(?string $label): ?string
    {
        $needle = strtolower(trim((string) $label));
        if ($needle === '') {
            return null;
        }
        foreach (self::all() as $name) {
            if (strtolower($name) === $needle) {
                return $name;
            }
        }

        return null;
    }

    public static function isExcluded(string $name): bool
    {
        return self::containsName(self::EXCLUDED, $name);
    }

    /**
     * Classes that must reach the per-class minimum before training: what the
     * cameras detect now, plus any new class that already has approved samples
     * (a new class with no samples yet does not block training).
     *
     * @return list<string>
     */
    public static function requiredForTraining(): array
    {
        $required = self::live();
        $labelled = MissedDetectionAnnotation::query()
            ->whereHas('report', fn ($q) => $q->whereIn('status', ['approved', 'exported'])->where('include_in_export', true))
            ->distinct()
            ->pluck('class_name');
        foreach ($labelled as $raw) {
            $name = self::match((string) $raw);
            if ($name !== null && ! self::isExcluded($name) && ! self::containsName($required, $name)) {
                $required[] = $name;
            }
        }

        return $required;
    }

    /** Everything the web app needs, in one payload. */
    public static function payload(): array
    {
        return [
            'all' => self::all(),
            'live' => self::live(),
            'trainable' => self::trainable(),
            'excluded' => self::EXCLUDED,
            'categories' => self::categories(),
            'category_of' => self::categoryMap(),
            'model' => self::modelClasses(),
        ];
    }

    public static function forget(): void
    {
        self::$memo = null;
        Cache::forget(self::CACHE_KEY);
    }

    /** @return array{model: list<string>, all: list<string>, categories: list<string>, category_of: array<string, string>} */
    private static function state(): array
    {
        if (self::$memo !== null) {
            return self::$memo;
        }

        return self::$memo = Cache::remember(self::CACHE_KEY, 30, function () {
            $saved = SystemSetting::query()->find(self::MODEL_KEY)?->value;
            $model = array_values(array_filter(
                array_map('strval', (array) (is_array($saved) ? ($saved['classes'] ?? []) : [])),
                fn ($name) => trim($name) !== '',
            ));

            $all = DatasetClasses::NAMES;
            $categoryOf = DatasetClasses::CATEGORY_OF;
            $categories = DatasetClasses::CATEGORIES;

            foreach ($model as $name) {
                if (! self::containsName($all, $name)) {
                    $all[] = $name;
                }
            }

            // Waste catalog: visible categories and their classifications.
            $catalog = WasteCategory::query()->with(['classifications' => fn ($q) => $q->orderBy('id')])->orderBy('id')->get();
            foreach ($catalog as $category) {
                $categoryName = trim((string) $category->category_name);
                if ($categoryName === '' || in_array(strtolower($categoryName), self::HIDDEN_CATEGORIES, true)) {
                    continue;
                }
                $added = false;
                foreach ($category->classifications as $row) {
                    $name = trim((string) $row->waste_type);
                    if ($name === '' || in_array(strtolower($name), self::HIDDEN_CLASSIFICATIONS, true)) {
                        continue;
                    }
                    if (! self::containsName($all, $name)) {
                        $all[] = $name;
                    }
                    $known = self::findName(array_keys($categoryOf), $name);
                    if ($known === null) {
                        $categoryOf[$name] = $categoryName;
                    }
                    $added = true;
                }
                if (! self::containsName($categories, $categoryName) && ($added || $category->classifications->isEmpty())) {
                    $categories[] = $categoryName;
                }
            }

            // A class from the model that is not in the catalog yet counts as Plastic.
            foreach ($all as $name) {
                if (self::findName(array_keys($categoryOf), $name) === null) {
                    $categoryOf[$name] = 'Plastic';
                }
            }
            // Paper exists only for the excluded classes; keep it off the lists.
            $categories = array_values(array_filter($categories, fn ($c) => strcasecmp($c, 'Paper') !== 0));

            return ['model' => $model, 'all' => array_values($all), 'categories' => $categories, 'category_of' => $categoryOf];
        });
    }

    /** @param list<string> $list */
    private static function containsName(array $list, string $name): bool
    {
        return self::findName($list, $name) !== null;
    }

    /** @param list<string> $list */
    private static function findName(array $list, string $name): ?string
    {
        $needle = strtolower(trim($name));
        foreach ($list as $item) {
            if (strtolower(trim((string) $item)) === $needle) {
                return $item;
            }
        }

        return null;
    }
}
