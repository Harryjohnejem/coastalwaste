<?php

namespace Database\Seeders;

use App\Models\WasteCategory;
use Illuminate\Database\Seeder;

class WasteCategorySeeder extends Seeder
{
    public function run(): void
    {
        $categories = [
            ['category_name' => 'Plastic', 'description' => 'Plastic waste items commonly found on coastal shorelines.'],
            ['category_name' => 'Paper', 'description' => 'Paper-based debris and packaging.'],
            ['category_name' => 'Metal', 'description' => 'Metal cans and scrap materials.'],
            ['category_name' => 'Glass', 'description' => 'Glass bottles and fragments.'],
            ['category_name' => 'Wood', 'description' => 'Wood debris and driftwood.'],
            ['category_name' => 'Fishing Gear', 'description' => 'Nets, lines, and fishing-related waste.'],
            ['category_name' => 'Styrofoam', 'description' => 'Expanded polystyrene fragments and packaging.'],
            ['category_name' => 'Other', 'description' => 'Unclassified or mixed coastal waste.'],
        ];

        foreach ($categories as $row) {
            WasteCategory::query()->updateOrCreate(
                ['category_name' => $row['category_name']],
                $row,
            );
        }
    }
}
