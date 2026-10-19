import { Module } from '@nestjs/common';
import { AuctionExpirationService } from './auction-expiration.service';
import { ConfigurationModule } from '../../../config/configuration.module';
import { DynamoDBModule } from '../../../infrastructure/dynamodb/dynamodb.module';
import { SesModule } from '../../../infrastructure/ses/ses.module';

@Module({
  imports: [ConfigurationModule, DynamoDBModule, SesModule],
  providers: [AuctionExpirationService],
})
export class AuctionExpirationModule {}
