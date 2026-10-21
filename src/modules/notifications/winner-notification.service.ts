import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Shape of the SQS message produced by AuctionExpirationService.
export interface WinnerNotificationPayload {
  auctionId?: string;
  recipient: string;
  title: string;
  winningBid?: string;
}

@Injectable()
export class WinnerNotificationService {
  private readonly logger = new Logger(WinnerNotificationService.name);

  constructor(
    private readonly ses: SESClient,
    private readonly configService: ConfigService,
  ) {}

  // Sends the "you won" email. Unlike the old inline implementation, errors
  // are NOT swallowed: a thrown error fails the SQS-triggered invocation,
  // which makes the queue redeliver the message (and move it to the DLQ
  // after maxReceiveCount). A missing sender is a permanent misconfiguration,
  // so it throws as well — the message belongs in the DLQ for a human.
  async sendWinnerEmail(payload: WinnerNotificationPayload): Promise<void> {
    const sender = this.configService.get<string>('SES_SENDER_EMAIL');
    if (!sender) {
      throw new Error('SES_SENDER_EMAIL is not configured');
    }

    const { auctionId, recipient, title, winningBid } = payload;
    const bidText = winningBid ? ` with a winning bid of ${winningBid}` : '';

    // Multipart body: HTML for humans, plain-text fallback for screen readers,
    // strict clients, and spam-score. The title is user input — escape it
    // before embedding in HTML or it becomes an injection vector.
    const safeTitle = escapeHtml(title);
    const text = `Congratulations! You won "${title}"${bidText}.`;
    const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background-color:#ffffff;">
      <div style="background-color:#1a1a2e;color:#ffffff;padding:24px;text-align:center;">
        <h1 style="margin:0;font-size:22px;">Serverless Auctions</h1>
      </div>
      <div style="padding:24px;color:#333333;font-size:15px;line-height:1.5;">
        <p style="margin:0 0 12px;">Congratulations!</p>
        <p style="margin:0;">You won <strong>&quot;${safeTitle}&quot;</strong>${escapeHtml(bidText)}.</p>
      </div>
      <div style="padding:16px;text-align:center;color:#888888;font-size:12px;">
        You received this email because you placed the winning bid.
      </div>
    </div>
  </body>
</html>`;

    await this.ses.send(
      new SendEmailCommand({
        Source: sender,
        Destination: { ToAddresses: [recipient] },
        Message: {
          Subject: { Data: `You won the auction: ${title}` },
          Body: {
            Text: { Data: text },
            Html: { Data: html },
          },
        },
      }),
    );
    this.logger.log(`Winner notification sent for auction ${auctionId}`);
  }
}

// Minimal HTML escaping for user-controlled strings embedded in email markup.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
