import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';
import { AWS_CLIENT, AwsClientLifecycle } from '../aws-client-lifecycle';

// Provides one shared SQSClient with bounded SDK retries and idempotent shutdown cleanup.
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): SQSClient =>
        new SQSClient({
          region: configService.getOrThrow<string>('AWS_REGION'),
          maxAttempts: 3,
        }),
    },
    { provide: AWS_CLIENT, useExisting: SQSClient },
    AwsClientLifecycle,
  ],
  exports: [SQSClient],
})
export class SqsModule {}
