import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type DependencyStatus = 'up' | 'down';
type HealthReport = {
  status: 'ok' | 'error';
  checks: { dynamodb: DependencyStatus; sqs: DependencyStatus };
};

// Readiness checks real dependencies in parallel and exposes only safe per-check statuses.
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly dynamoDb: DynamoDBClient,
    private readonly sqs: SQSClient,
    private readonly configService: ConfigService,
  ) {}

  async check(): Promise<HealthReport> {
    const [dynamodb, sqs] = await Promise.all([
      this.checkDependency('dynamodb', (abortSignal) =>
        this.dynamoDb.send(
          new DescribeTableCommand({
            TableName: this.configService.getOrThrow<string>('AUCTIONS_TABLE'),
          }),
          { abortSignal },
        ),
      ),
      this.checkDependency('sqs', (abortSignal) =>
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.configService.getOrThrow<string>(
              'WINNER_NOTIFICATIONS_QUEUE_URL',
            ),
            AttributeNames: ['QueueArn'],
          }),
          { abortSignal },
        ),
      ),
    ]);
    const report: HealthReport = {
      status: dynamodb === 'up' && sqs === 'up' ? 'ok' : 'error',
      checks: { dynamodb, sqs },
    };
    if (report.status === 'error')
      throw new ServiceUnavailableException(report);
    return report;
  }

  // Each SDK call receives its own abort signal and a bounded, always-cleared timer.
  private async checkDependency(
    name: 'dynamodb' | 'sqs',
    operation: (abortSignal: AbortSignal) => Promise<unknown>,
  ): Promise<DependencyStatus> {
    const configuredTimeout = Number(
      this.configService.get<string>('HEALTH_CHECK_TIMEOUT_MS', '1000'),
    );
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(5_000, Math.max(1, Math.floor(configuredTimeout)))
      : 1_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`${name} health check timed out`));
    }, timeoutMs);
    timeout.unref();
    try {
      await operation(controller.signal);
      return 'up';
    } catch (error: unknown) {
      this.logger.warn('Dependency health check failed', {
        dependency: name,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return 'down';
    } finally {
      clearTimeout(timeout);
    }
  }
}
