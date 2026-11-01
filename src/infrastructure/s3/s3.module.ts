import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AWS_CLIENT, AwsClientLifecycle } from '../aws-client-lifecycle';

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
    { provide: AWS_CLIENT, useExisting: S3Client },
    AwsClientLifecycle,
  ],
  exports: [S3Client],
})
export class S3Module {}
