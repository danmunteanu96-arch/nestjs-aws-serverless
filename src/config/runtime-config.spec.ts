import { describe, expect, it, jest } from '@jest/globals';
import { loadRuntimeConfig } from './runtime-config';
import type { RuntimeEnvironment } from './runtime-config';

// Isolated environment objects keep tests deterministic and never read the developer's .env.
const productionEnvironment = (): RuntimeEnvironment => ({
  NODE_ENV: 'production',
  APP_FUNCTION: 'api' as const,
  AWS_REGION: 'eu-central-1',
  AUCTIONS_TABLE: 'auctions',
  AUCTION_IMAGES_BUCKET: 'images',
  WINNER_NOTIFICATIONS_QUEUE_URL:
    'https://sqs.eu-central-1.amazonaws.com/123/queue',
  EDGE_SHARED_SECRET_PARAMETER: '/prod/edge',
});

describe('runtime configuration', () => {
  it('resolves required SecureStrings before validating production configuration', async () => {
    const environment = productionEnvironment();
    const readSecret = jest
      .fn<(name: string) => Promise<string>>()
      .mockResolvedValue('a-long-random-edge-secret');

    await loadRuntimeConfig(environment, readSecret);

    expect(readSecret).toHaveBeenCalledWith('/prod/edge');
    expect(environment.EDGE_SHARED_SECRET).toBe('a-long-random-edge-secret');
  });

  it('fails closed when required configuration is malformed', async () => {
    const environment = { ...productionEnvironment(), AUCTIONS_TABLE: '' };

    const readSecret = jest
      .fn<(name: string) => Promise<string>>()
      .mockResolvedValue('a-long-random-edge-secret');
    await expect(loadRuntimeConfig(environment, readSecret)).rejects.toThrow(
      'Invalid runtime configuration: AUCTIONS_TABLE',
    );
  });

  it('preserves SSM failures without logging secret values', async () => {
    const environment = productionEnvironment();
    const readSecret = jest
      .fn<(name: string) => Promise<string>>()
      .mockRejectedValue(new Error('AccessDenied'));

    await expect(loadRuntimeConfig(environment, readSecret)).rejects.toThrow(
      'Unable to load runtime secrets',
    );
  });

  it('keeps useful defaults only in the test environment', async () => {
    const environment: RuntimeEnvironment = {
      NODE_ENV: 'test',
      APP_FUNCTION: 'api',
    };
    const readSecret = jest.fn<(name: string) => Promise<string>>();

    await expect(
      loadRuntimeConfig(environment, readSecret),
    ).resolves.toBeUndefined();
    expect(environment.AUCTIONS_TABLE).toBe('test-auctions');
  });
});
