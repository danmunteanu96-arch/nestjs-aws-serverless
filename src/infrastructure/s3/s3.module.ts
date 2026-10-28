import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Module({
  providers: [
    {
      provide: S3Client,
      inject: [ConfigService],
      // Creates one warm-start S3 client with bounded retries for all image operations.
      useFactory: (configService: ConfigService): S3Client =>
        new S3Client({
          region: configService.getOrThrow<string>('AWS_REGION'),
          maxAttempts: 3,
        }),
    },
  ],
  exports: [S3Client],
})
export class S3Module {}
