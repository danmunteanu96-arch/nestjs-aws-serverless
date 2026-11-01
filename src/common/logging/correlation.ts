import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const correlationStorage = new AsyncLocalStorage<string>();
const safeCorrelationId = /^[A-Za-z0-9._:-]{1,128}$/;

// Untrusted IDs cannot inject lines or unbounded content into structured logs.
export const correlationIdFor = (candidate?: string): string =>
  candidate && safeCorrelationId.test(candidate) ? candidate : randomUUID();

export const currentCorrelationId = (): string =>
  correlationStorage.getStore() ?? 'uncorrelated';

export function runWithCorrelationId<T>(
  candidate: string | undefined,
  operation: () => T,
): T {
  return correlationStorage.run(correlationIdFor(candidate), operation);
}
