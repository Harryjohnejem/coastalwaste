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
            'Plastic' => ['Plastic Bottle', 'Plastic Bag', 'Ecobag', 'Plastic Cup', 'Plastic Spoon', 'Bottle Cap', 'Straw'],
            'Metal' => [],
            'Glass' => ['Glass Bottle'],
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
