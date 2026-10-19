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
    SES_SENDER_EMAIL: z.string().default(''),
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
  }))
  .superRefine((environment, context) => {
    if (!environment.AUCTIONS_TABLE) {
      context.addIssue({
        code: 'custom',
        path: ['AUCTIONS_TABLE'],
        message: 'AUCTIONS_TABLE is required outside tests',
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
