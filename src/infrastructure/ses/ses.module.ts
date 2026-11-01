import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient } from '@aws-sdk/client-ses';
import { AWS_CLIENT, AwsClientLifecycle } from '../aws-client-lifecycle';

// Application-level resilience owns SES retries; Nest owns the shared client's shutdown.
@Module({
  providers: [
    {
      provide: SESClient,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): SESClient =>
        new SESClient({
          region: configService.getOrThrow<string>('AWS_REGION'),
          maxAttempts: 1,
        }),
    },
    { provide: AWS_CLIENT, useExisting: SESClient },
    AwsClientLifecycle,
  ],
  exports: [SESClient],
})
export class SesModule {}
