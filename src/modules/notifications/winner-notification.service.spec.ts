import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { WinnerNotificationService } from './winner-notification.service';

describe('WinnerNotificationService', () => {
  it('sends a multipart email to the winner', async () => {
    const sesSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new WinnerNotificationService(
      { send: sesSend } as unknown as SESClient,
      new ConfigService({ SES_SENDER_EMAIL: 'sender@example.com' }),
    );

    await service.sendWinnerEmail({
      auctionId: 'auction-1',
      recipient: 'winner@example.com',
      title: 'Vintage camera',
      winningBid: '40',
    });

    expect(sesSend).toHaveBeenCalledTimes(1);
    const email = sesSend.mock.calls[0][0] as SendEmailCommand;
    expect(email.input).toMatchObject({
      Source: 'sender@example.com',
      Destination: { ToAddresses: ['winner@example.com'] },
    });
    expect(email.input.Message?.Subject?.Data).toContain('Vintage camera');
    // Multipart: a styled HTML part AND a plain-text fallback
    expect(email.input.Message?.Body?.Html?.Data).toContain('Vintage camera');
    expect(email.input.Message?.Body?.Html?.Data).toContain('40');
    expect(email.input.Message?.Body?.Text?.Data).toContain('Vintage camera');
  });

  it('escapes HTML from the auction title in the email body', async () => {
    const sesSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new WinnerNotificationService(
      { send: sesSend } as unknown as SESClient,
      new ConfigService({ SES_SENDER_EMAIL: 'sender@example.com' }),
    );

    await service.sendWinnerEmail({
      auctionId: 'auction-1',
      recipient: 'winner@example.com',
      title: '<img src=x onerror=alert(1)>',
    });

    const email = sesSend.mock.calls[0][0] as SendEmailCommand;
    const html = email.input.Message?.Body?.Html?.Data ?? '';
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('propagates SES errors so SQS retries the message', async () => {
    const sesSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(new Error('SES throttled'));
    const service = new WinnerNotificationService(
      { send: sesSend } as unknown as SESClient,
      new ConfigService({ SES_SENDER_EMAIL: 'sender@example.com' }),
    );

    await expect(
      service.sendWinnerEmail({
        auctionId: 'auction-1',
        recipient: 'winner@example.com',
        title: 'Vintage camera',
      }),
    ).rejects.toThrow('SES throttled');
  });

  it('throws when the sender address is not configured', async () => {
    const sesSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new WinnerNotificationService(
      { send: sesSend } as unknown as SESClient,
      new ConfigService({ SES_SENDER_EMAIL: '' }),
    );

    await expect(
      service.sendWinnerEmail({
        auctionId: 'auction-1',
        recipient: 'winner@example.com',
        title: 'Vintage camera',
      }),
    ).rejects.toThrow('SES_SENDER_EMAIL');
    expect(sesSend).not.toHaveBeenCalled();
  });
});
