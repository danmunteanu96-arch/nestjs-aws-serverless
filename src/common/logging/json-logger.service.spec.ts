import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { LoggerService } from '@nestjs/common';
import { JsonLoggerService } from './json-logger.service';
import { correlationIdFor, runWithCorrelationId } from './correlation';

describe('structured Lambda logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits the fixed JSON shape with safe metadata and correlation', () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const logger = new JsonLoggerService('auctions-api');

    runWithCorrelationId('request-123', () => {
      logger.log('Winner notification enqueued', { auctionId: 'abc-123' });
    });

    const entry = JSON.parse(String(write.mock.calls[0][0])) as Record<
      string,
      unknown
    >;
    expect(entry).toEqual({
      level: 'INFO',
      service: 'auctions-api',
      timestamp: expect.any(String),
      message: 'Winner notification enqueued',
      auctionId: 'abc-123',
      correlationId: 'request-123',
    });
  });

  it('ignores Nest context strings instead of spreading them into JSON fields', () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const logger: LoggerService = new JsonLoggerService('auctions-api');

    logger.log('Route mapped', 'RoutesResolver');

    const entry = JSON.parse(String(write.mock.calls[0][0])) as Record<
      string,
      unknown
    >;
    expect(entry.message).toBe('Route mapped');
    expect(entry['0']).toBeUndefined();
  });

  it('redacts secret-like fields and serializes unexpected errors safely', () => {
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const logger = new JsonLoggerService('auctions-worker');

    logger.error('Notification failed', {
      recipient: 'person@example.com',
      authorization: 'Bearer token',
      error: new Error('SES unavailable'),
    });

    const entry = JSON.parse(String(write.mock.calls[0][0])) as Record<
      string,
      unknown
    >;
    expect(entry.level).toBe('ERROR');
    expect(entry.recipient).toBe('[REDACTED]');
    expect(entry.authorization).toBe('[REDACTED]');
    expect(entry.error).toEqual({ name: 'Error', message: 'SES unavailable' });
    expect(JSON.stringify(entry)).not.toContain('person@example.com');
  });

  it('accepts safe correlation IDs and replaces unsafe or oversized input', () => {
    expect(correlationIdFor('api:id_123')).toBe('api:id_123');
    expect(correlationIdFor('bad id\nforged-log')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(correlationIdFor(undefined)).not.toBe('uncorrelated');
  });
});
