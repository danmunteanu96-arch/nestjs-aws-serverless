import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('stateful infrastructure contract', () => {
  it('defines a dedicated infrastructure stack with durable DynamoDB settings', () => {
    expect(existsSync('infra.yml')).toBe(true);
    const stack = read('infra.yml');
    const auctions = read('resources/AuctionTableResource.yml');
    const idempotency = read(
      'resources/NotificationIdempotencyTableResource.yml',
    );

    expect(stack).toContain('service: nestjs-aws-serverless-infra');
    expect(auctions).toContain('BillingMode: PAY_PER_REQUEST');
    expect(auctions).toContain(
      'PointInTimeRecoveryEnabled: ${strToBool(${self:custom.pitrEnabled})}',
    );
    expect(auctions).toContain('AttributeName: expiresAt');
    expect(auctions).toContain('AttributeName: notificationStatus');
    expect(auctions).toContain('DeletionPolicy: Retain');
    expect(idempotency).toContain('AttributeName: auctionId');
    expect(idempotency).toContain('BillingMode: PAY_PER_REQUEST');
  });

  it('enables TTL and keeps PITR opt-in for cost-safe production', () => {
    const stack = read('infra.yml');
    const auctions = read('resources/AuctionTableResource.yml');
    const idempotency = read(
      'resources/NotificationIdempotencyTableResource.yml',
    );

    expect(stack).toContain(
      "pitrEnabled: ${strToBool(${env:DYNAMODB_PITR_ENABLED, '${param:pitrEnabled}'})}",
    );
    expect(stack).toContain('prod:');
    // No stage enables a billable backup by default; full production opts in.
    expect(stack).toContain('pitrEnabled: false');
    expect(stack).toContain('DYNAMODB_PITR_ENABLED');
    expect(auctions).toContain('TimeToLiveSpecification:');
    expect(auctions).toContain('AttributeName: expiresAt');
    expect(auctions).toContain('Enabled: true');
    expect(idempotency).toContain('AttributeName: expiresAt');
  });

  it('makes the customer-managed Lambda key opt-in for cost-safe deployments', () => {
    // The course profile must not create billable KMS resources by default.
    const stack = read('infra.yml');
    const security = read('resources/SecurityResource.yml');

    expect(stack).toContain(
      "lambdaCmkEnabled: ${strToBool(${env:LAMBDA_CMK_ENABLED, 'false'})}",
    );
    expect(stack).toContain(
      "UseLambdaCmk: !Equals ['${self:custom.lambdaCmkEnabled}', true]",
    );
    expect(stack).toMatch(
      /LambdaKmsArnParameter:\r?\n\s+Condition: UseLambdaCmk/,
    );
    // Count YAML property lines, not explanatory comments that mention the name.
    expect(security.match(/^\s+Condition: UseLambdaCmk$/gm)).toHaveLength(2);
  });

  it('protects queues and configures Cognito for production', () => {
    const queues = read('resources/WinnerNotificationsQueueResource.yml');
    const cognito = read('resources/CognitoAuthResource.yml');

    expect(queues).toContain('AuctionExpirationDLQ:');
    expect(queues).toContain('SqsManagedSseEnabled: true');
    expect(queues).toContain('maxReceiveCount: 3');
    expect(queues).toContain('MessageRetentionPeriod: 1209600');
    expect(cognito).toContain("MfaConfiguration: 'OPTIONAL'");
    // CloudFormation enables TOTP through EnabledMfas, not the SDK property names.
    expect(cognito).toMatch(/EnabledMfas:\r?\n\s+- SOFTWARE_TOKEN_MFA/);
    expect(cognito).not.toContain('EnabledMfaMethods:');
    expect(cognito).not.toContain('SoftwareTokenMfaConfiguration:');
    expect(cognito).toContain('MinimumLength: 12');
    expect(cognito).toContain('TemporaryPasswordValidityDays: 7');
    expect(cognito).toContain('GenerateSecret: false');
    expect(cognito).toContain('AccessTokenValidity: 1');
    expect(cognito).toContain('IdTokenValidity: 1');
    expect(cognito).toContain('RefreshTokenValidity: 30');
  });

  it('publishes cross-stack references and rotates the Lambda KMS key', () => {
    const stack = read('infra.yml');
    const security = read('resources/SecurityResource.yml');
    const observability = read('resources/ObservabilityResource.yml');

    for (const reference of [
      'auctions/table-name',
      'auctions/table-arn',
      'images/bucket-name',
      'winner-notifications/queue-url',
      'winner-notifications/queue-arn',
      'auction-expiration/dlq-url',
      'auction-expiration/dlq-arn',
      'cognito/user-pool-id',
      'cognito/client-id',
      'cognito/issuer-url',
      'security/lambda-kms-key-arn',
      'alerts/topic-arn',
    ]) {
      expect(stack).toContain(reference);
    }
    expect(security).toContain('EnableKeyRotation: true');
    expect(observability).toContain('AWS::SNS::Topic');
    expect(observability).toContain('OpsAlertsTopicPolicy:');
    expect(observability).toContain('Service: cloudwatch.amazonaws.com');
    expect(observability).toContain('sns:Publish');
    expect(observability).toContain('AWS:SourceAccount');
    expect(observability).toContain('AWS::Budgets::Budget');
    expect(observability).toContain('AWS::CE::AnomalyMonitor');
  });

  it('reuses an existing account-level cost anomaly monitor', () => {
    // AWS permits one dimensional service monitor per account, so stacks must share it.
    const stack = read('infra.yml');
    const observability = read('resources/ObservabilityResource.yml');

    expect(stack).toContain('HasExistingCostAnomalyMonitor:');
    expect(stack).toContain('CreateCostAnomalyMonitor:');
    expect(stack).toContain('COST_ANOMALY_MONITOR_ARN');
    expect(observability).toContain('Condition: CreateCostAnomalyMonitor');
    expect(observability).toContain('Fn::If: [HasExistingCostAnomalyMonitor');
  });

  it('stores secrets only through the SecureString setup script', () => {
    const script = read('scripts/configure-secrets.sh');
    const stack = read('infra.yml');

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain(': "${SES_SENDER_EMAIL:?');
    expect(script).toContain(': "${EDGE_SHARED_SECRET:?');
    expect(script).toContain('--type SecureString --overwrite');
    expect(stack).not.toContain('SES_SENDER_EMAIL: ${env:');
    expect(stack).not.toContain('EDGE_SHARED_SECRET: ${env:');
    expect(stack).not.toMatch(/[^\s]+@[^\s]+\.(com|net|org)/);
  });

  it('requires explicit disposable Cognito test credentials', () => {
    const script = read('scripts/create-cognito-test-user.sh');

    expect(script).toContain(
      'STACK_NAME="${STACK_NAME:-nestjs-aws-serverless-infra-dev}"',
    );
    expect(script).toContain(
      'USERNAME="${1:?Provide a disposable test email as argument 1}"',
    );
    // Prefer the environment variable so the password is not in shell history.
    expect(script).toContain('PASSWORD="${2:-${TEST_USER_PASSWORD:-}}"');
    expect(script).toContain('TEST_USER_PASSWORD');
    expect(script).not.toContain('Test1234!');
    expect(script).not.toContain('testuser@example.com');
  });
});
