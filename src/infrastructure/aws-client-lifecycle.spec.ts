import { describe, expect, it, jest } from '@jest/globals';
import { AwsClientLifecycle } from './aws-client-lifecycle';

// Idempotent cleanup prevents duplicate destroy calls when shutdown hooks are triggered repeatedly.
describe('AwsClientLifecycle', () => {
  it('destroys its owned AWS client at most once', () => {
    const client = { destroy: jest.fn() };
    const lifecycle = new AwsClientLifecycle(client);

    lifecycle.onModuleDestroy();
    lifecycle.onModuleDestroy();

    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
