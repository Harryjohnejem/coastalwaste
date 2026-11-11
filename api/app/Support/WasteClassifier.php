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

        $rules = [
            ['Glass Bottle', ['glass bottle']],
            ['Glass Fragment', ['broken glass', 'glass jar', 'glass']],
            ['Tin Can', ['tin can', 'metal can', 'can']],
            ['Aluminum', ['pop tab', 'aluminum foil', 'aluminium foil', 'aluminum', 'aluminium']],
            ['Scrap Metal', ['scrap metal', 'metal']],
            ['Paper Carton', ['carton', 'paper carton']],
            ['Cardboard', ['cardboard']],
            ['Newspaper', ['newspaper']],
            ['Tissue / packaging', ['tissue', 'packaging paper']],
            ['Cigarette', ['cigarette']],
            ['Straw', ['straw']],
            ['Bottle Cap', ['bottle cap', 'lid']],
            ['Plastic Bottle', ['plastic bottle', 'bottle']],
            ['Plastic Bag', ['plastic bag', 'bag', 'trash bag']],
            ['Plastic Cup', ['plastic cup', 'cup']],
            ['Fishing Net', ['fishing net', 'net', 'fishing']],
            ['Styrofoam', ['styrofoam', 'foam']],
            ['Wood Debris', ['wood debris', 'wood']],
            ['Driftwood', ['driftwood']],
            ['Pallet / lumber', ['pallet', 'lumber']],
            ['Other Plastic', ['plastic utensils', 'wrapper', 'plastic']],
            ['Coastal Debris', ['debris']],
            ['Litter', ['unlabeled litter', 'other litter', 'litter', 'trash', 'waste']],
        ];

        foreach ($rules as [$wasteType, $needles]) {
            foreach ($needles as $needle) {
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
