<?php

namespace Tests\Unit;

use App\Models\WasteCategory;
use App\Models\WasteClassification;
use App\Support\WasteClassifier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class WasteClassifierTest extends TestCase
{
    use RefreshDatabase;

    public function test_maps_yolo_label_to_catalog_type(): void
    {
        $plastic = WasteCategory::query()->create([
            'category_name' => 'Plastic',
        ]);
        WasteClassification::query()->create([
            'category_id' => $plastic->id,
            'waste_type' => 'Plastic Bottle',
        ]);

        $resolved = WasteClassifier::resolve('plastic bottle');

        $this->assertSame('Plastic Bottle', $resolved->waste_type);
        $this->assertSame($plastic->id, $resolved->category_id);
    }

    public function test_normalizes_fraction_confidence_to_percent(): void
    {
        $this->assertSame(85.0, WasteClassifier::confidencePercent(0.85));
        $this->assertSame(90.0, WasteClassifier::confidencePercent(90));
        $this->assertSame(0.0, WasteClassifier::confidencePercent(null));
    }
}
