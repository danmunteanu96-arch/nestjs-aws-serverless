import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { ConfigService } from '@nestjs/config';
import { AuctionsService } from './auctions.service';
import { AuctionImagesService } from './images/auction-images.service';
import { decodeAuctionCursor, encodeAuctionCursor } from './auction-cursor';

const item = {
  id: { S: 'auction-1' },
  title: { S: 'Camera' },
  status: { S: 'ACTIVE' },
  endDate: { S: '2030-01-01T00:00:00.000Z' },
  createdAt: { S: '2026-01-01T00:00:00.000Z' },
  currentBid: { N: '0' },
  createdBy: { S: 'owner-1' },
};
const images = {
  createReadUrl: jest
    .fn<(key: string) => Promise<string>>()
    .mockResolvedValue('signed-url'),
} as unknown as AuctionImagesService;
const serviceWith = (
  send: jest.Mock<(...args: unknown[]) => Promise<unknown>>,
) =>
  new AuctionsService(
    { send } as unknown as DynamoDBClient,
    new ConfigService({ AUCTIONS_TABLE: 'auctions' }),
    images,
  );

describe('auction pagination and ownership', () => {
  it('round-trips opaque cursors and rejects malformed or cross-filter cursors', () => {
    const key = {
      id: { S: 'auction-1' },
      status: { S: 'ACTIVE' },
      endDate: { S: '2030-01-01' },
    };
    const cursor = encodeAuctionCursor('ACTIVE', key);
    expect(decodeAuctionCursor(cursor, 'ACTIVE')).toEqual(key);
    expect(() => decodeAuctionCursor(cursor, 'CLOSED')).toThrow(
      BadRequestException,
    );
    expect(() => decodeAuctionCursor('not-base64-json', 'ACTIVE')).toThrow(
      BadRequestException,
    );
  });

  it('uses the v2 GSI, bounds results and returns a continuation cursor', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({
        Items: [item],
        LastEvaluatedKey: {
          id: { S: 'auction-1' },
          status: { S: 'ACTIVE' },
          endDate: { S: '2030-01-01' },
        },
      });
    const service = serviceWith(send);

    const page = await service.getAll({ status: 'ACTIVE', limit: 50 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const query = send.mock.calls[0][0] as QueryCommand;
    expect(query.input.IndexName).toBe('status-endDate-v2-index');
    expect(query.input.Limit).toBe(50);
  });

  it('enforces ownership atomically and maps wrong owner to 403', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'condition',
        }),
      )
      .mockResolvedValueOnce({ Item: item });
    const service = serviceWith(send);

    await expect(
      service.update('auction-1', { title: 'New title' }, 'other-user'),
    ).rejects.toThrow(ForbiddenException);
    const update = send.mock.calls[0][0] as UpdateItemCommand;
    expect(update.input.ConditionExpression).toContain('#createdBy = :ownerId');
    expect(update.input.ExpressionAttributeValues?.[':ownerId']).toEqual({
      S: 'other-user',
    });
  });

  it('keeps unknown auction IDs as 404 after a failed conditional update', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'condition',
        }),
      )
      .mockResolvedValueOnce({});
    const service = serviceWith(send);

    await expect(
      service.update('missing', { title: 'New title' }, 'other-user'),
    ).rejects.toThrow(NotFoundException);
  });
});
