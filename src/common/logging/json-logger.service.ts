import type { LoggerService } from '@nestjs/common';
import { currentCorrelationId } from './correlation';

const sensitiveKey =
  /(authorization|cookie|password|secret|token|recipient|email|body)/i;

// Redaction happens before serialization so sensitive values never reach CloudWatch.
const sanitize = (value: unknown): unknown => {
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? '[REDACTED]' : sanitize(entry),
      ]),
    );
  }
  return value;
};

export class JsonLoggerService implements LoggerService {
  constructor(private readonly service = 'auctions-api') {}

  log(message: unknown, metadata: unknown = {}): void {
    this.write('INFO', message, metadata, process.stdout);
  }

  warn(message: unknown, metadata: unknown = {}): void {
    this.write('WARN', message, metadata, process.stderr);
  }

  error(message: unknown, metadata: unknown = {}): void {
    this.write('ERROR', message, metadata, process.stderr);
  }

  debug(message: unknown, metadata: unknown = {}): void {
    if (process.env.NODE_ENV !== 'production')
      this.write('DEBUG', message, metadata, process.stdout);
  }

  verbose(message: unknown, metadata: unknown = {}): void {
    this.debug(message, metadata);
  }

  private write(
    level: string,
    message: unknown,
    metadata: unknown,
    stream: NodeJS.WriteStream,
  ): void {
    // Nest passes a context string as the second argument; only plain objects are metadata.
    const details: Record<string, unknown> =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
    const entry = sanitize({
      level,
      service: this.service,
      timestamp: new Date().toISOString(),
      message: typeof message === 'string' ? message : 'Application event',
      ...details,
      correlationId: details.correlationId ?? currentCorrelationId(),
    });
    stream.write(`${JSON.stringify(entry)}\n`);
  }
}
