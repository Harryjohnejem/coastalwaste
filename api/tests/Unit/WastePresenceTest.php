<?php

namespace Tests\Unit;

use App\Support\WastePresence;
use PHPUnit\Framework\TestCase;

class WastePresenceTest extends TestCase
{
    public function test_different_class_does_not_match(): void
    {
        $score = WastePresence::candidateScore(
            'Plastic Bottle',
            [1, 0, 0],
            'Can',
            [1, 0, 0],
            5,
            120,
        );

        $this->assertSame(0.0, $score);
    }

    public function test_missing_histogram_does_not_match(): void
    {
        $score = WastePresence::candidateScore(
            'Plastic Bottle',
            [],
            'Plastic Bottle',
            [1, 0],
            5,
            120,
        );

        $this->assertSame(0.0, $score);
    }

    public function test_one_strong_candidate_is_linked(): void
    {
        $match = WastePresence::chooseMatch([
            4 => 0.9,
            5 => 0.4,
        ], 0.82);

        $this->assertSame(4, $match);
    }

    public function test_two_strong_candidates_are_not_merged(): void
    {
        $match = WastePresence::chooseMatch([
            4 => 0.91,
            5 => 0.88,
        ], 0.82);

        $this->assertNull($match);
    }

    public function test_identical_histograms_score_high(): void
    {
        $histogram = array_fill(0, 16, 1 / 16);
        $score = WastePresence::candidateScore(
            'Plastic Bottle',
            $histogram,
            'Plastic Bottle',
            $histogram,
            0,
            120,
        );

        $this->assertGreaterThanOrEqual(0.82, $score);
    }
}
