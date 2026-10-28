import { Module } from '@nestjs/common';
import { AuctionExpirationService } from './auction-expiration.service';
import { ConfigurationModule } from '../../../config/configuration.module';
import { DynamoDBModule } from '../../../infrastructure/dynamodb/dynamodb.module';
import { SqsModule } from '../../../infrastructure/sqs/sqs.module';
import { AuctionImagesModule } from '../images/auction-images.module';

@Module({
  imports: [
    ConfigurationModule,
    DynamoDBModule,
    SqsModule,
    AuctionImagesModule,
  ],
  providers: [AuctionExpirationService],
})
export class AuctionExpirationModule {}
