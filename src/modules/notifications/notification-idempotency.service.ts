import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type NotificationClaim = 'claimed' | 'duplicate' | 'busy';

const LEASE_SECONDS = 60;
const CLAIM_RETENTION_SECONDS = 24 * 60 * 60;
const COMPLETED_RETENTION_SECONDS = 30 * 24 * 60 * 60;

// DynamoDB conditions provide atomic claims without assuming exactly-once SQS delivery.
@Injectable()
export class NotificationIdempotencyService {
  constructor(
    private readonly dynamoDb: DynamoDBClient,
    private readonly configService: ConfigService,
  ) {}

  // A caller supplies its unique token so only that worker can later complete or release the lease.
  async claim(
    auctionId: string,
    claimToken: string,
  ): Promise<NotificationClaim> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await this.dynamoDb.send(
        new PutItemCommand({
          TableName: this.tableName(),
          Item: {
            auctionId: { S: auctionId },
            status: { S: 'IN_PROGRESS' },
            claimToken: { S: claimToken },
            leaseExpiresAt: { N: String(now + LEASE_SECONDS) },
            expiresAt: { N: String(now + CLAIM_RETENTION_SECONDS) },
          },
          // New records and expired crashed leases may be claimed; completed records never may.
          ConditionExpression:
            'attribute_not_exists(#auctionId) OR (#status = :inProgress AND #leaseExpiresAt < :now)',
          ExpressionAttributeNames: {
            '#auctionId': 'auctionId',
            '#status': 'status',
            '#leaseExpiresAt': 'leaseExpiresAt',
          },
          ExpressionAttributeValues: {
            ':inProgress': { S: 'IN_PROGRESS' },
            ':now': { N: String(now) },
          },
        }),
      );
      return 'claimed';
    } catch (error: unknown) {
      if (!isConditionalFailure(error)) throw error;
      const result = await this.dynamoDb.send(
        new GetItemCommand({
          TableName: this.tableName(),
          Key: { auctionId: { S: auctionId } },
          ProjectionExpression: '#status',
          ExpressionAttributeNames: { '#status': 'status' },
          ConsistentRead: true,
        }),
      );
      return result.Item?.status.S === 'COMPLETED' ? 'duplicate' : 'busy';
    }
  }

  // Completion retains a tombstone for 30 days so late duplicates remain harmless.
  async complete(auctionId: string, claimToken: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.dynamoDb.send(
      new UpdateItemCommand({
        TableName: this.tableName(),
        Key: { auctionId: { S: auctionId } },
        UpdateExpression:
          'SET #status = :completed, #completedAt = :completedAt, #expiresAt = :expiresAt REMOVE #claimToken, #leaseExpiresAt',
        ConditionExpression:
          '#status = :inProgress AND #claimToken = :claimToken',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#claimToken': 'claimToken',
          '#completedAt': 'completedAt',
          '#expiresAt': 'expiresAt',
          '#leaseExpiresAt': 'leaseExpiresAt',
        },
        ExpressionAttributeValues: {
          ':inProgress': { S: 'IN_PROGRESS' },
          ':completed': { S: 'COMPLETED' },
          ':claimToken': { S: claimToken },
          ':completedAt': { N: String(now) },
          ':expiresAt': { N: String(now + COMPLETED_RETENTION_SECONDS) },
        },
      }),
    );
  }

  // Releasing expires the lease immediately, allowing a manual DLQ redrive or SQS retry to claim it.
  async release(auctionId: string, claimToken: string): Promise<void> {
    await this.dynamoDb.send(
      new UpdateItemCommand({
        TableName: this.tableName(),
        Key: { auctionId: { S: auctionId } },
        UpdateExpression: 'SET #leaseExpiresAt = :releasedAt',
        ConditionExpression:
          '#status = :inProgress AND #claimToken = :claimToken',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#claimToken': 'claimToken',
          '#leaseExpiresAt': 'leaseExpiresAt',
        },
        ExpressionAttributeValues: {
          ':inProgress': { S: 'IN_PROGRESS' },
          ':claimToken': { S: claimToken },
          ':releasedAt': { N: '0' },
        },
      }),
    );
  }

  private tableName(): string {
    return this.configService.getOrThrow<string>(
      'NOTIFICATION_IDEMPOTENCY_TABLE',
    );
  }
}

// SDK errors and plain test doubles expose the same stable conditional-failure name.
function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof ConditionalCheckFailedException ||
    (error instanceof Error && error.name === 'ConditionalCheckFailedException')
  );
}
