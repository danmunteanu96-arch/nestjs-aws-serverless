import {
  AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuctionStatus } from '../auctions.types';

@Injectable()
export class AuctionExpirationService {
  private readonly logger = new Logger(AuctionExpirationService.name);

  constructor(
    private readonly dynamoDb: DynamoDBClient,
    private readonly configService: ConfigService,
    private readonly ses: SESClient,
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
                await this.notifyWinner(auction);
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

// Sends the "you won" email to the address captured at bid time.
  // Best-effort by design: a failed email must never fail or retry the close
  // itself, so SES errors are logged and swallowed. Auctions with no bids have
  // no highestBidderEmail and are skipped.
  private async notifyWinner(
    auction: Record<string, AttributeValue>,
  ): Promise<void> {
    const recipient = auction.highestBidderEmail?.S;
    if (!recipient) {
      return;
    }

    const sender = this.configService.get<string>('SES_SENDER_EMAIL');
    if (!sender) {
      this.logger.warn(
        'SES_SENDER_EMAIL is not configured; skipping winner notification',
      );
      return;
    }

    const auctionId = auction.id?.S;
    const title = auction.title?.S ?? 'your auction';
    const amount = auction.currentBid?.N;
    const winningBid = amount ? ` with a winning bid of ${amount}` : '';

    // Multipart body: HTML for humans, plain-text fallback for screen readers,
    // strict clients, and spam-score. The title is user input — escape it
    // before embedding in HTML or it becomes an injection vector.
    const safeTitle = escapeHtml(title);
    const text = `Congratulations! You won "${title}"${winningBid}.`;
    const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background-color:#ffffff;">
      <div style="background-color:#1a1a2e;color:#ffffff;padding:24px;text-align:center;">
        <h1 style="margin:0;font-size:22px;">Serverless Auctions</h1>
      </div>
      <div style="padding:24px;color:#333333;font-size:15px;line-height:1.5;">
        <p style="margin:0 0 12px;">Congratulations!</p>
        <p style="margin:0;">You won <strong>&quot;${safeTitle}&quot;</strong>${escapeHtml(winningBid)}.</p>
      </div>
      <div style="padding:16px;text-align:center;color:#888888;font-size:12px;">
        You received this email because you placed the winning bid.
      </div>
    </div>
  </body>
</html>`;

    try {
      await this.ses.send(
        new SendEmailCommand({
          Source: sender,
          Destination: { ToAddresses: [recipient] },
          Message: {
            Subject: { Data: `You won the auction: ${title}` },
            Body: {
              Text: { Data: text },
              Html: { Data: html },
            },
          },
        }),
      );
      this.logger.log(`Winner notification sent for auction ${auctionId}`);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to send winner notification for auction ${auctionId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

// Minimal HTML escaping for user-controlled strings embedded in email markup.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
