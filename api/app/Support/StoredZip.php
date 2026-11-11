<?php

namespace App\Support;

/**
 * Uncompressed ZIP writer. Used when the PHP zip extension is not loaded.
 */
class StoredZip
{
    /**
     * @param  array<string, string>  $files
     */
    public static function write(string $path, array $files): void
    {
        $local = '';
        $central = '';
        $offset = 0;
        $count = 0;

        foreach ($files as $name => $data) {
            $name = str_replace('\\', '/', (string) $name);
            $size = strlen($data);
            $crc = crc32($data) & 0xFFFFFFFF;
            $nameLen = strlen($name);
            $header = pack(
                'VvvvvvVVVvv',
                0x04034b50,
                20,
                0,
                0,
                0,
                0,
                $crc,
                $size,
                $size,
                $nameLen,
                0,
            );
            $local .= $header.$name.$data;
            $central .= pack(
                'VvvvvvvVVVvvvvvVV',
                0x02014b50,
                20,
                20,
                0,
                0,
                0,
                0,
                $crc,
                $size,
                $size,
                $nameLen,
                0,
                0,
                0,
                0,
                0,
                $offset,
            ).$name;
            $offset += strlen($header) + $nameLen + $size;
            $count++;
        }

        $eocd = pack(
            'VvvvvVVv',
            0x06054b50,
            0,
            0,
            $count,
            $count,
            strlen($central),
            $offset,
            0,
        );

        if (file_put_contents($path, $local.$central.$eocd) === false) {
            throw new \RuntimeException('Could not write the dataset archive.');
        }
    }
}
