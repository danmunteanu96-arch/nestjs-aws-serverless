import { JsonLoggerService } from './json-logger.service';

// Non-HTTP handlers share the same JSON contract without entering Nest's interceptor pipeline.
export const lambdaLogger = new JsonLoggerService('auctions-worker');
