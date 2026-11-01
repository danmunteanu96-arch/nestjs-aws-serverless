import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { NotificationIdempotencyService } from './notification-idempotency.service';

// DynamoDB rejects an UpdateExpression whose #placeholder is not declared in
// ExpressionAttributeNames; mocked clients do not catch that. Validate it here.
function expectEveryExpressionNameIsDefined(command: UpdateItemCommand): void {
  const input = command.input;
  const names = input.ExpressionAttributeNames ?? {};
  const expressions = [
    input.UpdateExpression ?? '',
    input.ConditionExpression ?? '',
  ];
  const placeholders = new Set(
    expressions.flatMap((expression) =>
      [...expression.matchAll(/#[A-Za-z0-9_]+/g)].map((match) => match[0]),
    ),
  );
  for (const placeholder of placeholders) {
    expect(names).toHaveProperty(placeholder);
  }
}

// These tests prove that only the worker owning a lease can finish or release it.
describe('NotificationIdempotencyService', () => {
  const config = new ConfigService({
    NOTIFICATION_IDEMPOTENCY_TABLE: 'notification-claims',
  });

  it('claims a new notification with an owned expiring lease', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new NotificationIdempotencyService(
      { send } as unknown as DynamoDBClient,
      config,
    );

    await expect(service.claim('auction-1', 'token-1')).resolves.toBe(
      'claimed',
    );

    const command = send.mock.calls[0][0] as PutItemCommand;
    expect(command.input).toMatchObject({
      TableName: 'notification-claims',
      Item: {
        auctionId: { S: 'auction-1' },
        status: { S: 'IN_PROGRESS' },
        claimToken: { S: 'token-1' },
      },
      ConditionExpression:
        'attribute_not_exists(#auctionId) OR (#status = :inProgress AND #leaseExpiresAt < :now)',
    });
    expect(Number(command.input.Item?.leaseExpiresAt.N)).toBeGreaterThan(
      Date.now() / 1000,
    );
    expect(Number(command.input.Item?.expiresAt.N)).toBeGreaterThan(
      Date.now() / 1000,
    );
  });

  it('ignores only a completed duplicate', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          message: 'exists',
          $metadata: {},
        }),
      )
      .mockResolvedValueOnce({ Item: { status: { S: 'COMPLETED' } } });
    const service = new NotificationIdempotencyService(
      { send } as unknown as DynamoDBClient,
      config,
    );

    await expect(service.claim('auction-1', 'token-2')).resolves.toBe(
      'duplicate',
    );
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetItemCommand);
  });

  it('reports an active claim as busy instead of completed', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          message: 'leased',
          $metadata: {},
        }),
      )
      .mockResolvedValueOnce({
        Item: {
          status: { S: 'IN_PROGRESS' },
          leaseExpiresAt: { N: '9999999999' },
        },
      });
    const service = new NotificationIdempotencyService(
      { send } as unknown as DynamoDBClient,
      config,
    );

    await expect(service.claim('auction-1', 'token-2')).resolves.toBe('busy');
  });

  it('completes and releases only the matching claim token', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new NotificationIdempotencyService(
      { send } as unknown as DynamoDBClient,
      config,
    );

    await service.complete('auction-1', 'token-1');
    await service.release('auction-1', 'token-1');

    const complete = send.mock.calls[0][0] as UpdateItemCommand;
    expect(complete.input).toMatchObject({
      ConditionExpression:
        '#status = :inProgress AND #claimToken = :claimToken',
      ExpressionAttributeValues: expect.objectContaining({
        ':claimToken': { S: 'token-1' },
        ':completed': { S: 'COMPLETED' },
      }),
    });
    expectEveryExpressionNameIsDefined(complete);
    const release = send.mock.calls[1][0] as UpdateItemCommand;
    expect(release.input.ConditionExpression).toBe(
      '#status = :inProgress AND #claimToken = :claimToken',
    );
    expectEveryExpressionNameIsDefined(release);
  });
});
