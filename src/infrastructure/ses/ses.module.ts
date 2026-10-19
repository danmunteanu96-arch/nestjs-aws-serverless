import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient } from '@aws-sdk/client-ses';

// Provides one shared SESClient built from validated config, mirroring
// DynamoDBModule: region comes from AWS_REGION, maxAttempts bounds retries.
@Module({
  providers: [
    {
      provide: SESClient,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): SESClient =>
        new SESClient({
          region: configService.getOrThrow<string>('AWS_REGION'),
          maxAttempts: 3,
        }),
    },
  ],
  exports: [SESClient],
})
export class SesModule {}
