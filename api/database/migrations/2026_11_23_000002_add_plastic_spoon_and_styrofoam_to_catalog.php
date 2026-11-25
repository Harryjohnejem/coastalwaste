<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Waste catalog: Plastic Spoon and Styrofoam are listed under Plastic, the
 * same category the model and the report use. Styrofoam was under its own
 * hidden "Styrofoam" category; it is moved, so its old records keep their link.
 */
return new class extends Migration
{
    public function up(): void
    {
        $now = now();
        $plasticId = DB::table('waste_categories')->where('category_name', 'Plastic')->value('id');
        if (! $plasticId) {
            // Empty database (new install or tests): the seeder and the
            // detector create the catalog, so there is nothing to move yet.
            return;
        }

        foreach (['Plastic Spoon', 'Styrofoam'] as $name) {
            $existing = DB::table('waste_classifications')->where('waste_type', $name)->first();
            if ($existing) {
                DB::table('waste_classifications')
                    ->where('id', $existing->id)
                    ->update(['category_id' => $plasticId, 'updated_at' => $now]);
            } else {
                DB::table('waste_classifications')->insert([
                    'category_id' => $plasticId,
                    'waste_type' => $name,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            }
        }

        \App\Support\ClassRegistry::forget();
    }

    public function down(): void
    {
        // Kept: removing catalog classes would break records that use them.
    }
};
