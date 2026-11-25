<?php

namespace App\Support;

use App\Models\WasteCategory;
use App\Models\WasteClassification;

/** Map free-text YOLO / Roboflow labels → waste_classifications rows. */
class WasteClassifier
{
    public static function resolve(string $rawLabel): WasteClassification
    {
        $label = strtolower(trim($rawLabel));

        $official = DatasetClasses::match($rawLabel);
        if ($official === null) {
            $aliases = [
                'eco bag' => 'Ecobag',
                'facemask' => 'Face Mask',
                'styrofoam cup' => 'Styro Cup',
                'paper carton' => 'Paper Drink Carton',
                'juice carton' => 'Paper Drink Carton',
                'cellophane' => 'Plastic Cellophane',
                'tin can' => 'Can',
                'metal can' => 'Can',
            ];
            if (isset($aliases[$label])) {
                $official = $aliases[$label];
            }
        }
        if ($official !== null) {
            return self::officialClassification($official);
        }

        $exact = [
            'plastic bag' => 'Plastic Bag',
        ];
        if (isset($exact[$label])) {
            $found = WasteClassification::query()
                ->where('waste_type', $exact[$label])
                ->first();
            if ($found) {
                return $found;
            }
        }

        $rules = [
            ['Glass Bottle', ['glass bottle']],
            ['Glass Fragment', ['broken glass', 'glass jar', 'glass']],
            ['Tin Can', ['tin can', 'metal can', 'cans', 'can']],
            ['Aluminum', ['pop tab', 'aluminum foil', 'aluminium foil', 'aluminum', 'aluminium']],
            ['Scrap Metal', ['scrap metal', 'metal']],
            ['Paper Carton', ['paper drink carton', 'paper cup', 'paper carton', 'carton']],
            ['Cardboard', ['cardboard']],
            ['Newspaper', ['newspaper']],
            ['Tissue / packaging', ['paper bag', 'tissue', 'packaging paper']],
            ['Cigarette', ['cigarette']],
            ['Straw', ['straw']],
            ['Bottle Cap', ['bottle cap', 'lid']],
            ['Plastic Bottle', ['plastic bottle']],
            ['Ecobag', ['ecobag', 'eco bag']],
            ['Plastic Bag', ['plastic bag', 'trash bag']],
            ['Plastic Cup', ['plastic cup']],
            ['Fishing Net', ['fishing net', 'net', 'fishing']],
            ['Styrofoam', ['styrofoam', 'foam']],
            ['Wood Debris', ['wood debris', 'wood']],
            ['Driftwood', ['driftwood']],
            ['Pallet / lumber', ['pallet', 'lumber']],
            ['Other Plastic', ['face mask', 'plastic cellophane', 'plastic wrapper', 'plastic utensils', 'wrapper', 'bottle', 'bag', 'cup', 'plastic']],
            ['Coastal Debris', ['debris']],
            ['Litter', ['unlabeled litter', 'other litter', 'litter', 'trash', 'waste']],
        ];

        foreach ($rules as [$wasteType, $needles]) {
            foreach ($needles as $needle) {
                if ($needle === 'bag' && in_array($label, ['ecobag', 'eco bag', 'eco-bag'], true)) {
                    continue;
                }
                if (str_contains($label, $needle)) {
                    $found = WasteClassification::query()
                        ->where('waste_type', $wasteType)
                        ->first();
                    if ($found) {
                        return $found;
                    }
                }
            }
        }

        return WasteClassification::query()
            ->where('waste_type', 'Unknown')
            ->firstOr(function () {
                $other = WasteCategory::query()->firstOrCreate(
                    ['category_name' => 'Other'],
                    ['description' => 'Unclassified coastal waste'],
                );

                return WasteClassification::query()->firstOrCreate(
                    [
                        'category_id' => $other->id,
                        'waste_type' => 'Unknown',
                    ],
                );
            });
    }

    private static function officialClassification(string $name): WasteClassification
    {
        $existing = WasteClassification::query()->where('waste_type', $name)->first();
        if ($existing) {
            return $existing;
        }

        $categoryName = DatasetClasses::categoryOf($name) ?? 'Plastic';
        $category = WasteCategory::query()->firstOrCreate(
            ['category_name' => $categoryName],
            ['description' => $categoryName.' coastal waste'],
        );

        return WasteClassification::query()->firstOrCreate(
            [
                'category_id' => $category->id,
                'waste_type' => $name,
            ],
        );
    }

    /** Normalize confidence to 0–100 for DECIMAL(5,2) storage. */
    public static function confidencePercent(?float $value): float
    {
        if ($value === null) {
            return 0.0;
        }
        if ($value <= 1) {
            return round($value * 100, 2);
        }

        return round(min($value, 100), 2);
    }
}
