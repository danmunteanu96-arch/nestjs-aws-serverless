import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { JsonLoggerService } from './common/logging/json-logger.service';
import { loadRuntimeConfig } from './config/runtime-config';
import type { WinnerNotificationHandler } from './modules/notifications/winner-notification.handler';

interface NotificationRuntime {
  context: INestApplicationContext;
  handler: WinnerNotificationHandler;
}

let runtime: Promise<NotificationRuntime> | undefined;

async function bootstrap(): Promise<NotificationRuntime> {
  // Read env/secrets before importing modules that validate configuration.
  await loadRuntimeConfig();
  const [{ NotificationsModule }, { WinnerNotificationHandler }] =
    await Promise.all([
      import('./modules/notifications/notifications.module.js'),
      import('./modules/notifications/winner-notification.handler.js'),
    ]);
  const context = await NestFactory.createApplicationContext(
    NotificationsModule,
    {
      logger: new JsonLoggerService('auctions-notifications'),
    },
  );
  // Queue consumers share warm clients until Nest receives the final shutdown signal.
  context.enableShutdownHooks();
  return { context, handler: context.get(WinnerNotificationHandler) };
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  // Reuse bootstrap and delegate per-record acknowledgement to the notification workflow.
  runtime ??= bootstrap();
  let current: NotificationRuntime;
  try {
    current = await runtime;
  } catch (error: unknown) {
    runtime = undefined;
    throw error;
  }

  return current.handler.handle(event);
}
