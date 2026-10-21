import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../config/configuration.module';
import { SesModule } from '../../infrastructure/ses/ses.module';
import { WinnerNotificationService } from './winner-notification.service';

@Module({
  imports: [ConfigurationModule, SesModule],
  providers: [WinnerNotificationService],
})
export class NotificationsModule {}
