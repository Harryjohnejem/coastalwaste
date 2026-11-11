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

        $exact = [
            'can' => 'Tin Can',
            'cardboard' => 'Cardboard',
            'ecobag' => 'Ecobag',
            'eco bag' => 'Ecobag',
            'face mask' => 'Other Plastic',
            'glass bottle' => 'Glass Bottle',
            'paper bag' => 'Tissue / packaging',
            'paper drink carton' => 'Paper Carton',
            'plastic bag' => 'Plastic Bag',
            'plastic bottle' => 'Plastic Bottle',
            'plastic cellophane' => 'Other Plastic',
            'plastic cup' => 'Plastic Cup',
            'plastic wrapper' => 'Other Plastic',
            'styro cup' => 'Styrofoam',
            'styrofoam' => 'Styrofoam',
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
