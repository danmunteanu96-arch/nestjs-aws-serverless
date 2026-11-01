import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import {
  CircuitOpenError,
  SesResilienceService,
} from './ses-resilience.service';

const command = new SendEmailCommand({
  Source: 'sender@example.com',
  Destination: { ToAddresses: ['winner@example.com'] },
  Message: {
    Subject: { Data: 'Won' },
    Body: { Text: { Data: 'You won' } },
  },
});

// A zero retry delay keeps failure-path tests fast while preserving the real retry loop.
const config = (overrides: Record<string, string> = {}) =>
  new ConfigService({
    SES_RETRY_MAX_ATTEMPTS: '3',
    SES_RETRY_BASE_MS: '0',
    SES_TIMEOUT_MS: '1000',
    SES_CIRCUIT_FAILURE_THRESHOLD: '3',
    SES_CIRCUIT_COOLDOWN_MS: '30000',
    ...overrides,
  });

describe('SesResilienceService', () => {
  it('retries transient SES failures with one controlled policy', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('throttled'), { name: 'ThrottlingException' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), { name: 'ServiceUnavailable' }),
      )
      .mockResolvedValueOnce({});
    const service = new SesResilienceService(
      { send } as unknown as SESClient,
      config(),
    );

    await expect(service.send(command)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent SES rejections', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(
        Object.assign(new Error('rejected'), { name: 'MessageRejected' }),
      );
    const service = new SesResilienceService(
      { send } as unknown as SESClient,
      config(),
    );

    await expect(service.send(command)).rejects.toThrow('rejected');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('opens the warm-process circuit after consecutive transient failures', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(
        Object.assign(new Error('down'), { name: 'ServiceUnavailable' }),
      );
    const service = new SesResilienceService(
      { send } as unknown as SESClient,
      config({
        SES_RETRY_MAX_ATTEMPTS: '1',
        SES_CIRCUIT_FAILURE_THRESHOLD: '1',
      }),
    );

    await expect(service.send(command)).rejects.toThrow('down');
    await expect(service.send(command)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds an unresponsive SES attempt with an abort timeout', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation(
        (_command, options) =>
          new Promise((_resolve, reject) => {
            const signal = (options as { abortSignal?: AbortSignal })
              .abortSignal;
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      );
    const service = new SesResilienceService(
      { send } as unknown as SESClient,
      config({ SES_RETRY_MAX_ATTEMPTS: '1', SES_TIMEOUT_MS: '5' }),
    );

    await expect(service.send(command)).rejects.toThrow(
      'SES request timed out',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
