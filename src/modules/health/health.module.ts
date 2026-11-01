import { Module } from '@nestjs/common';
import { DynamoDBModule } from '../../infrastructure/dynamodb/dynamodb.module';
import { SqsModule } from '../../infrastructure/sqs/sqs.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DynamoDBModule, SqsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
