import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export class CircuitOpenError extends Error {
  constructor() {
    super('SES circuit is open');
    this.name = CircuitOpenError.name;
  }
}

const TRANSIENT_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'InternalServerError',
  'NetworkingError',
  'TimeoutError',
  'ECONNRESET',
  'ETIMEDOUT',
]);

// One policy owns SES timeouts, retries, jitter, and the warm-process circuit breaker.
@Injectable()
export class SesResilienceService {
  private readonly logger = new Logger(SesResilienceService.name);
  private consecutiveTransientFailures = 0;
  private circuitOpenedAt = 0;

  constructor(
    private readonly ses: SESClient,
    private readonly configService: ConfigService,
  ) {}

  async send(command: SendEmailCommand): Promise<void> {
    const now = Date.now();
    const cooldownMs = this.numberConfig(
      'SES_CIRCUIT_COOLDOWN_MS',
      30_000,
      60_000,
    );
    if (this.circuitOpenedAt > 0 && now - this.circuitOpenedAt < cooldownMs) {
      throw new CircuitOpenError();
    }

    const maxAttempts = this.numberConfig('SES_RETRY_MAX_ATTEMPTS', 3, 5);
    const baseDelayMs = this.numberConfig(
      'SES_RETRY_BASE_MS',
      100,
      1_000,
      true,
    );
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.sendWithTimeout(command);
        this.consecutiveTransientFailures = 0;
        this.circuitOpenedAt = 0;
        return;
      } catch (error: unknown) {
        lastError = error;
        if (!isTransient(error)) throw error;
        if (attempt < maxAttempts) {
          const exponentialDelay = Math.min(
            baseDelayMs * 2 ** (attempt - 1),
            2_000,
          );
          const jitter = Math.floor(Math.random() * Math.max(baseDelayMs, 1));
          await delay(exponentialDelay + jitter);
        }
      }
    }

    this.recordTransientFailure();
    throw lastError;
  }

  // AbortController bounds each SDK attempt; the timer is always cleared after settlement.
  private async sendWithTimeout(command: SendEmailCommand): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.numberConfig('SES_TIMEOUT_MS', 5_000, 30_000);
    const timeout = setTimeout(() => {
      controller.abort(new Error(`SES request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    try {
      await this.ses.send(command, { abortSignal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  // The breaker counts only consecutive transient outages, not permanent recipient rejections.
  private recordTransientFailure(): void {
    this.consecutiveTransientFailures += 1;
    const threshold = this.numberConfig('SES_CIRCUIT_FAILURE_THRESHOLD', 3, 10);
    if (this.consecutiveTransientFailures >= threshold) {
      this.circuitOpenedAt = Date.now();
      this.consecutiveTransientFailures = 0;
      this.logger.warn('SES circuit opened after transient failures');
    }
  }

  private numberConfig(
    name: string,
    fallback: number,
    maximum: number,
    allowZero = false,
  ): number {
    const configured = Number(
      this.configService.get<string>(name, String(fallback)),
    );
    const minimum = allowZero ? 0 : 1;
    return Number.isFinite(configured)
      ? Math.min(maximum, Math.max(minimum, Math.floor(configured)))
      : fallback;
  }
}

// Only throttling, server, and network faults are retryable; recipient/config errors are permanent.
function isTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    TRANSIENT_ERROR_NAMES.has(error.name) ||
    error.message.includes('timed out')
  )
    return true;
  const status = (error as Error & { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode;
  return status !== undefined && status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
}
