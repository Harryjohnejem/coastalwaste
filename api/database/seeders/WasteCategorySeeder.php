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
            ['category_name' => 'Metal', 'description' => 'Metal cans and scrap materials.'],
            ['category_name' => 'Glass', 'description' => 'Glass bottles and fragments.'],
        ];

        foreach ($categories as $row) {
            WasteCategory::query()->updateOrCreate(
                ['category_name' => $row['category_name']],
                $row,
            );
        }
    }
}
