import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { recordBusinessMetric } from '../../common/logging/metrics';
import { runWithCorrelationId } from '../../common/logging/correlation';
import { NotificationIdempotencyService } from './notification-idempotency.service';
import { parseWinnerNotificationPayload } from './winner-notification.types';
import { WinnerNotificationService } from './winner-notification.service';

// Independent record processing prevents one poison message from retrying an entire SQS batch.
@Injectable()
export class WinnerNotificationHandler {
  private readonly logger = new Logger(WinnerNotificationHandler.name);

  constructor(
    private readonly notifications: WinnerNotificationService,
    private readonly idempotency: NotificationIdempotencyService,
    private readonly sqs: SQSClient,
    private readonly configService: ConfigService,
  ) {}

  async handle(event: SQSEvent): Promise<SQSBatchResponse> {
    const results = await Promise.all(
      event.Records.map((record) =>
        runWithCorrelationId(record.messageId, () =>
          this.processRecord(record),
        ),
      ),
    );
    return {
      batchItemFailures: results.flatMap((itemIdentifier) =>
        itemIdentifier ? [{ itemIdentifier }] : [],
      ),
    };
  }

  // A null result acknowledges the record; a message ID asks SQS to retry only that record.
  private async processRecord(record: SQSRecord): Promise<string | undefined> {
    let payload;
    try {
      payload = parseWinnerNotificationPayload(record.body);
    } catch {
      await this.recordMetric('WinnerNotificationMalformed');
      return (await this.sendToDlq(record)) ? undefined : record.messageId;
    }

    const claimToken = randomUUID();
    let claim;
    try {
      claim = await this.idempotency.claim(payload.auctionId, claimToken);
    } catch (error: unknown) {
      this.logger.error('Failed to claim winner notification', {
        auctionId: payload.auctionId,
        error,
      });
      return record.messageId;
    }

    if (claim === 'duplicate') {
      await this.recordMetric('WinnerNotificationDuplicate');
      return undefined;
    }
    if (claim === 'busy') {
      this.logger.log('Winner notification is already leased', {
        auctionId: payload.auctionId,
      });
      return undefined;
    }

    try {
      await this.notifications.sendWinnerEmail(payload);
      await this.idempotency.complete(payload.auctionId, claimToken);
      await this.recordMetric('WinnerNotificationSent');
      return undefined;
    } catch (error: unknown) {
      this.logger.error(
        'Winner notification failed; attempting manual DLQ fallback',
        {
          auctionId: payload.auctionId,
          errorName: safeErrorName(error),
        },
      );
      const deliveredToDlq = await this.sendToDlq(record);
      await this.releaseClaim(payload.auctionId, claimToken);
      if (deliveredToDlq) {
        await this.recordMetric('WinnerNotificationManualDlq');
        return undefined;
      }
      return record.messageId;
    }
  }

  // Manual fallback preserves the original opaque body and acknowledges only after DLQ acceptance.
  private async sendToDlq(record: SQSRecord): Promise<boolean> {
    const queueUrl = this.configService.get<string>(
      'WINNER_NOTIFICATIONS_DLQ_URL',
    );
    if (!queueUrl) return false;
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: record.body,
        }),
      );
      return true;
    } catch (error: unknown) {
      this.logger.error('Failed to deliver winner notification to manual DLQ', {
        errorName: safeErrorName(error),
      });
      return false;
    }
  }

  // Release is best-effort after DLQ acceptance; an unreleased lease still expires automatically.
  private async releaseClaim(
    auctionId: string,
    claimToken: string,
  ): Promise<void> {
    try {
      await this.idempotency.release(auctionId, claimToken);
    } catch (error: unknown) {
      this.logger.error(
        'Failed to release notification claim; lease will expire',
        {
          auctionId,
          errorName: safeErrorName(error),
        },
      );
    }
  }

  // Metrics are observational and must never change message acknowledgement semantics.
  private async recordMetric(name: string): Promise<void> {
    try {
      await recordBusinessMetric(name);
    } catch (error: unknown) {
      this.logger.warn('Failed to publish notification metric', {
        errorName: safeErrorName(error),
      });
    }
  }
}

// Error messages can contain recipient identities, so logs retain only the safe error class.
function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
