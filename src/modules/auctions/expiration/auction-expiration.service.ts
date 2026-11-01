import {
  AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuctionStatus } from '../auctions.types';
import { AuctionImagesService } from '../images/auction-images.service';

@Injectable()
export class AuctionExpirationService {
  private readonly logger = new Logger(AuctionExpirationService.name);

  constructor(
    private readonly dynamoDb: DynamoDBClient,
    private readonly configService: ConfigService,
    private readonly sqs: SQSClient,
    private readonly auctionImages: AuctionImagesService,
  ) {}

  async closeExpiredAuctions(now: Date = new Date()): Promise<number> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');

    const expirationTime = { S: now.toISOString() };
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    let closedCount = 0;

    try {
      do {
        const result = await this.dynamoDb.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'status-endDate-v2-index',
            KeyConditionExpression: '#status = :active AND #endDate <= :now',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#endDate': 'endDate',
            },
            ExpressionAttributeValues: {
              ':active': { S: AuctionStatus.ACTIVE },
              ':now': expirationTime,
            },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        const auctions = result.Items ?? [];
        for (let index = 0; index < auctions.length; index += 10) {
          const batch = auctions.slice(index, index + 10);
          const results = await Promise.all(
            batch.map(async (auction) => {
              const closed = await this.closeAuctionIfExpired(
                auction,
                tableName,
                now,
              );
              if (closed) {
                const auctionId = auction.id?.S;
                if (auctionId) {
                  await this.removeAuctionImage(auctionId);
                }
                await this.enqueueWinnerNotification(auction, tableName);
              }
              return closed;
            }),
          );
          closedCount += results.filter(Boolean).length;
        }

        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);

      // Pending records survive producer failures and are retried by every later schedule.
      await this.retryPendingNotifications(tableName);
    } catch (error: unknown) {
      this.logger.error('Failed to close expired auctions');
      throw error;
    }

    this.logger.log(`Closed ${closedCount} expired auction(s).`);
    return closedCount;
  }

  private async closeAuctionIfExpired(
    auction: Record<string, AttributeValue>,
    tableName: string,
    now: Date,
  ): Promise<boolean> {
    const id = auction.id?.S;
    if (!id) {
      return false;
    }

    const hasWinner = Boolean(auction.highestBidderEmail?.S);
    const expressionAttributeNames: Record<string, string> = {
      '#id': 'id',
      '#status': 'status',
      '#endDate': 'endDate',
      '#imageKey': 'imageKey',
      '#expiresAt': 'expiresAt',
    };
    const expressionAttributeValues: Record<string, AttributeValue> = {
      ':active': { S: AuctionStatus.ACTIVE },
      ':closed': { S: AuctionStatus.CLOSED },
      ':now': { S: now.toISOString() },
      ':expiresAt': {
        N: String(Math.floor(now.getTime() / 1000) + 90 * 24 * 60 * 60),
      },
    };
    let updateExpression = 'SET #status = :closed, #expiresAt = :expiresAt';
    if (hasWinner) {
      // Sparse PENDING membership makes failed producer deliveries visible to the retry GSI.
      updateExpression += ', #notificationStatus = :pending';
      expressionAttributeNames['#notificationStatus'] = 'notificationStatus';
      expressionAttributeValues[':pending'] = { S: 'PENDING' };
    }
    updateExpression += ' REMOVE #imageKey';

    try {
      await this.dynamoDb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { id: { S: id } },
          UpdateExpression: updateExpression,
          ConditionExpression:
            'attribute_exists(#id) AND #status = :active AND #endDate <= :now',
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        }),
      );
      return true;
    } catch (error: unknown) {
      if (
        error instanceof ConditionalCheckFailedException ||
        (error instanceof Error &&
          error.name === 'ConditionalCheckFailedException')
      ) {
        return false;
      }
      throw error;
    }
  }

  // The sparse GSI contains only notifications still awaiting a successful SQS enqueue.
  private async retryPendingNotifications(tableName: string): Promise<void> {
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'notificationStatus-createdAt-index',
          KeyConditionExpression: '#notificationStatus = :pending',
          ExpressionAttributeNames: {
            '#notificationStatus': 'notificationStatus',
          },
          ExpressionAttributeValues: { ':pending': { S: 'PENDING' } },
          ExclusiveStartKey: exclusiveStartKey,
          Limit: 100,
        }),
      );
      const pending = result.Items ?? [];
      for (let index = 0; index < pending.length; index += 10) {
        await Promise.all(
          pending
            .slice(index, index + 10)
            .map((auction) =>
              this.enqueueWinnerNotification(auction, tableName),
            ),
        );
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  // Best-effort cleanup keeps a private orphan visible in logs without reversing the close.
  private async removeAuctionImage(auctionId: string): Promise<void> {
    try {
      await this.auctionImages.removeByAuctionId(auctionId);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to delete image for closed auction ${auctionId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  // SQS isolates SES from the close path; PENDING remains durable until enqueue succeeds.
  private async enqueueWinnerNotification(
    auction: Record<string, AttributeValue>,
    tableName: string,
  ): Promise<void> {
    const recipient = auction.highestBidderEmail?.S;
    const auctionId = auction.id?.S;
    if (!recipient || !auctionId) {
      return;
    }

    const queueUrl = this.configService.get<string>(
      'WINNER_NOTIFICATIONS_QUEUE_URL',
    );
    if (!queueUrl) {
      this.logger.warn(
        'Winner queue is not configured; notification remains pending',
        {
          auctionId,
        },
      );
      return;
    }

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            auctionId,
            recipient,
            title: auction.title?.S ?? 'your auction',
            winningBid: auction.currentBid?.N,
          }),
        }),
      );
      this.logger.log('Winner notification enqueued', { auctionId });
    } catch (error: unknown) {
      this.logger.error(
        'Failed to enqueue winner notification; it remains pending',
        {
          auctionId,
          error,
        },
      );
      return;
    }

    try {
      await this.markNotificationSent(auctionId, tableName);
    } catch (error: unknown) {
      // A later producer retry is safe because the consumer claims auctionId idempotently.
      this.logger.error('Failed to clear pending notification after enqueue', {
        auctionId,
        error,
      });
    }
  }

  // Removing the sparse attribute acknowledges enqueue without adding another GSI record.
  private async markNotificationSent(
    auctionId: string,
    tableName: string,
  ): Promise<void> {
    await this.dynamoDb.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { id: { S: auctionId } },
        UpdateExpression: 'REMOVE #notificationStatus',
        ExpressionAttributeNames: {
          '#notificationStatus': 'notificationStatus',
        },
      }),
    );
  }
}
