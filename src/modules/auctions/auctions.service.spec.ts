import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuctionsService } from './auctions.service';
import { AuctionStatus } from './auctions.types';

describe('AuctionsService', () => {
  const dynamoDb = {
    send: jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({}),
  };
  const service = new AuctionsService(
    dynamoDb as unknown as DynamoDBClient,
    new ConfigService({ AUCTIONS_TABLE: 'test-auctions' }),
  );
  beforeEach(() => {
    dynamoDb.send.mockClear();
  });

  it('persists a new auction and returns it', async () => {
    const auction = await service.create({
      title: 'Vintage camera',
      status: 'ACTIVE',
      endDate: '2026-10-20T10:00:00.000Z',
    });

    expect(dynamoDb.send).toHaveBeenCalledWith(expect.any(PutItemCommand));
    const command = dynamoDb.send.mock.calls[0][0] as PutItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'test-auctions',
      Item: {
        id: { S: auction.id },
        entityType: { S: 'AUCTION' },
        title: { S: 'Vintage camera' },
        status: { S: 'ACTIVE' },
        endDate: { S: '2026-10-20T10:00:00.000Z' },
        createdAt: { S: auction.createdAt },
        currentBid: { N: '0' },
      },
    });
    expect(new Date(auction.createdAt).toISOString()).toBe(auction.createdAt);
    expect(auction.currentBid).toBe(0);
    expect(auction.endDate).toBe('2026-10-20T10:00:00.000Z');
  });

  it('queries active auctions by ending date', async () => {
    dynamoDb.send.mockResolvedValueOnce({
      Items: [
        {
          id: { S: 'auction-1' },
          title: { S: 'Vintage camera' },
          status: { S: 'ACTIVE' },
          endDate: { S: '2026-10-20T10:00:00.000Z' },
          createdAt: { S: '2026-10-10T12:00:00.000Z' },
          currentBid: { N: '25' },
        },
      ],
    });

    await expect(service.getActiveAuctions()).resolves.toEqual([
      {
        id: 'auction-1',
        title: 'Vintage camera',
        status: 'ACTIVE',
        endDate: '2026-10-20T10:00:00.000Z',
        createdAt: '2026-10-10T12:00:00.000Z',
        currentBid: 25,
      },
    ]);

    const command = dynamoDb.send.mock.calls[0][0] as QueryCommand;
    expect(command.input).toMatchObject({
      TableName: 'test-auctions',
      IndexName: 'status-endDate-index',
      KeyConditionExpression: '#status = :active',
      ExpressionAttributeValues: { ':active': { S: 'ACTIVE' } },
      ScanIndexForward: true,
    });
  });

  it('queries only the requested status', async () => {
    dynamoDb.send.mockResolvedValueOnce({
      Items: [
        {
          id: { S: 'auction-closed' },
          title: { S: 'Old radio' },
          status: { S: 'CLOSED' },
          endDate: { S: '2026-10-20T10:00:00.000Z' },
          createdAt: { S: '2026-10-10T12:00:00.000Z' },
          currentBid: { N: '25' },
        },
      ],
    });

    await expect(service.getAll(AuctionStatus.CLOSED)).resolves.toMatchObject([
      { id: 'auction-closed', status: AuctionStatus.CLOSED },
    ]);

    expect(dynamoDb.send).toHaveBeenCalledTimes(1);
    const command = dynamoDb.send.mock.calls[0][0] as QueryCommand;
    expect(command.input).toMatchObject({
      IndexName: 'status-endDate-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeValues: { ':status': { S: AuctionStatus.CLOSED } },
    });
  });

  it('queries every page of the all-auctions index', async () => {
    const firstAuction = {
      id: { S: 'auction-1' },
      title: { S: 'Vintage camera' },
      status: { S: 'ACTIVE' },
      endDate: { S: '2026-10-20T10:00:00.000Z' },
      createdAt: { S: '2026-10-10T12:00:00.000Z' },
      currentBid: { N: '25' },
    };
    const secondAuction = {
      id: { S: 'auction-2' },
      title: { S: 'Old radio' },
      status: { S: 'CLOSED' },
      endDate: { S: '2026-10-21T10:00:00.000Z' },
      createdAt: { S: '2026-10-11T12:00:00.000Z' },
      currentBid: { N: '50' },
      highestBidderId: { S: 'bidder-2' },
    };
    const lastEvaluatedKey = {
      status: { S: 'ACTIVE' },
      endDate: { S: firstAuction.endDate.S },
      id: { S: firstAuction.id.S },
    };
    dynamoDb.send
      .mockResolvedValueOnce({
        Items: [firstAuction],
        LastEvaluatedKey: lastEvaluatedKey,
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [secondAuction] });

    await expect(service.getAll()).resolves.toEqual([
      {
        id: 'auction-1',
        title: 'Vintage camera',
        status: 'ACTIVE',
        endDate: '2026-10-20T10:00:00.000Z',
        createdAt: '2026-10-10T12:00:00.000Z',
        currentBid: 25,
      },
      {
        id: 'auction-2',
        title: 'Old radio',
        status: 'CLOSED',
        endDate: '2026-10-21T10:00:00.000Z',
        createdAt: '2026-10-11T12:00:00.000Z',
        currentBid: 50,
        highestBidderId: 'bidder-2',
      },
    ]);

    expect(dynamoDb.send).toHaveBeenCalledTimes(3);
    expect(dynamoDb.send).toHaveBeenNthCalledWith(1, expect.any(QueryCommand));
    expect(dynamoDb.send).toHaveBeenNthCalledWith(2, expect.any(QueryCommand));
    expect(dynamoDb.send).toHaveBeenNthCalledWith(3, expect.any(QueryCommand));
    const secondQuery = dynamoDb.send.mock.calls[1][0] as QueryCommand;
    expect(secondQuery.input).toMatchObject({
      TableName: 'test-auctions',
      IndexName: 'status-endDate-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeValues: { ':status': { S: 'ACTIVE' } },
      ExclusiveStartKey: lastEvaluatedKey,
    });
    const closedAuctionsQuery = dynamoDb.send.mock.calls[2][0] as QueryCommand;
    expect(closedAuctionsQuery.input).toMatchObject({
      IndexName: 'status-endDate-index',
      ExpressionAttributeValues: { ':status': { S: 'CLOSED' } },
    });
  });

  it('gets an auction by its table key', async () => {
    dynamoDb.send.mockResolvedValueOnce({
      Item: {
        id: { S: 'auction-1' },
        title: { S: 'Vintage camera' },
        status: { S: 'ACTIVE' },
        endDate: { S: '2026-10-20T10:00:00.000Z' },
        createdAt: { S: '2026-10-10T12:00:00.000Z' },
        currentBid: { N: '25' },
      },
    });

    await expect(service.getById('auction-1')).resolves.toEqual({
      id: 'auction-1',
      title: 'Vintage camera',
      status: 'ACTIVE',
      endDate: '2026-10-20T10:00:00.000Z',
      createdAt: '2026-10-10T12:00:00.000Z',
      currentBid: 25,
    });

    expect(dynamoDb.send).toHaveBeenCalledWith(expect.any(GetItemCommand));
    const command = dynamoDb.send.mock.calls[0][0] as GetItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'test-auctions',
      Key: { id: { S: 'auction-1' } },
    });
  });

  it('throws not found when the auction does not exist', async () => {
    dynamoDb.send.mockResolvedValueOnce({});

    await expect(service.getById('missing-auction')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('updates only the supplied fields and preserves the other auction attributes', async () => {
    dynamoDb.send.mockResolvedValueOnce({
      Attributes: {
        id: { S: 'auction-1' },
        entityType: { S: 'AUCTION' },
        title: { S: 'Updated camera' },
        status: { S: 'ACTIVE' },
        createdAt: { S: '2026-10-10T12:00:00.000Z' },
        currentBid: { N: '25' },
      },
    });

    await expect(
      service.update('auction-1', { title: 'Updated camera' }),
    ).resolves.toEqual({
      id: 'auction-1',
      title: 'Updated camera',
      status: 'ACTIVE',
      createdAt: '2026-10-10T12:00:00.000Z',
      currentBid: 25,
    });

    expect(dynamoDb.send).toHaveBeenCalledWith(expect.any(UpdateItemCommand));
    const command = dynamoDb.send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'test-auctions',
      Key: { id: { S: 'auction-1' } },
      UpdateExpression: 'SET #title = :title',
      ConditionExpression: 'attribute_exists(#id)',
      ExpressionAttributeValues: { ':title': { S: 'Updated camera' } },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('places a higher bid atomically on an active auction', async () => {
    dynamoDb.send.mockResolvedValueOnce({
      Attributes: {
        id: { S: 'auction-1' },
        title: { S: 'Vintage camera' },
        status: { S: 'ACTIVE' },
        createdAt: { S: '2026-10-10T12:00:00.000Z' },
        currentBid: { N: '40' },
        highestBidderId: { S: 'bidder-1' },
      },
    });

    await expect(
      service.placeBid('auction-1', { bidderId: 'bidder-1', amount: 40 }),
    ).resolves.toEqual({
      id: 'auction-1',
      title: 'Vintage camera',
      status: 'ACTIVE',
      createdAt: '2026-10-10T12:00:00.000Z',
      currentBid: 40,
      highestBidderId: 'bidder-1',
    });

    expect(dynamoDb.send).toHaveBeenCalledWith(expect.any(UpdateItemCommand));
    const command = dynamoDb.send.mock.calls[0][0] as UpdateItemCommand;
    expect(command.input).toMatchObject({
      Key: { id: { S: 'auction-1' } },
      ConditionExpression:
        'attribute_exists(#id) AND #status = :active AND (attribute_not_exists(#currentBid) OR #currentBid < :amount)',
      ExpressionAttributeValues: {
        ':active': { S: 'ACTIVE' },
        ':amount': { N: '40' },
        ':bidderId': { S: 'bidder-1' },
      },
    });
  });

  it('rejects a bid that does not beat the current bid', async () => {
    const conditionalError = new Error('Condition failed');
    conditionalError.name = 'ConditionalCheckFailedException';
    dynamoDb.send
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({
        Item: {
          id: { S: 'auction-1' },
          title: { S: 'Vintage camera' },
          status: { S: 'ACTIVE' },
          createdAt: { S: '2026-10-10T12:00:00.000Z' },
          currentBid: { N: '40' },
        },
      });

    await expect(
      service.placeBid('auction-1', { bidderId: 'bidder-2', amount: 39 }),
    ).rejects.toThrow(ConflictException);
  });

  it('returns not found when placing a bid on a missing auction', async () => {
    const conditionalError = new Error('Condition failed');
    conditionalError.name = 'ConditionalCheckFailedException';
    dynamoDb.send
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({});

    await expect(
      service.placeBid('missing-auction', {
        bidderId: 'bidder-1',
        amount: 10,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects empty updates without calling DynamoDB', async () => {
    await expect(service.update('auction-1', {})).rejects.toThrow(
      BadRequestException,
    );
    expect(dynamoDb.send).not.toHaveBeenCalled();
  });

  it('returns not found instead of creating a missing auction', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    dynamoDb.send.mockRejectedValueOnce(error);

    await expect(
      service.update('missing-auction', { status: 'CLOSED' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('logs DynamoDB errors and throws a safe server error', async () => {
    dynamoDb.send.mockRejectedValueOnce(
      new Error('AccessDeniedException: sensitive detail'),
    );

    await expect(
      service.create({
        title: 'Vintage camera',
        status: 'ACTIVE',
        endDate: '2026-10-20T10:00:00.000Z',
      }),
    ).rejects.toThrow('Failed to create auction');
  });
});
