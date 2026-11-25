<?php

namespace App\Support;

/** The classes in the live YOLOv11l model (weights 10), in model order. */
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
        'Plastic Bag',
        'Plastic Bottle',
        'Plastic Cellophane',
        'Plastic Cup',
        'Plastic Spoon',
        'Plastic Wrapper',
        'Styro Cup',
        'Styrofoam',
    ];

    public const CATEGORIES = ['Plastic', 'Metal', 'Glass'];

    /** Official classification → parent category. */
    public const CATEGORY_OF = [
        'Face Mask' => 'Plastic',
        'Ecobag' => 'Plastic',
        'Plastic Bag' => 'Plastic',
        'Plastic Bottle' => 'Plastic',
        'Plastic Cellophane' => 'Plastic',
        'Plastic Cup' => 'Plastic',
        'Plastic Spoon' => 'Plastic',
        'Plastic Wrapper' => 'Plastic',
        'Styro Cup' => 'Plastic',
        'Styrofoam' => 'Plastic',
        'Cardboard' => 'Paper',
        'Paper Bag' => 'Paper',
        'Paper Drink Carton' => 'Paper',
        'Can' => 'Metal',
        'Glass Bottle' => 'Glass',
    ];

    /** Any known class: the original dataset, the deployed model, and the waste catalog. */
    public static function match(?string $label): ?string
    {
        return self::matchBase($label) ?? ClassRegistry::match($label);
    }

    /** Only the original dataset classes. */
    public static function matchBase(?string $label): ?string
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
        $name = self::matchBase($label);
        if ($name) {
            return self::CATEGORY_OF[$name] ?? null;
        }
        $registry = ClassRegistry::categoryOf($label);
        if ($registry !== null) {
            return $registry;
        }
        foreach (self::CATEGORY_OF as $known => $category) {
            if (strcasecmp($known, trim((string) $label)) === 0) {
                return $category;
            }
        }

        return null;
    }
}
