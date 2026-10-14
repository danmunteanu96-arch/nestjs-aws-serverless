import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

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
  ],
  exports: [DynamoDBClient],
})
export class DynamoDBModule {}
