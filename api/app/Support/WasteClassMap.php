<?php

namespace App\Support;

/**
 * Class order of the live YOLOv11n ONNX model (weights 4).
 * Indexes are not alphabetical. Plastic Bag is not in this model.
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
        'Plastic Bottle',
        'Plastic Cellophane',
        'Plastic Cup',
        'Plastic Wrapper',
        'Styro Cup',
        'Styrofoam',
    ];

    public static function index(string $name): ?int
    {
        $index = array_search($name, self::CLASSES, true);

        return $index === false ? null : (int) $index;
    }

    public static function yaml(): string
    {
        $lines = [
            'path: .',
            'train: images/train',
            'val: images/val',
            'names:',
        ];
        foreach (self::CLASSES as $index => $name) {
            $lines[] = "  {$index}: {$name}";
        }

        return implode("\n", $lines)."\n";
    }
}
