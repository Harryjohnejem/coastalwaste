<?php

namespace App\Support;

use Dompdf\Dompdf;
use Dompdf\Options;

/** Turn the official monitoring-report HTML into PDF bytes. */
class OfficialReportPdf
{
    public static function render(string $html): string
    {
        $options = new Options();
        $options->setIsRemoteEnabled(false);
        $options->setIsHtml5ParserEnabled(true);
        $options->setDefaultFont('DejaVu Sans');

        $dompdf = new Dompdf($options);
        $dompdf->loadHtml(self::embedSeal($html), 'UTF-8');
        // Long bond paper, 8.5 x 13 in (612 x 936 pt), the size used for printed reports.
        $dompdf->setPaper([0, 0, 612, 936], 'portrait');
        $dompdf->render();

        return $dompdf->output();
    }

    private static function embedSeal(string $html): string
    {
        $path = dirname(base_path()).DIRECTORY_SEPARATOR.'web'.DIRECTORY_SEPARATOR.'public'.DIRECTORY_SEPARATOR.'brgy-gracia-seal.jpg';
        if (! is_file($path)) {
            return $html;
        }
        $data = base64_encode((string) file_get_contents($path));
        $src = 'data:image/jpeg;base64,'.$data;

        return (string) preg_replace(
            '#src=(["\'])[^"\']*brgy-gracia-seal\.jpg\1#',
            'src="'.$src.'"',
            $html,
        );
    }
}
