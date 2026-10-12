import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
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
        title: { S: 'Vintage camera' },
        status: { S: 'ACTIVE' },
        createdAt: { S: auction.createdAt },
      },
    });
    expect(new Date(auction.createdAt).toISOString()).toBe(auction.createdAt);
  });
});