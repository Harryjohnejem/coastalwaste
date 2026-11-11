<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('waste_quotas');
    }

    public function down(): void
    {
        // The original create_waste_quotas migration recreates the table if rolled back in order.
    }
};
