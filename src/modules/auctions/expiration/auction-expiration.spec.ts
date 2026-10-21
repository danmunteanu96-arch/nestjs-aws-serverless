import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AuctionStatus } from '../auctions.types';
import { AuctionExpirationService } from './auction-expiration.service';

describe('closeExpiredAuctions', () => {
  it('queries expired active auctions and conditionally closes them', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            status: { S: AuctionStatus.ACTIVE },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const client = { send } as unknown as DynamoDBClient;
    const sqs = { send: jest.fn() } as unknown as SQSClient;
    const service = new AuctionExpirationService(
      client,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
      }),
      sqs,
    );
    const now = new Date('2026-10-14T12:00:00.000Z');

    await expect(service.closeExpiredAuctions(now)).resolves.toBe(1);

    const query = send.mock.calls[0][0] as QueryCommand;
    expect(query.input).toMatchObject({
      TableName: 'test-auctions',
      IndexName: 'status-endDate-v2-index',
      KeyConditionExpression: '#status = :active AND #endDate <= :now',
      ExpressionAttributeValues: {
        ':active': { S: 'ACTIVE' },
        ':now': { S: '2026-10-14T12:00:00.000Z' },
      },
    });

    const update = send.mock.calls[1][0] as UpdateItemCommand;
    expect(update.input).toMatchObject({
      Key: { id: { S: 'auction-1' } },
      UpdateExpression: 'SET #status = :closed',
      ConditionExpression:
        'attribute_exists(#id) AND #status = :active AND #endDate <= :now',
      ExpressionAttributeValues: {
        ':active': { S: 'ACTIVE' },
        ':closed': { S: 'CLOSED' },
      },
    });
  });

  it('enqueues a winner notification when an auction with bids closes', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            title: { S: 'Vintage camera' },
            status: { S: AuctionStatus.ACTIVE },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
            currentBid: { N: '40' },
            highestBidderEmail: { S: 'winner@example.com' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const sqsSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
      }),
      { send: sqsSend } as unknown as SQSClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);

    expect(sqsSend).toHaveBeenCalledTimes(1);
    const message = sqsSend.mock.calls[0][0] as SendMessageCommand;
    expect(message.input.QueueUrl).toBe('https://sqs.test/queue');
    expect(JSON.parse(message.input.MessageBody ?? '')).toEqual({
      auctionId: 'auction-1',
      recipient: 'winner@example.com',
      title: 'Vintage camera',
      winningBid: '40',
    });
  });

  it('does not enqueue when the closed auction has no winner', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            status: { S: AuctionStatus.ACTIVE },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const sqsSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
      }),
      { send: sqsSend } as unknown as SQSClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);

    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('still counts the close when enqueueing the notification fails', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            title: { S: 'Vintage camera' },
            status: { S: AuctionStatus.ACTIVE },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
            currentBid: { N: '40' },
            highestBidderEmail: { S: 'winner@example.com' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const sqsSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('SQS unavailable'));
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
      }),
      { send: sqsSend } as unknown as SQSClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);
  });

  it('skips the notification when the queue URL is not configured', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            title: { S: 'Vintage camera' },
            status: { S: AuctionStatus.ACTIVE },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
            currentBid: { N: '40' },
            highestBidderEmail: { S: 'winner@example.com' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const sqsSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        WINNER_NOTIFICATIONS_QUEUE_URL: '',
      }),
      { send: sqsSend } as unknown as SQSClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);

    expect(sqsSend).not.toHaveBeenCalled();
  });
});
