import { Module } from '@nestjs/common';
import { DynamoDBModule } from '../../infrastructure/dynamodb/dynamodb.module';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';

@Module({
  imports: [DynamoDBModule],
  controllers: [AuctionsController],
  providers: [AuctionsService],
})
export class AuctionsModule {}
