<?php

namespace Database\Seeders;

use App\Models\WasteQuota;
use Illuminate\Database\Seeder;

class WasteQuotaSeeder extends Seeder
{
    public function run(): void
    {
        WasteQuota::query()->updateOrCreate(
            ['name' => 'Daily coastal quota · Paco Beach'],
            [
                'camera_id' => null,
                'category_id' => null,
                'quota_limit' => 50,
                'period' => 'daily',
                'cleanup_recommendation' => 'Conduct cleanup within the next hour along Paco Beach, Barangay Gracia.',
                'is_active' => true,
            ],
        );
    }
}
