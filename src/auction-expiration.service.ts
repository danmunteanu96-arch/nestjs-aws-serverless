import {
  AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AuctionExpirationService {
  private readonly logger = new Logger(AuctionExpirationService.name);

  constructor(private readonly dynamoDb: DynamoDBClient) {}

  async closeExpiredAuctions(now: Date = new Date()): Promise<number> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new Error('AUCTIONS_TABLE is not configured');
    }

    const expirationTime = { S: now.toISOString() };
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    let closedCount = 0;

    try {
      do {
        const result = await this.dynamoDb.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'status-endDate-index',
            KeyConditionExpression: '#status = :active AND #endDate <= :now',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#endDate': 'endDate',
            },
            ExpressionAttributeValues: {
              ':active': { S: 'ACTIVE' },
              ':now': expirationTime,
            },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        const auctions = result.Items ?? [];
        for (let index = 0; index < auctions.length; index += 10) {
          const batch = auctions.slice(index, index + 10);
          const results = await Promise.all(
            batch.map((auction) =>
              this.closeAuctionIfExpired(auction, tableName, expirationTime),
            ),
          );
          closedCount += results.filter(Boolean).length;
        }

        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to close expired auctions: ${errorMessage}`,
        errorStack,
      );
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
            ':active': { S: 'ACTIVE' },
            ':closed': { S: 'CLOSED' },
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
}