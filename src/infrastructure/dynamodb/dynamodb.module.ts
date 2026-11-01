import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AWS_CLIENT, AwsClientLifecycle } from '../aws-client-lifecycle';

@Module({
  providers: [
    {
      provide: DynamoDBClient,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): DynamoDBClient =>
        new DynamoDBClient({
          region: configService.getOrThrow<string>('AWS_REGION'),
          maxAttempts: 3,
        }),
    },
    // Shutdown receives the same cached client used by feature services.
    { provide: AWS_CLIENT, useExisting: DynamoDBClient },
    AwsClientLifecycle,
  ],
  exports: [DynamoDBClient],
})
export class DynamoDBModule {}
