import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { AuctionExpirationService } from './auction-expiration.service';

describe('closeExpiredAuctions', () => {
  const previousTableName = process.env.AUCTIONS_TABLE;

  beforeEach(() => {
    process.env.AUCTIONS_TABLE = 'test-auctions';
  });

  afterAll(() => {
    if (previousTableName === undefined) {
      delete process.env.AUCTIONS_TABLE;
    } else {
      process.env.AUCTIONS_TABLE = previousTableName;
    }
  });

  it('queries expired active auctions and conditionally closes them', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            id: { S: 'auction-1' },
            status: { S: 'ACTIVE' },
            endDate: { S: '2026-10-14T11:59:00.000Z' },
          },
        ],
      })
      .mockResolvedValueOnce({});
    const client = { send } as unknown as DynamoDBClient;
    const service = new AuctionExpirationService(client);
    const now = new Date('2026-10-14T12:00:00.000Z');

    await expect(
      service.closeExpiredAuctions(now),
    ).resolves.toBe(1);

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