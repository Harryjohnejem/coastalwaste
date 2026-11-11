<?php

namespace Tests\Unit;

use App\Support\DatasetAttribution;
use PHPUnit\Framework\TestCase;

class DatasetAttributionTest extends TestCase
{
    public function test_merged_model_live_defaults_are_not_local_subsets(): void
    {
        $row = DatasetAttribution::forMergedModelLiveDetection();

        $this->assertSame(DatasetAttribution::TRAINING_COMBINED, $row['training_dataset']);
        $this->assertSame(
            DatasetAttribution::COMBINED_NOT_ATTRIBUTABLE,
            $row['dataset_attribution'],
        );
        $this->assertStringContainsString(
            'Not Attributable',
            DatasetAttribution::label($row['dataset_attribution']),
        );
    }

    public function test_null_and_unknown_normalize_safely(): void
    {
        $this->assertSame(DatasetAttribution::UNKNOWN, DatasetAttribution::normalize(null));
        $this->assertSame(DatasetAttribution::UNKNOWN, DatasetAttribution::normalize(''));
        $this->assertSame('Unknown / Not Attributable', DatasetAttribution::label(null));
    }

    public function test_local_labels_only_when_explicit(): void
    {
        $this->assertSame('Local 1', DatasetAttribution::label('local_1'));
        $this->assertSame('Local 2', DatasetAttribution::label('local_2'));
    }
}
