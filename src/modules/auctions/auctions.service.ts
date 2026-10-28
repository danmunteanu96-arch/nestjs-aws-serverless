import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { AuctionStatus } from './auctions.types';
import type { Auction, AuctionRecord } from './auctions.types';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { AuctionImagesService } from './images/auction-images.service';

@Injectable()
export class AuctionsService {
  private readonly logger = new Logger(AuctionsService.name);

  constructor(
    private readonly dynamoDb: DynamoDBClient,
    private readonly configService: ConfigService,
    private readonly auctionImages: AuctionImagesService,
  ) {}

  // Uploads first, then persists the key; a failed save triggers best-effort S3 compensation.
  async create(
    validInput: CreateAuctionDto,
    image: Express.Multer.File | undefined,
    createdBy: string,
  ): Promise<Auction> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');
    // Only expiration may close auctions, so every uploaded image has a cleanup path.
    if (validInput.status === AuctionStatus.CLOSED) {
      throw new BadRequestException(
        'Auctions must be created with ACTIVE status',
      );
    }
    const auctionId = crypto.randomUUID();
    const imageKey = await this.auctionImages.upload(auctionId, image);
    const auction: AuctionRecord = {
      id: auctionId,
      title: validInput.title,
      status: validInput.status,
      endDate: validInput.endDate,
      createdAt: new Date().toISOString(),
      currentBid: 0,
      createdBy,
      imageKey,
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
            createdBy: { S: createdBy },
            imageKey: { S: imageKey },
          },
        }),
      );
    } catch {
      try {
        await this.auctionImages.removeByAuctionId(auctionId);
      } catch {
        this.logger.error(
          `Failed to clean up image for auction ${auctionId} after creation failure`,
        );
      }
      this.logger.error('Failed to create auction in DynamoDB');
      throw new InternalServerErrorException('Failed to create auction');
    }

    return this.toAuctionResponse(auction);
  }

  async getAll(status?: AuctionStatus): Promise<Auction[]> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');

    const auctions: Auction[] = [];
    try {
      const statuses = status
        ? [status]
        : [AuctionStatus.ACTIVE, AuctionStatus.CLOSED];

      for (const queryStatus of statuses) {
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
                ':status': { S: queryStatus },
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
          );

          for (const item of result.Items ?? []) {
            auctions.push(await this.toAuction(item));
          }

          exclusiveStartKey = result.LastEvaluatedKey;
        } while (exclusiveStartKey);
      }

      if (status === undefined) {
        auctions.sort((first, second) =>
          first.createdAt.localeCompare(second.createdAt),
        );
      }
    } catch {
      this.logger.error('Failed to retrieve auctions from DynamoDB');
      throw new InternalServerErrorException('Failed to retrieve auctions');
    }

    return auctions;
  }

  async getActiveAuctions(): Promise<Auction[]> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');

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
              ':active': { S: AuctionStatus.ACTIVE },
            },
            ScanIndexForward: true,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );

        for (const item of result.Items ?? []) {
          auctions.push(await this.toAuction(item));
        }

        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    } catch {
      this.logger.error('Failed to retrieve active auctions from DynamoDB');
      throw new InternalServerErrorException(
        'Failed to retrieve active auctions',
      );
    }

    return auctions;
  }

  async getById(auctionId: string): Promise<Auction> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');
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
    } catch {
      this.logger.error('Failed to retrieve auction from DynamoDB');
      throw new InternalServerErrorException('Failed to retrieve auction');
    }

    if (!item) {
      throw new NotFoundException(`Auction with id ${auctionId} was not found`);
    }

    return this.toAuction(item);
  }

  async update(
    auctionId: string,
    validInput: UpdateAuctionDto,
  ): Promise<Auction> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');

    if (Object.keys(validInput).length === 0) {
      throw new BadRequestException(
        'Provide title, status, or endDate to update',
      );
    }
    // Prevent direct closes from bypassing expiration's image cleanup and notification flow.
    if (validInput.status === AuctionStatus.CLOSED) {
      throw new BadRequestException(
        'Auctions are closed automatically after their end date',
      );
    }

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

      this.logger.error('Failed to update auction in DynamoDB');
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

  async placeBid(
    auctionId: string,
    bid: PlaceBidDto,
    bidderId: string,
    bidderEmail?: string,
  ): Promise<Auction> {
    const tableName = this.configService.getOrThrow<string>('AUCTIONS_TABLE');

    // highestBidderEmail is stored only when the JWT carries an email claim;
    // it stays in DynamoDB for the expiration Lambda and is never mapped into
    // API responses (see toAuction) to avoid leaking bidder PII.
    const updates = ['#currentBid = :amount', '#highestBidderId = :bidderId'];
    const expressionAttributeNames: Record<string, string> = {
      '#id': 'id',
      '#status': 'status',
      '#currentBid': 'currentBid',
      '#highestBidderId': 'highestBidderId',
      '#createdBy': 'createdBy',
      '#bidders': 'bidders',
    };
    const expressionAttributeValues: Record<string, AttributeValue> = {
      ':active': { S: 'ACTIVE' },
      ':amount': { N: String(bid.amount) },
      ':bidderId': { S: bidderId },
      ':emptyList': { L: [] },
      ':newBidder': { L: [{ S: bidderId }] },
    };
    if (bidderEmail) {
      updates.push('#highestBidderEmail = :bidderEmail');
      expressionAttributeNames['#highestBidderEmail'] = 'highestBidderEmail';
      expressionAttributeValues[':bidderEmail'] = { S: bidderEmail };
    }
    updates.push(
      '#bidders = list_append(if_not_exists(#bidders, :emptyList), :newBidder)',
    );

    try {
      const result = await this.dynamoDb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { id: { S: auctionId } },
          UpdateExpression: `SET ${updates.join(', ')}`,
          ConditionExpression:
            'attribute_exists(#id) AND #status = :active AND (attribute_not_exists(#currentBid) OR #currentBid < :amount) AND (attribute_not_exists(#createdBy) OR #createdBy <> :bidderId) AND (attribute_not_exists(#bidders) OR NOT contains(#bidders, :bidderId))',
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
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
        if (currentAuction.status !== AuctionStatus.ACTIVE) {
          throw new ConflictException(
            'Bids can only be placed on active auctions',
          );
        }
        if (currentAuction.createdBy === bidderId) {
          throw new ForbiddenException(
            'Auction creators cannot bid on their own auctions',
          );
        }
        if (currentAuction.bidders?.includes(bidderId)) {
          throw new ConflictException(
            'You have already placed a bid on this auction',
          );
        }
        throw new ConflictException(
          `Bid amount must be greater than the current bid of ${currentAuction.currentBid}`,
        );
      }

      this.logger.error('Failed to place bid in DynamoDB');
      throw new InternalServerErrorException('Failed to place bid');
    }
  }

  // Converts DynamoDB attributes into an internal record before public response mapping.
  private async toAuction(
    item: Record<string, AttributeValue>,
  ): Promise<Auction> {
    const id = item.id?.S;
    const title = item.title?.S;
    const status = item.status?.S;
    const createdAt = item.createdAt?.S;
    const currentBid =
      item.currentBid?.N === undefined ? 0 : Number(item.currentBid.N);
    const highestBidderId = item.highestBidderId?.S;
    const createdBy = item.createdBy?.S;
    const bidders = item.bidders?.L?.map((bidder) => bidder.S).filter(
      (bidder): bidder is string => typeof bidder === 'string',
    );
    const endDate = item.endDate?.S;
    const imageKey = item.imageKey?.S;
    const isValidStatus =
      status === AuctionStatus.ACTIVE || status === AuctionStatus.CLOSED;

    if (
      !id ||
      !title ||
      !isValidStatus ||
      !createdAt ||
      !Number.isFinite(currentBid) ||
      currentBid < 0
    ) {
      this.logger.error(
        'Auction record is missing or has invalid required attributes',
      );
      throw new InternalServerErrorException('Failed to read auction data');
    }

    return this.toAuctionResponse({
      id,
      title,
      status,
      createdAt,
      ...(endDate ? { endDate } : {}),
      currentBid,
      ...(highestBidderId ? { highestBidderId } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(bidders && bidders.length > 0 ? { bidders } : {}),
      ...(imageKey ? { imageKey } : {}),
    });
  }

  // Removes persistence-only keys and signs images only while their auction is active.
  private async toAuctionResponse(record: AuctionRecord): Promise<Auction> {
    const { imageKey, ...auction } = record;
    if (record.status !== AuctionStatus.ACTIVE || !imageKey) {
      return auction;
    }

    return {
      ...auction,
      imageUrl: await this.auctionImages.createReadUrl(imageKey),
    };
  }
}
