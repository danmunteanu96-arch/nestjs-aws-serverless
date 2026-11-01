import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { NotificationIdempotencyService } from './notification-idempotency.service';
import { WinnerNotificationHandler } from './winner-notification.handler';
import { WinnerNotificationService } from './winner-notification.service';
import type { WinnerNotificationPayload } from './winner-notification.types';

const validBody = JSON.stringify({
  auctionId: 'auction-1',
  recipient: 'winner@example.com',
  title: 'Vintage camera',
  winningBid: '40',
});
const record = (messageId: string, body = validBody): SQSRecord => ({
  messageId,
  receiptHandle: `receipt-${messageId}`,
  body,
  attributes: {} as SQSRecord['attributes'],
  messageAttributes: {},
  md5OfBody: 'md5',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:eu-central-1:123456789012:winner-queue',
  awsRegion: 'eu-central-1',
});
const event = (...records: SQSRecord[]): SQSEvent => ({ Records: records });

// The handler tests verify per-record acknowledgement and durable fallback, not SES rendering.
describe('WinnerNotificationHandler', () => {
  const notifications = {
    sendWinnerEmail: jest
      .fn<(payload: WinnerNotificationPayload) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const idempotency = {
    claim: jest
      .fn<
        (
          auctionId: string,
          token: string,
        ) => Promise<'claimed' | 'duplicate' | 'busy'>
      >()
      .mockResolvedValue('claimed'),
    complete: jest
      .fn<(auctionId: string, token: string) => Promise<void>>()
      .mockResolvedValue(undefined),
    release: jest
      .fn<(auctionId: string, token: string) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const sqsSend = jest
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValue({});
  const handler = new WinnerNotificationHandler(
    notifications as unknown as WinnerNotificationService,
    idempotency as unknown as NotificationIdempotencyService,
    { send: sqsSend } as unknown as SQSClient,
    new ConfigService({ WINNER_NOTIFICATIONS_DLQ_URL: 'https://sqs.test/dlq' }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    notifications.sendWinnerEmail.mockResolvedValue(undefined);
    idempotency.claim.mockResolvedValue('claimed');
    idempotency.complete.mockResolvedValue(undefined);
    idempotency.release.mockResolvedValue(undefined);
    sqsSend.mockResolvedValue({});
  });

  it('routes a malformed payload to manual DLQ without claiming or sending', async () => {
    await expect(
      handler.handle(event(record('bad-json', '{'))),
    ).resolves.toEqual({
      batchItemFailures: [],
    });

    expect(idempotency.claim).not.toHaveBeenCalled();
    expect(notifications.sendWinnerEmail).not.toHaveBeenCalled();
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(
      (sqsSend.mock.calls[0][0] as SendMessageCommand).input,
    ).toMatchObject({
      QueueUrl: 'https://sqs.test/dlq',
      MessageBody: '{',
    });
  });

  it('acknowledges a completed duplicate without sending another email', async () => {
    idempotency.claim.mockResolvedValueOnce('duplicate');

    await expect(handler.handle(event(record('duplicate')))).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(notifications.sendWinnerEmail).not.toHaveBeenCalled();
    expect(idempotency.complete).not.toHaveBeenCalled();
  });

  it('acknowledges an in-progress lease without treating it as completed', async () => {
    idempotency.claim.mockResolvedValueOnce('busy');

    await handler.handle(event(record('busy')));
    expect(notifications.sendWinnerEmail).not.toHaveBeenCalled();
    expect(idempotency.complete).not.toHaveBeenCalled();
    expect(idempotency.release).not.toHaveBeenCalled();
  });

  it('returns only the record whose SES and DLQ fallback both failed', async () => {
    notifications.sendWinnerEmail
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('SES unavailable'));
    sqsSend.mockRejectedValueOnce(new Error('DLQ unavailable'));

    await expect(
      handler.handle(event(record('success'), record('retry'))),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: 'retry' }],
    });
    expect(idempotency.complete).toHaveBeenCalledTimes(1);
    expect(idempotency.release).toHaveBeenCalledTimes(1);
  });

  it('releases the lease after a successful manual DLQ fallback', async () => {
    notifications.sendWinnerEmail.mockRejectedValueOnce(
      new Error('SES rejected'),
    );

    await expect(handler.handle(event(record('dlq-success')))).resolves.toEqual(
      {
        batchItemFailures: [],
      },
    );
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(idempotency.release).toHaveBeenCalledTimes(1);
    expect(idempotency.complete).not.toHaveBeenCalled();
  });
});
