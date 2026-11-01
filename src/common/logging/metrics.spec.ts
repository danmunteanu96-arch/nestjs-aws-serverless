import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { recordBusinessMetric } from './metrics';

describe('business metrics', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('publishes a single EMF counter without business identifiers as dimensions', async () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await recordBusinessMetric('NotificationsEnqueued');

    const output = String(write.mock.calls.at(-1)?.[0]);
    const entry = JSON.parse(output) as {
      _aws: {
        CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][] }>;
      };
      NotificationsEnqueued: number;
    };
    expect(entry.NotificationsEnqueued).toBe(1);
    expect(entry._aws.CloudWatchMetrics[0].Namespace).toBe('Auctions');
    expect(entry._aws.CloudWatchMetrics[0].Dimensions).toEqual([['service']]);
  });
});
