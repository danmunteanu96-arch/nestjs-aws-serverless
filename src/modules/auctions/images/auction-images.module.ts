import { Module } from '@nestjs/common';
import { S3Module } from '../../../infrastructure/s3/s3.module';
import { AuctionImagesService } from './auction-images.service';

@Module({
  imports: [S3Module],
  providers: [AuctionImagesService],
  // Exposes only the image use cases while keeping the S3 client ownership internal.
  exports: [AuctionImagesService],
})
export class AuctionImagesModule {}
