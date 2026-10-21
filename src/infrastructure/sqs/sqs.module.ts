import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';

// Provides one shared SQSClient built from validated config, mirroring
// SesModule/DynamoDBModule: region comes from AWS_REGION, maxAttempts bounds
// SDK-internal retries so a throttled call fails fast instead of hanging.
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
  ],
  exports: [SQSClient],
})
export class SqsModule {}
