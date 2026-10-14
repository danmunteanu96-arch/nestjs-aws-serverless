import { Module } from '@nestjs/common';
import { AuctionExpirationService } from './auction-expiration.service';
import { ConfigurationModule } from '../../../config/configuration.module';
import { DynamoDBModule } from '../../../infrastructure/dynamodb/dynamodb.module';

@Module({
  imports: [ConfigurationModule, DynamoDBModule],
  providers: [AuctionExpirationService],
})
export class AuctionExpirationModule {}
