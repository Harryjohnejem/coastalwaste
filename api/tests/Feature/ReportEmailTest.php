<?php

namespace Tests\Feature;

use App\Mail\CoastalReportMail;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Symfony\Component\Mailer\Exception\TransportException;
use Tests\TestCase;

class ReportEmailTest extends TestCase
{
    use RefreshDatabase;

    private function html(): string
    {
        return '<!DOCTYPE html><html><body><p>Computer Vision-Based Coastal Waste Monitoring and Reporting System</p><p>Paco Beach</p></body></html>';
    }

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'recipients' => ['inspector@example.com', 'clerk@example.com'],
            'html' => $this->html(),
            'report_number' => 'CWMR-test',
            'monitoring_period' => 'Paco Beach, Barangay Gracia · Today',
        ], $overrides);
    }

    public function test_guest_cannot_email_a_report(): void
    {
        $this->postJson('/api/reports/email', $this->payload())->assertUnauthorized();
    }

    public function test_non_admin_cannot_email_a_report(): void
    {
        $staff = User::factory()->create([
            'role' => 'Staff',
            'email' => 'staff@example.com',
        ]);

        $this->actingAs($staff)
            ->postJson('/api/reports/email', $this->payload())
            ->assertForbidden();
    }

    public function test_recipients_must_be_email_addresses(): void
    {
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->actingAs($admin)
            ->postJson('/api/reports/email', $this->payload([
                'recipients' => ['not-an-email'],
            ]))
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['recipients.0']);
    }

    public function test_admin_email_sends_a_pdf_attachment_without_contacting_gmail(): void
    {
        Mail::fake();
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->actingAs($admin)
            ->postJson('/api/reports/email', $this->payload())
            ->assertOk()
            ->assertJsonPath('sent', true)
            ->assertJsonPath('recipients.0', 'inspector@example.com')
            ->assertJsonPath('recipients.1', 'clerk@example.com');

        Mail::assertSent(CoastalReportMail::class, function (CoastalReportMail $mail) {
            $attachment = $mail->attachments()[0];

            return $mail->hasTo('inspector@example.com')
                && $mail->hasTo('clerk@example.com')
                && $attachment->as === 'CWMR-test.pdf'
                && str_starts_with($mail->pdf, '%PDF')
                && str_contains($mail->render(), CoastalReportMail::MESSAGE);
        });
        Mail::assertSentCount(1);
    }

    public function test_a_changed_message_is_sent_instead_of_the_fixed_text(): void
    {
        Mail::fake();
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->actingAs($admin)
            ->postJson('/api/reports/email', $this->payload([
                'message' => 'Please review the attached monitoring report.',
            ]))
            ->assertOk();

        Mail::assertSent(CoastalReportMail::class, function (CoastalReportMail $mail) {
            $rendered = $mail->render();

            return str_contains($rendered, 'Please review the attached monitoring report.')
                && ! str_contains($rendered, CoastalReportMail::MESSAGE);
        });
    }

    public function test_gmail_auth_failure_returns_a_clear_message(): void
    {
        $pending = \Mockery::mock();
        $pending->shouldReceive('send')->once()->andThrow(new TransportException(
            'Failed to authenticate on SMTP server with username "coastalwasterm@gmail.com" using LOGIN 535-5.7.8 Username and Password not accepted.'
        ));
        Mail::shouldReceive('to')->once()->andReturn($pending);

        $admin = User::factory()->create(['role' => 'Admin']);
        $response = $this->actingAs($admin)
            ->postJson('/api/reports/email', $this->payload())
            ->assertStatus(422);
        $this->assertStringContainsString('App Password', (string) $response->json('message'));
    }

    public function test_the_same_report_cannot_be_sent_twice_immediately(): void
    {
        Mail::fake();
        $admin = User::factory()->create(['role' => 'Admin']);

        $this->actingAs($admin)
            ->postJson('/api/reports/email', $this->payload())
            ->assertOk();

        $this->actingAs($admin)
            ->postJson('/api/reports/email', $this->payload())
            ->assertStatus(429);

        Mail::assertSentCount(1);
    }
}
