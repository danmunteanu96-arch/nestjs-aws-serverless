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

@Injectable()
export class AuctionExpirationService {
  private readonly logger = new Logger(AuctionExpirationService.name);

  constructor(
    private readonly dynamoDb: DynamoDBClient,
    private readonly configService: ConfigService,
    private readonly sqs: SQSClient,
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
                expirationTime,
              );
              if (closed) {
                await this.enqueueWinnerNotification(auction);
              }
              return closed;
            }),
          );
          closedCount += results.filter(Boolean).length;
        }

        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
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
    expirationTime: AttributeValue,
  ): Promise<boolean> {
    const id = auction.id?.S;
    if (!id) {
      return false;
    }

    try {
      await this.dynamoDb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { id: { S: id } },
          UpdateExpression: 'SET #status = :closed',
          ConditionExpression:
            'attribute_exists(#id) AND #status = :active AND #endDate <= :now',
          ExpressionAttributeNames: {
            '#id': 'id',
            '#status': 'status',
            '#endDate': 'endDate',
          },
          ExpressionAttributeValues: {
            ':active': { S: AuctionStatus.ACTIVE },
            ':closed': { S: AuctionStatus.CLOSED },
            ':now': expirationTime,
          },
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

  // Hands the "you won" email to SQS instead of sending it inline: the queue
  // gives the downstream consumer automatic retries and a DLQ, and keeps the
  // slow/unreliable email call out of the critical close path. Best-effort on
  // this side by design — a failed enqueue must never fail the close itself,
  // so SQS errors are logged and swallowed. Auctions with no bids have no
  // highestBidderEmail and are skipped.
  private async enqueueWinnerNotification(
    auction: Record<string, AttributeValue>,
  ): Promise<void> {
    const recipient = auction.highestBidderEmail?.S;
    if (!recipient) {
      return;
    }

    const queueUrl = this.configService.get<string>(
      'WINNER_NOTIFICATIONS_QUEUE_URL',
    );
    if (!queueUrl) {
      this.logger.warn(
        'WINNER_NOTIFICATIONS_QUEUE_URL is not configured; skipping winner notification',
      );
      return;
    }

    const auctionId = auction.id?.S;
    const messageBody = JSON.stringify({
      auctionId,
      recipient,
      title: auction.title?.S ?? 'your auction',
      winningBid: auction.currentBid?.N,
    });

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: messageBody,
        }),
      );
      this.logger.log(`Winner notification enqueued for auction ${auctionId}`);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to enqueue winner notification for auction ${auctionId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
