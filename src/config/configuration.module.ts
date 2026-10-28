import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    AWS_REGION: z.string().min(1).default('eu-central-1'),
    AUCTIONS_TABLE: z.string().min(1).optional(),
    AUCTION_IMAGES_BUCKET: z.string().min(1).optional(),
    SES_SENDER_EMAIL: z.string().default(''),
    WINNER_NOTIFICATIONS_QUEUE_URL: z.string().default(''),
    CORS_ORIGINS: z.string().default(''),
    API_DOCS_ENABLED: z.stringbool().optional(),
  })
  .passthrough()
  .transform((environment) => ({
    ...environment,
    API_DOCS_ENABLED:
      environment.API_DOCS_ENABLED ?? environment.NODE_ENV !== 'production',
    AUCTIONS_TABLE:
      environment.AUCTIONS_TABLE ??
      (environment.NODE_ENV === 'test' ? 'test-auctions' : undefined),
    AUCTION_IMAGES_BUCKET:
      environment.AUCTION_IMAGES_BUCKET ??
      (environment.NODE_ENV === 'test' ? 'test-auction-images' : undefined),
  }))
  .superRefine((environment, context) => {
    if (!environment.AUCTIONS_TABLE) {
      context.addIssue({
        code: 'custom',
        path: ['AUCTIONS_TABLE'],
        message: 'AUCTIONS_TABLE is required outside tests',
      });
    }
    if (!environment.AUCTION_IMAGES_BUCKET) {
      context.addIssue({
        code: 'custom',
        path: ['AUCTION_IMAGES_BUCKET'],
        message: 'AUCTION_IMAGES_BUCKET is required outside tests',
      });
    }
  });

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: environmentSchema,
    }),
  ],
  exports: [ConfigModule],
})
export class ConfigurationModule {}
