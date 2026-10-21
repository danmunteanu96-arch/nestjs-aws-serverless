import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SQSEvent } from 'aws-lambda';
import { NotificationsModule } from './modules/notifications/notifications.module';
import {
  WinnerNotificationPayload,
  WinnerNotificationService,
} from './modules/notifications/winner-notification.service';

let applicationContext: Promise<INestApplicationContext> | undefined;

// SQS-triggered handler: each record is one "auction won" message. If any
// record throws, the whole invocation fails and SQS redelivers the batch
// (visibility timeout), eventually moving it to the DLQ — that retry loop is
// the reason this consumer exists. Sends are effectively idempotent here
// (worst case: a duplicate email after a redelivery).
export async function handler(event: SQSEvent): Promise<void> {
  applicationContext ??= NestFactory.createApplicationContext(
    NotificationsModule,
  );

  let context: INestApplicationContext;
  try {
    context = await applicationContext;
  } catch (error: unknown) {
    applicationContext = undefined;
    throw error;
  }

  const notificationService = context.get(WinnerNotificationService);
  for (const record of event.Records) {
    const payload = JSON.parse(record.body) as WinnerNotificationPayload;
    await notificationService.sendWinnerEmail(payload);
  }
}
