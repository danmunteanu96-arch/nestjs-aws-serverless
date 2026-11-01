import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../config/configuration.module';
import { DynamoDBModule } from '../../infrastructure/dynamodb/dynamodb.module';
import { SesModule } from '../../infrastructure/ses/ses.module';
import { SqsModule } from '../../infrastructure/sqs/sqs.module';
import { NotificationIdempotencyService } from './notification-idempotency.service';
import { SesResilienceService } from './ses-resilience.service';
import { WinnerNotificationHandler } from './winner-notification.handler';
import { WinnerNotificationService } from './winner-notification.service';

@Module({
  imports: [ConfigurationModule, DynamoDBModule, SqsModule, SesModule],
  providers: [
    NotificationIdempotencyService,
    SesResilienceService,
    WinnerNotificationService,
    WinnerNotificationHandler,
  ],
})
export class NotificationsModule {}
