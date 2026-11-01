import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { EventBridgeEvent } from 'aws-lambda';
import { runWithCorrelationId } from './common/logging/correlation';
import { JsonLoggerService } from './common/logging/json-logger.service';
import { loadRuntimeConfig } from './config/runtime-config';
import type { AuctionExpirationService } from './modules/auctions/expiration/auction-expiration.service';

interface ExpirationRuntime {
  context: INestApplicationContext;
  service: AuctionExpirationService;
}

let runtime: Promise<ExpirationRuntime> | undefined;

async function bootstrap(): Promise<ExpirationRuntime> {
  // Read env/secrets before importing modules that validate configuration.
  await loadRuntimeConfig();
  const [{ AuctionExpirationModule }, { AuctionExpirationService }] =
    await Promise.all([
      import('./modules/auctions/expiration/auction-expiration.module.js'),
      import('./modules/auctions/expiration/auction-expiration.service.js'),
    ]);
  const context = await NestFactory.createApplicationContext(
    AuctionExpirationModule,
    {
      logger: new JsonLoggerService('auctions-expiration'),
    },
  );
  // Scheduled execution environments close shared clients only during final SIGTERM cleanup.
  context.enableShutdownHooks();
  return { context, service: context.get(AuctionExpirationService) };
}

export async function handler(
  event: EventBridgeEvent<string, unknown>,
): Promise<void> {
  return runWithCorrelationId(event.id, async () => {
    // Reuse the Nest context and AWS connections across scheduled warm invocations.
    runtime ??= bootstrap();
    let current: ExpirationRuntime;
    try {
      current = await runtime;
    } catch (error: unknown) {
      runtime = undefined;
      throw error;
    }

    await current.service.closeExpiredAuctions();
  });
}
