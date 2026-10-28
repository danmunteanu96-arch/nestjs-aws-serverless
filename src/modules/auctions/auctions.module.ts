import { Module } from '@nestjs/common';
import { DynamoDBModule } from '../../infrastructure/dynamodb/dynamodb.module';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { AuctionImagesModule } from './images/auction-images.module';

@Module({
  imports: [DynamoDBModule, AuctionImagesModule],
  controllers: [AuctionsController],
  providers: [AuctionsService],
})
export class AuctionsModule {}
