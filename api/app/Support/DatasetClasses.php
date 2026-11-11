<?php

namespace App\Support;

/** The 13 classes in the live YOLOv11n model (weights 4), in model order. */
class DatasetClasses
{
    public const NAMES = [
        'Can',
        'Cardboard',
        'Ecobag',
        'Face Mask',
        'Glass Bottle',
        'Paper Bag',
        'Paper Drink Carton',
        'Plastic Bottle',
        'Plastic Cellophane',
        'Plastic Cup',
        'Plastic Wrapper',
        'Styro Cup',
        'Styrofoam',
    ];

    public const CATEGORIES = ['Plastic', 'Paper', 'Metal', 'Glass'];

    /** Official classification → parent category. */
    public const CATEGORY_OF = [
        'Face Mask' => 'Plastic',
        'Ecobag' => 'Plastic',
        'Plastic Bag' => 'Plastic',
        'Plastic Bottle' => 'Plastic',
        'Plastic Cellophane' => 'Plastic',
        'Plastic Cup' => 'Plastic',
        'Plastic Wrapper' => 'Plastic',
        'Styro Cup' => 'Plastic',
        'Styrofoam' => 'Plastic',
        'Cardboard' => 'Paper',
        'Paper Bag' => 'Paper',
        'Paper Drink Carton' => 'Paper',
        'Can' => 'Metal',
        'Glass Bottle' => 'Glass',
    ];

    public static function match(?string $label): ?string
    {
        $label = trim((string) $label);
        foreach (self::NAMES as $name) {
            if (strcasecmp($name, $label) === 0) {
                return $name;
            }
        }

        return null;
    }

    public static function categoryOf(?string $label): ?string
    {
        $name = self::match($label);
        if ($name) {
            return self::CATEGORY_OF[$name] ?? null;
        }
        foreach (self::CATEGORY_OF as $known => $category) {
            if (strcasecmp($known, trim((string) $label)) === 0) {
                return $category;
            }
        }

        return null;
    }
}
