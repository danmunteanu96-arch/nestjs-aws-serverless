import { InternalServerErrorException, Injectable } from '@nestjs/common';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
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

    await this.dynamoDb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          id: { S: auction.id },
          title: { S: auction.title },
          status: { S: auction.status },
          createdAt: { S: auction.createdAt },
        },
      }),
    );

    return auction;
  }
}