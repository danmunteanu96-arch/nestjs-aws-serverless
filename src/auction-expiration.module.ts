import { Module } from '@nestjs/common';
import { AuctionExpirationService } from './auction-expiration.service';
import { DynamoDBModule } from './dynamodb.module';

@Module({
  imports: [DynamoDBModule],
  providers: [AuctionExpirationService],
})
export class AuctionExpirationModule {}