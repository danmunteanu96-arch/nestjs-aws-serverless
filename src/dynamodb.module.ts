import { Module } from '@nestjs/common';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

@Module({
  providers: [
    {
      provide: DynamoDBClient,
      useFactory: () =>
        new DynamoDBClient({
          region: process.env.AWS_REGION ?? 'eu-central-1',
        }),
    },
  ],
  exports: [DynamoDBClient],
})
export class DynamoDBModule {}