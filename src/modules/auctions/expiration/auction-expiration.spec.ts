import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
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
    const service = new AuctionExpirationService(
      client,
      new ConfigService({ AUCTIONS_TABLE: 'test-auctions' }),
    );
    const now = new Date('2026-10-14T12:00:00.000Z');

    await expect(service.closeExpiredAuctions(now)).resolves.toBe(1);

    const query = send.mock.calls[0][0] as QueryCommand;
    expect(query.input).toMatchObject({
      TableName: 'test-auctions',
      IndexName: 'status-endDate-index',
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
});
