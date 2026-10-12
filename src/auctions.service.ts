import {
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import * as crypto from 'crypto';

export interface CreateAuctionInput {
  title: string;
  status: string;
}

export interface Auction extends CreateAuctionInput {
  id: string;
  createdAt: string;
}

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(private readonly dynamoDb: DynamoDBClient) {}

  async create(input: CreateAuctionInput): Promise<Auction> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException('AUCTIONS_TABLE is not configured');
    }

    const auction: Auction = {
      id: crypto.randomUUID(),
      title: input.title,
      status: input.status,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.dynamoDb.send(
        new PutItemCommand({
          TableName: tableName,
          Item: {
            id: { S: auction.id },
            entityType: { S: 'AUCTION' },
            title: { S: auction.title },
            status: { S: auction.status },
            createdAt: { S: auction.createdAt },
          },
        }),
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to save auction to DynamoDB: ${errorMessage}`, errorStack);
      throw new InternalServerErrorException('Failed to create auction');
    }

    return auction;
  }

  async getAll(): Promise<Auction[]> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException('AUCTIONS_TABLE is not configured');
    }

    const auctions: Auction[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    try {
      do {
        const result = await this.dynamoDb.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'all-auctions-index',
            KeyConditionExpression: '#entityType = :auction',
            ExpressionAttributeNames: {
              '#entityType': 'entityType',
            },
            ExpressionAttributeValues: {
              ':auction': { S: 'AUCTION' },
            },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        for (const item of result.Items ?? []) {
          const id = item.id?.S;
          const title = item.title?.S;
          const status = item.status?.S;
          const createdAt = item.createdAt?.S;

          if (!id || !title || !status || !createdAt) {
            throw new Error('Auction record is missing required attributes');
          }

          auctions.push({ id, title, status, createdAt });
        }

        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to retrieve auctions from DynamoDB: ${errorMessage}`, errorStack);
      throw new InternalServerErrorException('Failed to retrieve auctions');
    }

    return auctions;
  }

  async getById(id: string): Promise<Auction> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException('AUCTIONS_TABLE is not configured');
    }

    let item;
    try {
      const result = await this.dynamoDb.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            id: { S: id },
          },
        }),
      );
      item = result.Item;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to retrieve auction from DynamoDB: ${errorMessage}`, errorStack);
      throw new InternalServerErrorException('Failed to retrieve auction');
    }

    if (!item) {
      throw new NotFoundException(`Auction with id ${id} was not found`);
    }

    const auctionId = item.id?.S;
    const title = item.title?.S;
    const status = item.status?.S;
    const createdAt = item.createdAt?.S;

    if (!auctionId || !title || !status || !createdAt) {
      this.logger.error(`Auction ${id} is missing required attributes`);
      throw new InternalServerErrorException('Failed to retrieve auction');
    }

    return { id: auctionId, title, status, createdAt };
  }
}