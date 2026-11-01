import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, jest } from '@jest/globals';
import { HealthService } from './health.service';

const config = new ConfigService({
  AUCTIONS_TABLE: 'test-auctions',
  WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
  HEALTH_CHECK_TIMEOUT_MS: '100',
});

// AWS calls are mocked at the SDK boundary; health aggregation and timeout behavior stay real.
describe('HealthService', () => {
  it('reports healthy only after DynamoDB and SQS both succeed', async () => {
    const dynamoSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const sqsSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new HealthService(
      { send: dynamoSend } as unknown as DynamoDBClient,
      { send: sqsSend } as unknown as SQSClient,
      config,
    );

    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      checks: { dynamodb: 'up', sqs: 'up' },
    });
    expect(dynamoSend.mock.calls[0][0]).toBeInstanceOf(DescribeTableCommand);
    expect(sqsSend.mock.calls[0][0]).toBeInstanceOf(GetQueueAttributesCommand);
    expect(
      (dynamoSend.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal,
    ).toBeInstanceOf(AbortSignal);
    expect(
      (sqsSend.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal,
    ).toBeInstanceOf(AbortSignal);
  });

  it('maps either dependency failure to a safe per-check 503 response', async () => {
    const service = new HealthService(
      {
        send: jest
          .fn<(...args: unknown[]) => Promise<unknown>>()
          .mockRejectedValue(new Error('provider internals')),
      } as unknown as DynamoDBClient,
      {
        send: jest
          .fn<(...args: unknown[]) => Promise<unknown>>()
          .mockResolvedValue({}),
      } as unknown as SQSClient,
      config,
    );

    const failure = await service.check().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toEqual({
      status: 'error',
      checks: { dynamodb: 'down', sqs: 'up' },
    });
    expect(
      JSON.stringify((failure as ServiceUnavailableException).getResponse()),
    ).not.toContain('provider internals');
  });

  it('aborts an unresponsive dependency and returns 503 within the bounded timeout', async () => {
    const dynamoSend = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation(
        (_command, options) =>
          new Promise((_resolve, reject) => {
            const signal = (options as { abortSignal: AbortSignal })
              .abortSignal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      );
    const service = new HealthService(
      { send: dynamoSend } as unknown as DynamoDBClient,
      {
        send: jest
          .fn<(...args: unknown[]) => Promise<unknown>>()
          .mockResolvedValue({}),
      } as unknown as SQSClient,
      new ConfigService({
        AUCTIONS_TABLE: 'test-auctions',
        WINNER_NOTIFICATIONS_QUEUE_URL: 'https://sqs.test/queue',
        HEALTH_CHECK_TIMEOUT_MS: '5',
      }),
    );

    await expect(service.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const options = dynamoSend.mock.calls[0][1] as { abortSignal: AbortSignal };
    expect(options.abortSignal.aborted).toBe(true);
  });
});
