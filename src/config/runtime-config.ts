import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';

export type RuntimeEnvironment = Record<string, string | undefined>;
type SecretReader = (parameterName: string) => Promise<string>;

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    APP_FUNCTION: z
      .enum(['api', 'expiration', 'notification', 'local'])
      .default('local'),
    AWS_REGION: z.string().min(1).default('eu-central-1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    AUCTIONS_TABLE: z.string().min(1).optional(),
    AUCTION_IMAGES_BUCKET: z.string().min(1).optional(),
    WINNER_NOTIFICATIONS_QUEUE_URL: z.string().url().optional(),
    WINNER_NOTIFICATIONS_DLQ_URL: z.string().url().optional(),
    NOTIFICATION_IDEMPOTENCY_TABLE: z.string().min(1).optional(),
    SES_SENDER_EMAIL_PARAMETER: z.string().startsWith('/').optional(),
    EDGE_SHARED_SECRET_PARAMETER: z.string().startsWith('/').optional(),
    SES_SENDER_EMAIL: z.string().email().optional(),
    EDGE_SHARED_SECRET: z.string().min(24).optional(),
    CORS_ORIGINS: z.string().default('https://app.auctions.example.com'),
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
    if (environment.NODE_ENV === 'test') return;
    const requirements: Record<string, string[]> = {
      api: [
        'AUCTIONS_TABLE',
        'AUCTION_IMAGES_BUCKET',
        'WINNER_NOTIFICATIONS_QUEUE_URL',
        'EDGE_SHARED_SECRET',
      ],
      expiration: [
        'AUCTIONS_TABLE',
        'AUCTION_IMAGES_BUCKET',
        'WINNER_NOTIFICATIONS_QUEUE_URL',
      ],
      notification: [
        'NOTIFICATION_IDEMPOTENCY_TABLE',
        'WINNER_NOTIFICATIONS_DLQ_URL',
        'SES_SENDER_EMAIL',
      ],
      local: ['AUCTIONS_TABLE', 'AUCTION_IMAGES_BUCKET'],
    };
    for (const key of requirements[environment.APP_FUNCTION]) {
      if (!environment[key as keyof typeof environment]) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required for ${environment.APP_FUNCTION}`,
        });
      }
    }
  });

export const validateRuntimeConfig = (
  environment: RuntimeEnvironment,
): Record<string, unknown> => environmentSchema.parse(environment);

// One SSM client is reused across warm invocations; only named SecureStrings are fetched.
const ssm = new SSMClient({ maxAttempts: 3 });
const readSecureParameter: SecretReader = async (parameterName) => {
  const response = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  if (!response.Parameter?.Value) throw new Error('SSM parameter has no value');
  return response.Parameter.Value;
};

export async function loadRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
  readSecret: SecretReader = readSecureParameter,
): Promise<void> {
  const secretParameters = [
    ['SES_SENDER_EMAIL_PARAMETER', 'SES_SENDER_EMAIL'],
    ['EDGE_SHARED_SECRET_PARAMETER', 'EDGE_SHARED_SECRET'],
  ] as const;
  try {
    for (const [parameterKey, valueKey] of secretParameters) {
      const parameterName = environment[parameterKey];
      if (parameterName)
        environment[valueKey] = await readSecret(parameterName);
    }
  } catch (error) {
    throw new Error('Unable to load runtime secrets', { cause: error });
  }

  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const paths = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid runtime configuration: ${paths.join(', ')}`);
  }
  Object.assign(environment, result.data);
}
