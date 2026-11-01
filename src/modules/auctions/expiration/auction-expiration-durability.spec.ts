import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AuctionImagesService } from '../images/auction-images.service';
import { AuctionExpirationService } from './auction-expiration.service';

const now = new Date('2026-10-14T12:00:00.000Z');
const winner = {
  id: { S: 'auction-1' },
  title: { S: 'Vintage camera' },
  status: { S: 'ACTIVE' },
  endDate: { S: '2026-10-14T11:59:00.000Z' },
  createdAt: { S: '2026-10-01T12:00:00.000Z' },
  currentBid: { N: '40' },
  highestBidderEmail: { S: 'winner@example.com' },
};

// These tests protect the durable close/enqueue contract across scheduled retries.
describe('AuctionExpirationService durability', () => {
  const images = {
    removeByAuctionId: jest
      .fn<(auctionId: string) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
  const config = new ConfigService({
    AUCTIONS_TABLE: 'test-auctions',
    WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
  });

  it('sets a 90-day TTL and sparse pending state when closing a won auction', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({})
      .mockResolvedValueOnce({ Items: [winner] });
    const sqsSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      config,
      { send: sqsSend } as unknown as SQSClient,
      images as unknown as AuctionImagesService,
    );

    await service.closeExpiredAuctions(now);

    const close = send.mock.calls[1][0] as UpdateItemCommand;
    expect(close.input).toMatchObject({
      UpdateExpression:
        'SET #status = :closed, #expiresAt = :expiresAt, #notificationStatus = :pending REMOVE #imageKey',
      ExpressionAttributeValues: expect.objectContaining({
        ':closed': { S: 'CLOSED' },
        ':pending': { S: 'PENDING' },
        ':expiresAt': {
          N: String((now.getTime() + 90 * 24 * 60 * 60 * 1000) / 1000),
        },
      }),
    });
    const markSent = send.mock.calls[2][0] as UpdateItemCommand;
    expect(markSent.input.UpdateExpression).toBe('REMOVE #notificationStatus');
  });

  it('leaves pending state queryable when enqueue fails', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({})
      .mockResolvedValueOnce({ Items: [winner] });
    const sqsSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(new Error('SQS unavailable'));
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      config,
      { send: sqsSend } as unknown as SQSClient,
      images as unknown as AuctionImagesService,
    );

    await expect(service.closeExpiredAuctions(now)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0]).toBeInstanceOf(QueryCommand);
    expect(
      send.mock.calls.filter(
        ([command]) => command instanceof UpdateItemCommand,
      ),
    ).toHaveLength(1);
  });

  it('retries pending winners from the sparse GSI on the next schedule', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [winner] });
    const sqsSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      config,
      { send: sqsSend } as unknown as SQSClient,
      images as unknown as AuctionImagesService,
    );

    await expect(service.closeExpiredAuctions(now)).resolves.toBe(0);

    const pendingQuery = send.mock.calls[1][0] as QueryCommand;
    expect(pendingQuery.input).toMatchObject({
      IndexName: 'notificationStatus-createdAt-index',
      KeyConditionExpression: '#notificationStatus = :pending',
      ExpressionAttributeValues: { ':pending': { S: 'PENDING' } },
      Limit: 100,
    });
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(
      (sqsSend.mock.calls[0][0] as SendMessageCommand).input.MessageBody,
    ).toContain('auction-1');
    const markSent = send.mock.calls[2][0] as UpdateItemCommand;
    expect(markSent.input.UpdateExpression).toBe('REMOVE #notificationStatus');
  });
});
