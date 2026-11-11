<?php

namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Attachment;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/** Official monitoring report. The From address stays the configured Gmail account. */
class CoastalReportMail extends Mailable
{
    use Queueable, SerializesModels;

    public const MESSAGE = 'Good day. The attached PDF is the Coastal Waste Monitoring and Reporting record for Paco Beach, Barangay Gracia, Tagoloan, Misamis Oriental. This message is sent by the Coastal Waste Monitoring and Reporting System.';

    public function __construct(
        public string $pdf,
        public string $filename,
        public string $reportNumber,
        public string $monitoringPeriod,
        public string $bodyText = self::MESSAGE,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            subject: 'Coastal Waste Monitoring Report '.$this->reportNumber,
        );
    }

    public function content(): Content
    {
        return new Content(
            htmlString: '<p>'.nl2br(e($this->bodyText !== '' ? $this->bodyText : self::MESSAGE)).'</p>',
        );
    }

    /**
     * @return array<int, Attachment>
     */
    public function attachments(): array
    {
        return [
            Attachment::fromData(fn () => $this->pdf, $this->filename)
                ->withMime('application/pdf'),
        ];
    }
}
