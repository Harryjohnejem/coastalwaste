<?php

namespace App\Support;

use App\Models\WasteClassification;

/**
 * Review and training class order. Plastic Bag stays at class 7 for existing labels.
 * The live detector uses weights 11, which does not include Plastic Bag.
 * Catalog classifications added from Detection Reviews follow these names.
 */
class WasteClassMap
{
    public const CLASSES = [
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

    /**
     * Official model classes, then classifications added in the waste catalog.
     *
     * @return list<string>
     */
    public static function classes(): array
    {
        $names = self::CLASSES;
        $known = array_map('strtolower', $names);
        $extra = collect(ClassRegistry::modelClasses())->merge(
            WasteClassification::query()->orderBy('id')->pluck('waste_type'),
        );
        foreach ($extra as $raw) {
            $name = trim((string) $raw);
            $key = strtolower($name);
            if ($name === '' || in_array($key, $known, true)) {
                continue;
            }
            $known[] = $key;
            $names[] = $name;
        }

        return $names;
    }

    public static function index(string $name): ?int
    {
        $needle = strtolower(trim($name));
        foreach (self::classes() as $index => $known) {
            if (strtolower($known) === $needle) {
                return $index;
            }
        }

        return null;
    }

    public static function canonical(string $name): ?string
    {
        $index = self::index($name);

        return $index === null ? null : self::classes()[$index];
    }

    public static function yaml(): string
    {
        $lines = [
            'path: .',
            'train: images/train',
            'val: images/val',
            'names:',
        ];
        foreach (self::classes() as $index => $name) {
            $lines[] = "  {$index}: {$name}";
        }

        return implode("\n", $lines)."\n";
    }
}
