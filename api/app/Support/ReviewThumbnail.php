<?php

namespace App\Support;

use Illuminate\Support\Facades\Storage;

/**
 * Small JPEG thumbnails for the Detection Reviews table.
 *
 * The table used to load every full snapshot (~100 KB each). On Windows the
 * PHP dev server serves those files one at a time, so a 200-row page blocked
 * the API. A thumbnail is ~5 KB. Without the GD extension the original image
 * URL is returned, so the page still works.
 */
class ReviewThumbnail
{
    public const MAX_WIDTH = 160;

    public static function available(): bool
    {
        return function_exists('imagecreatefromstring') && function_exists('imagejpeg');
    }

    public static function pathFor(string $imagePath): string
    {
        $name = pathinfo($imagePath, PATHINFO_FILENAME);

        return 'missed-detections/thumbs/'.$name.'.jpg';
    }

    /** Public URL of the thumbnail, created on first use. Falls back to the original. */
    public static function url(?string $imagePath): ?string
    {
        if (! $imagePath) {
            return null;
        }
        $thumb = self::pathFor($imagePath);
        $disk = Storage::disk('public');
        if ($disk->exists($thumb) || self::make($imagePath)) {
            return '/storage/'.$thumb;
        }

        return '/storage/'.$imagePath;
    }

    public static function make(string $imagePath): bool
    {
        if (! self::available()) {
            return false;
        }
        $disk = Storage::disk('public');
        if (! $disk->exists($imagePath)) {
            return false;
        }
        $source = @imagecreatefromstring((string) $disk->get($imagePath));
        if ($source === false) {
            return false;
        }
        $width = imagesx($source);
        $height = imagesy($source);
        if ($width < 1 || $height < 1) {
            imagedestroy($source);

            return false;
        }
        $targetW = min(self::MAX_WIDTH, $width);
        $targetH = max(1, (int) round($height * $targetW / $width));
        $thumb = imagecreatetruecolor($targetW, $targetH);
        imagecopyresampled($thumb, $source, 0, 0, 0, 0, $targetW, $targetH, $width, $height);
        ob_start();
        imagejpeg($thumb, null, 72);
        $bytes = (string) ob_get_clean();
        imagedestroy($thumb);
        imagedestroy($source);

        return $bytes !== '' && $disk->put(self::pathFor($imagePath), $bytes);
    }

    public static function delete(?string $imagePath): void
    {
        if ($imagePath) {
            Storage::disk('public')->delete(self::pathFor($imagePath));
        }
    }
}
