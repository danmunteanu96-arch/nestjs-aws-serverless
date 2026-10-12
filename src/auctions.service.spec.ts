import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { AuctionsService } from './auctions.service';

describe('AuctionsService', () => {
  const dynamoDb = {
    send: jest.fn().mockResolvedValue({}),
  };
  const service = new AuctionsService(dynamoDb as unknown as DynamoDBClient);
  const previousTableName = process.env.AUCTIONS_TABLE;

  beforeEach(() => {
    process.env.AUCTIONS_TABLE = 'test-auctions';
    dynamoDb.send.mockClear();
  });

  afterAll(() => {
    if (previousTableName === undefined) {
      delete process.env.AUCTIONS_TABLE;
    } else {
      process.env.AUCTIONS_TABLE = previousTableName;
    }
  });

  it('persists a new auction and returns it', async () => {
    const auction = await service.create({ title: 'Vintage camera', status: 'ACTIVE' });

    expect(dynamoDb.send).toHaveBeenCalledWith(expect.any(PutItemCommand));
    const command = dynamoDb.send.mock.calls[0][0] as PutItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'test-auctions',
      Item: {
        id: { S: auction.id },
        entityType: { S: 'AUCTION' },
        title: { S: 'Vintage camera' },
        status: { S: 'ACTIVE' },
        createdAt: { S: auction.createdAt },
      },
    });
    expect(new Date(auction.createdAt).toISOString()).toBe(auction.createdAt);
  });

  it('queries every page of the all-auctions index', async () => {
    const firstAuction = {
      id: { S: 'auction-1' },
      title: { S: 'Vintage camera' },
      status: { S: 'ACTIVE' },
      createdAt: { S: '2026-10-10T12:00:00.000Z' },
    };
    const secondAuction = {
      id: { S: 'auction-2' },
      title: { S: 'Old radio' },
      status: { S: 'CLOSED' },
      createdAt: { S: '2026-10-11T12:00:00.000Z' },
    };
    const lastEvaluatedKey = {
      entityType: { S: 'AUCTION' },
      createdAt: { S: firstAuction.createdAt.S },
      id: { S: firstAuction.id.S },
    };
    dynamoDb.send
      .mockResolvedValueOnce({ Items: [firstAuction], LastEvaluatedKey: lastEvaluatedKey })
      .mockResolvedValueOnce({ Items: [secondAuction] });

    await expect(service.getAll()).resolves.toEqual([
      {
        id: 'auction-1',
        title: 'Vintage camera',
        status: 'ACTIVE',
        createdAt: '2026-10-10T12:00:00.000Z',
      },
      {
        id: 'auction-2',
        title: 'Old radio',
        status: 'CLOSED',
        createdAt: '2026-10-11T12:00:00.000Z',
      },
    ]);

    expect(dynamoDb.send).toHaveBeenCalledTimes(2);
    expect(dynamoDb.send).toHaveBeenNthCalledWith(1, expect.any(QueryCommand));
    expect(dynamoDb.send).toHaveBeenNthCalledWith(2, expect.any(QueryCommand));
    const secondQuery = dynamoDb.send.mock.calls[1][0] as QueryCommand;
    expect(secondQuery.input).toMatchObject({
      TableName: 'test-auctions',
      IndexName: 'all-auctions-index',
      ExclusiveStartKey: lastEvaluatedKey,
    });
  });

  it('logs DynamoDB errors and throws a safe server error', async () => {
    dynamoDb.send.mockRejectedValueOnce(new Error('AccessDeniedException: sensitive detail'));

    await expect(
      service.create({ title: 'Vintage camera', status: 'ACTIVE' }),
    ).rejects.toThrow('Failed to create auction');
  });
});