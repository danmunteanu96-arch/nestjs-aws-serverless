import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
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
    const ses = { send: jest.fn() } as unknown as SESClient;
    const service = new AuctionExpirationService(
      client,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        SES_SENDER_EMAIL: 'sender@example.com',
      }),
      ses,
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

  it('emails the winner when an auction with bids closes', async () => {
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
    const sesSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        SES_SENDER_EMAIL: 'sender@example.com',
      }),
      { send: sesSend } as unknown as SESClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);

    expect(sesSend).toHaveBeenCalledTimes(1);
    const email = sesSend.mock.calls[0][0] as SendEmailCommand;
    expect(email.input).toMatchObject({
      Source: 'sender@example.com',
      Destination: { ToAddresses: ['winner@example.com'] },
    });
    expect(email.input.Message?.Subject?.Data).toContain('Vintage camera');
    // Multipart: a styled HTML part AND a plain-text fallback
    expect(email.input.Message?.Body?.Html?.Data).toContain('Vintage camera');
    expect(email.input.Message?.Body?.Text?.Data).toContain('Vintage camera');
  });

  it('escapes HTML from the auction title in the email body', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            title: { S: '<img src=x onerror=alert(1)>' },
            status: { S: AuctionStatus.ACTIVE },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
            currentBid: { N: '40' },
            highestBidderEmail: { S: 'winner@example.com' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const sesSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        SES_SENDER_EMAIL: 'sender@example.com',
      }),
      { send: sesSend } as unknown as SESClient,
    );

    await service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z'));

    const email = sesSend.mock.calls[0][0] as SendEmailCommand;
    const html = email.input.Message?.Body?.Html?.Data ?? '';
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('does not email when the closed auction has no winner', async () => {
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
    const sesSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        SES_SENDER_EMAIL: 'sender@example.com',
      }),
      { send: sesSend } as unknown as SESClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);

    expect(sesSend).not.toHaveBeenCalled();
  });

  it('still counts the close when the winner email fails to send', async () => {
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
    const sesSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('SES throttled'));
    const service = new AuctionExpirationService(
      { send } as unknown as DynamoDBClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        SES_SENDER_EMAIL: 'sender@example.com',
      }),
      { send: sesSend } as unknown as SESClient,
    );

    await expect(
      service.closeExpiredAuctions(new Date('2026-10-14T12:00:00.000Z')),
    ).resolves.toBe(1);
  });
});
