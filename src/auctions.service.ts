import {
  ConflictException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import * as crypto from 'crypto';
import type { Auction } from './auctions.types';
import { parseAuctionId, parseCreateAuctionInput, parsePlaceBidInput, parseUpdateAuctionInput } from './auctions.validation';


export type {
  Auction,
  CreateAuctionInput,
  PlaceBidInput,
} from './auctions.types';

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(private readonly dynamoDb: DynamoDBClient) {}

  async create(input: unknown): Promise<Auction> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException(
        'AUCTIONS_TABLE is not configured',
      );
    }

    const validInput = parseCreateAuctionInput(input);
    const auction: Auction = {
      id: crypto.randomUUID(),
      title: validInput.title,
      status: validInput.status,
      endDate: validInput.endDate,
      createdAt: new Date().toISOString(),
      currentBid: 0,
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
            endDate: { S: validInput.endDate },
            createdAt: { S: auction.createdAt },
            currentBid: { N: '0' },
          },
        }),
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to save auction to DynamoDB: ${errorMessage}`,
        errorStack,
      );
      throw new InternalServerErrorException('Failed to create auction');
    }

    return auction;
  }

  async getAll(): Promise<Auction[]> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException(
        'AUCTIONS_TABLE is not configured',
      );
    }

    const auctions: Auction[] = [];
    try {
      for (const status of ['ACTIVE', 'CLOSED'] as const) {
        let exclusiveStartKey: Record<string, AttributeValue> | undefined;

        do {
          const result = await this.dynamoDb.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: 'status-endDate-index',
              KeyConditionExpression: '#status = :status',
              ExpressionAttributeNames: {
                '#status': 'status',
              },
              ExpressionAttributeValues: {
                ':status': { S: status },
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );

          for (const item of result.Items ?? []) {
            auctions.push(this.toAuction(item));
          }

          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey);
      }

      auctions.sort((first, second) =>
        first.createdAt.localeCompare(second.createdAt),
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to retrieve auctions from DynamoDB: ${errorMessage}`,
        errorStack,
      );
      throw new InternalServerErrorException('Failed to retrieve auctions');
    }

    return auctions;
  }

  async getActiveAuctions(): Promise<Auction[]> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException(
        'AUCTIONS_TABLE is not configured',
      );
    }

    const auctions: Auction[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    try {
      do {
        const result = await this.dynamoDb.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: 'status-endDate-index',
            KeyConditionExpression: '#status = :active',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':active': { S: 'ACTIVE' },
            },
            ScanIndexForward: true,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        for (const item of result.Items ?? []) {
          auctions.push(this.toAuction(item));
        }

        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to retrieve active auctions from DynamoDB: ${errorMessage}`,
        errorStack,
      );
      throw new InternalServerErrorException(
        'Failed to retrieve active auctions',
      );
    }

    return auctions;
  }

  async getById(id: unknown): Promise<Auction> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException(
        'AUCTIONS_TABLE is not configured',
      );
    }

    const auctionId = parseAuctionId(id);
    let item;
    try {
      const result = await this.dynamoDb.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            id: { S: auctionId },
          },
        }),
      );
      item = result.Item;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to retrieve auction from DynamoDB: ${errorMessage}`,
        errorStack,
      );
      throw new InternalServerErrorException('Failed to retrieve auction');
    }

    if (!item) {
      throw new NotFoundException(`Auction with id ${auctionId} was not found`);
    }

    return this.toAuction(item);
  }

  async update(id: unknown, input: unknown): Promise<Auction> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException(
        'AUCTIONS_TABLE is not configured',
      );
    }

    const auctionId = parseAuctionId(id);
    const validInput = parseUpdateAuctionInput(input);

    const updates: string[] = [];
    const expressionAttributeNames: Record<string, string> = { '#id': 'id' };
    const expressionAttributeValues: Record<string, AttributeValue> = {};

    if (validInput.title !== undefined) {
      updates.push('#title = :title');
      expressionAttributeNames['#title'] = 'title';
      expressionAttributeValues[':title'] = { S: validInput.title };
    }

    if (validInput.status !== undefined) {
      updates.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = { S: validInput.status };
    }

    if (validInput.endDate !== undefined) {
      updates.push('#endDate = :endDate');
      expressionAttributeNames['#endDate'] = 'endDate';
      expressionAttributeValues[':endDate'] = { S: validInput.endDate };
    }

    let attributes;
    try {
      const result = await this.dynamoDb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: {
            id: { S: auctionId },
          },
          UpdateExpression: `SET ${updates.join(', ')}`,
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        }),
      );
      attributes = result.Attributes;
    } catch (error: unknown) {
      if (
        error instanceof ConditionalCheckFailedException ||
        (error instanceof Error &&
          error.name === 'ConditionalCheckFailedException')
      ) {
        throw new NotFoundException(
          `Auction with id ${auctionId} was not found`,
        );
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to update auction in DynamoDB: ${errorMessage}`,
        errorStack,
      );
      throw new InternalServerErrorException('Failed to update auction');
    }

    if (!attributes) {
      this.logger.error(
        `Updated auction ${auctionId} was not returned by DynamoDB`,
      );
      throw new InternalServerErrorException('Failed to update auction');
    }

    return this.toAuction(attributes);
  }

  async placeBid(id: unknown, input: unknown): Promise<Auction> {
    const tableName = process.env.AUCTIONS_TABLE;
    if (!tableName) {
      throw new InternalServerErrorException(
        'AUCTIONS_TABLE is not configured',
      );
    }

    const auctionId = parseAuctionId(id);
    const bid = parsePlaceBidInput(input);

    try {
      const result = await this.dynamoDb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { id: { S: auctionId } },
          UpdateExpression:
            'SET #currentBid = :amount, #highestBidderId = :bidderId',
          ConditionExpression:
            'attribute_exists(#id) AND #status = :active AND (attribute_not_exists(#currentBid) OR #currentBid < :amount)',
          ExpressionAttributeNames: {
            '#id': 'id',
            '#status': 'status',
            '#currentBid': 'currentBid',
            '#highestBidderId': 'highestBidderId',
          },
          ExpressionAttributeValues: {
            ':active': { S: 'ACTIVE' },
            ':amount': { N: String(bid.amount) },
            ':bidderId': { S: bid.bidderId },
          },
          ReturnValues: 'ALL_NEW',
        }),
      );

      if (!result.Attributes) {
        throw new InternalServerErrorException('Failed to place bid');
      }
      return this.toAuction(result.Attributes);
    } catch (error: unknown) {
      if (
        error instanceof ConditionalCheckFailedException ||
        (error instanceof Error &&
          error.name === 'ConditionalCheckFailedException')
      ) {
        const currentAuction = await this.getById(auctionId);
        if (currentAuction.status !== 'ACTIVE') {
          throw new ConflictException(
            'Bids can only be placed on active auctions',
          );
        }
        throw new ConflictException(
          `Bid amount must be greater than the current bid of ${currentAuction.currentBid}`,
        );
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to place bid in DynamoDB: ${errorMessage}`,
        errorStack,
      );
      throw new InternalServerErrorException('Failed to place bid');
    }
  }

  private toAuction(item: Record<string, AttributeValue>): Auction {
    const id = item.id?.S;
    const title = item.title?.S;
    const status = item.status?.S;
    const createdAt = item.createdAt?.S;
    const currentBid =
      item.currentBid?.N === undefined ? 0 : Number(item.currentBid.N);
    const highestBidderId = item.highestBidderId?.S;
  const endDate = item.endDate?.S;

    if (
      !id ||
      !title ||
      !status ||
      !createdAt ||
      !Number.isFinite(currentBid) ||
      currentBid < 0
    ) {
      this.logger.error(
        'Auction record is missing or has invalid required attributes',
      );
      throw new InternalServerErrorException('Failed to read auction data');
    }

    return {
      id,
      title,
      status: status as Auction['status'],
      createdAt,
      ...(endDate ? { endDate } : {}),
      currentBid,
      ...(highestBidderId ? { highestBidderId } : {}),
    };
  }
}
