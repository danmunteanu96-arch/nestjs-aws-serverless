import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { DynamoDBModule } from './dynamodb.module';

@Module({
  imports: [DynamoDBModule],
  controllers: [AppController, AuctionsController],
  providers: [AppService, AuctionsService],
})
export class AppModule {}
