<?php

namespace Database\Seeders;

use App\Models\WasteCategory;
use App\Models\WasteClassification;
use Illuminate\Database\Seeder;

class WasteClassificationSeeder extends Seeder
{
    public function run(): void
    {
        $map = [
            'Plastic' => ['Plastic Bottle', 'Plastic Bag', 'Plastic Cup', 'Bottle Cap', 'Straw', 'Other Plastic'],
            'Paper' => ['Paper Carton', 'Cardboard', 'Newspaper', 'Tissue / packaging'],
            'Metal' => ['Tin Can', 'Aluminum', 'Scrap Metal'],
            'Glass' => ['Glass Bottle', 'Glass Fragment'],
            'Wood' => ['Wood Debris', 'Driftwood', 'Pallet / lumber'],
            'Fishing Gear' => ['Fishing Net', 'Fishing Line'],
            'Styrofoam' => ['Styrofoam'],
            'Other' => ['Coastal Debris', 'Litter', 'Cigarette', 'Unknown'],
        ];

        foreach ($map as $categoryName => $types) {
            $category = WasteCategory::query()->where('category_name', $categoryName)->first();
            if (! $category) {
                continue;
            }

            foreach ($types as $type) {
                WasteClassification::query()->updateOrCreate(
                    [
                        'category_id' => $category->id,
                        'waste_type' => $type,
                    ],
                );
            }
        }
    }
}
