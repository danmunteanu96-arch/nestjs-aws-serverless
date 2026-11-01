import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('deployment stacks contract', () => {
  it('keeps regional compute separate from stateful and edge resources', () => {
    expect(existsSync('api.yml')).toBe(true);
    expect(existsSync('edge.yml')).toBe(true);
    expect(read('api.yml')).toContain('service: nestjs-aws-serverless-api');
    expect(read('api.yml')).toContain('region: eu-central-1');
    expect(read('edge.yml')).toContain('service: nestjs-aws-serverless-edge');
    expect(read('edge.yml')).toContain('region: us-east-1');
    expect(existsSync('serverless.yml')).toBe(false);
    expect(existsSync('iam/AuctionTableIAM.yml')).toBe(false);
  });

  it('configures API limits, authentication, encryption, and warm layers', () => {
    const api = read('api.yml');

    expect(api).toContain('HttpApiStage:');
    expect(api).toContain('DefaultRouteSettings:');
    expect(api).toContain('ThrottlingRateLimit: 100');
    expect(api).toContain('ThrottlingBurstLimit: 200');
    expect(api).not.toContain('rateLimit: 100');
    expect(api).not.toContain('burstLimit: 200');
    expect(api).toContain('allowCredentials: true');
    // API Gateway uses one explicit YAML origin; Serverless 4 has no split resolver.
    expect(api).toMatch(
      /allowedOrigins:\r?\n\s+- \$\{env:CORS_ORIGIN, 'https:\/\/app\.auctions\.example\.com'\}/,
    );
    expect(api).not.toContain('${split(');
    expect(api).toContain("CORS_ORIGINS, 'https://app.auctions.example.com'");
    expect(api).toContain('cognito/issuer-url');
    expect(api).toContain('cognito/client-id');
    // Lambda uses the AWS-owned key unless a customer-managed key ARN is explicitly supplied.
    expect(api).toContain('KmsKeyArn: !If [UseLambdaCmk,');
    expect(api).toContain("${env:LAMBDA_KMS_KEY_ARN, ''}");
    expect(api).toContain(
      "UseLambdaCmk: !Equals ['${self:custom.lambdaCmkEnabled}', true]",
    );
    expect(api).not.toContain(
      'kmsKeyArn: ${ssm:/nestjs-aws-serverless/${sls:stage}/security/lambda-kms-key-arn}',
    );
    expect(api).toContain('logRetentionInDays: 7');
    expect(api).toContain('architecture: arm64');
    expect(api).toContain('CommonLambdaLayer');
    expect(api).toContain('memorySize: 512');
    // Accounts at the minimum concurrency quota cannot reserve any executions.
    expect(api).toContain(
      "reservedConcurrencyEnabled: ${strToBool(${env:LAMBDA_RESERVED_CONCURRENCY_ENABLED, 'false'})}",
    );
    expect(api).toContain(
      'ReservedConcurrentExecutions: !If [UseReservedConcurrency, 1, !Ref AWS::NoValue]',
    );
    expect(api).not.toContain('reservedConcurrency: 1');
    expect(api).toContain('functionResponseType: ReportBatchItemFailures');
    expect(api).not.toContain('functionResponseTypes:');
    expect(api).toContain('batchSize: 10');
    expect(api).toContain('DeadLetterConfig:');
    expect(api).toContain('auction-expiration/dlq-arn');
    expect(api).toContain(
      '{{resolve:ssm:/nestjs-aws-serverless/${sls:stage}/auction-expiration/dlq-url:1}}',
    );
    expect(api).not.toContain(
      '{{resolve:ssm:/nestjs-aws-serverless/${sls:stage}/winner-notifications/dlq-url:1}}',
    );
    expect(api).toContain('/nestjs-aws-serverless/${sls:stage}/api/id');
  });

  it('uses least-privilege function roles and runtime secret names', () => {
    const apiRole = read('iam/ApiRole.yml');
    const expirationRole = read('iam/ExpirationRole.yml');
    const notificationRole = read('iam/WinnerNotificationRole.yml');
    const api = read('api.yml');

    expect(apiRole).toContain('dynamodb:DescribeTable');
    // Unfiltered auction pages require bounded Scan access to the exact table ARN.
    expect(apiRole).toContain('dynamodb:Scan');
    expect(apiRole).toContain('sqs:GetQueueAttributes');
    expect(apiRole).toContain('/secrets/edge-shared-secret');
    expect(apiRole).not.toContain('/secrets/ses-sender-email');
    expect(expirationRole).toContain('/index/status-endDate-v2-index');
    expect(expirationRole).not.toContain('dynamodb:GetItem');
    expect(expirationRole).not.toContain('dynamodb:DescribeTable');
    expect(expirationRole).toContain(
      '/index/notificationStatus-createdAt-index',
    );
    expect(apiRole).toContain('Action: ssm:GetParameter');
    expect(apiRole).not.toContain('ssm:GetParameters');
    expect(notificationRole).toContain('Action: ssm:GetParameter');
    expect(notificationRole).not.toContain('ssm:GetParameters');
    expect(notificationRole).toContain('sqs:ReceiveMessage');
    expect(notificationRole).toContain('ses:SendEmail');
    // CloudFormation forbids SecureString resolution inside IAM policy documents.
    expect(notificationRole).not.toContain('{{resolve:ssm-secure:');
    expect(notificationRole).toContain("Resource: '*'");
    expect(notificationRole).toContain('/secrets/ses-sender-email');
    for (const role of [apiRole, expirationRole, notificationRole]) {
      expect(role).not.toContain('AWSLambdaBasicExecutionRole');
      expect(role).toContain('kms:Decrypt');
    }
    const providerEnvironment = api
      .split('  environment:\n')[1]
      ?.split('\nlayers:')[0];
    expect(providerEnvironment).not.toContain('SES_SENDER_EMAIL_PARAMETER:');
    expect(providerEnvironment).not.toContain('EDGE_SHARED_SECRET_PARAMETER:');
    expect(api).toMatch(
      /APP_FUNCTION: api\s+#.*\s+EDGE_SHARED_SECRET_PARAMETER:/,
    );
    expect(api).toMatch(
      /APP_FUNCTION: notification\s+#.*\s+SES_SENDER_EMAIL_PARAMETER:/,
    );
    expect(api).not.toContain('SES_SENDER_EMAIL: ${env:');
  });

  it('packages thin functions and installs the locked Linux ARM64 layer', () => {
    const api = read('api.yml');
    const plugin = read('plugins/common-layer.js');
    const layerPackage = read('layers/common/nodejs/package.json');

    // Individual packaging proves that every deployed handler stays below 5 MiB.
    expect(api).toMatch(/package:\r?\n\s+individually: true/);
    // Serverless 4 must not run its built-in builder alongside serverless-esbuild.
    expect(api).toMatch(/build:\r?\n\s+esbuild: false/);
    // NestJS 12 is ESM; .mjs prevents CommonJS require failures in Lambda.
    expect(api).toContain('format: esm');
    expect(api).toContain("outputFileExtension: '.mjs'");
    expect(api).toContain("- '@aws-sdk/*'");
    expect(api).toContain("- 'sharp'");
    expect(api).toContain('exclude:');
    expect(api).toContain("- '*'");
    expect(api).toContain('path: layers/common');
    expect(api).toContain('compatibleArchitectures:');
    expect(plugin).toContain("'before:package:initialize'");
    expect(plugin).toContain("'--os=linux'");
    expect(plugin).toContain("'--cpu=arm64'");
    // Windows hosts must select glibc explicitly or npm omits Sharp's Lambda binary.
    expect(plugin).toContain("'--libc=glibc'");
    // Node 24 on Windows requires a shell for the fixed npm.cmd invocation.
    expect(plugin).toContain("shell: process.platform === 'win32'");
    expect(layerPackage).toContain('"sharp"');
    expect(layerPackage).toContain('"@nestjs/common"');
    expect(existsSync('layers/common/nodejs/package-lock.json')).toBe(true);
  });

  it('makes WAF and custom DNS opt-in for cost-safe deployments', () => {
    const stack = read('edge.yml');
    const edge = read('resources/EdgeResource.yml');
    const secrets = read('scripts/configure-secrets.sh');

    // WAF remains available for full production, but is absent from the course profile.
    expect(stack).toContain(
      "wafEnabled: ${strToBool(${env:WAF_ENABLED, 'false'})}",
    );
    expect(stack).toContain(
      "UseWaf: !Equals ['${self:custom.wafEnabled}', true]",
    );
    expect(edge).toContain('WebACLId: !If [UseWaf,');
    // Count YAML property lines, not explanatory comments that mention the name.
    expect(edge.match(/^\s+Condition: UseWaf$/gm)).toHaveLength(2);
    expect(edge).toContain('Scope: CLOUDFRONT');
    expect(edge).toContain('AWSManagedRulesSQLiRuleSet');
    expect(edge).toContain('RateBasedStatement:');
    expect(edge).toContain('PriceClass_100');
    expect(edge).toContain('CachingDisabled');
    expect(edge).toContain('x-auctions-edge-key');
    expect(edge).toContain('AWS::CertificateManager::Certificate');
    expect(edge).toContain('Condition: UseCustomDomain');
    expect(edge).toContain('CloudFrontDefaultCertificate: true');
    expect(edge).not.toContain('Type: AWS::Route53::HostedZone');
    expect(secrets).toContain(
      'EDGE_AWS_REGION="${EDGE_AWS_REGION:-us-east-1}"',
    );
  });

  it('alerts operations for every asynchronous failure path', () => {
    const alarms = read('resources/AlarmsResource.yml');
    const api = read('api.yml');

    expect(api).toContain(
      '${file(./resources/AlarmsResource.yml):WinnerDlqMessagesAlarm}',
    );
    expect(api).toContain(
      '${file(./resources/AlarmsResource.yml):ExpirationDlqMessagesAlarm}',
    );
    for (const resource of [
      'WinnerDlqMessagesAlarm',
      'WinnerDlqAgeAlarm',
      'ExpirationDlqMessagesAlarm',
      'ExpirationDlqAgeAlarm',
      'ExpirationErrorsAlarm',
      'ExpirationThrottlesAlarm',
      'NotificationErrorsAlarm',
      'NotificationThrottlesAlarm',
    ]) {
      expect(alarms).toContain(`${resource}:`);
    }
    expect(alarms.match(/Type: AWS::CloudWatch::Alarm/g)).toHaveLength(8);
    expect(alarms.match(/AlarmActions:/g)).toHaveLength(8);
    expect(alarms.match(/\/alerts\/topic-arn/g)).toHaveLength(8);
    expect(
      alarms.match(/MetricName: ApproximateNumberOfMessagesVisible/g),
    ).toHaveLength(2);
    expect(
      alarms.match(/MetricName: ApproximateAgeOfOldestMessage/g),
    ).toHaveLength(2);
    expect(alarms.match(/MetricName: Errors/g)).toHaveLength(2);
    expect(alarms.match(/MetricName: Throttles/g)).toHaveLength(2);
    expect(alarms.match(/winner-notifications\/dlq-arn/g)).toHaveLength(2);
    expect(alarms.match(/auction-expiration\/dlq-arn/g)).toHaveLength(2);
    expect(alarms).not.toContain('Ref: WinnerNotificationsDLQ');
    expect(alarms).not.toContain('Ref: AuctionExpirationDLQ');
    expect(alarms).toContain('!Ref CloseExpiredAuctionsLambdaFunction');
    expect(alarms).toContain('!Ref SendWinnerNotificationLambdaFunction');
  });

  it('keeps memory benchmarking isolated and artifact checks local', () => {
    const benchmark = read('scripts/benchmark-lambda-memory.sh');
    const verify = read('scripts/verify-deployment-artifacts.sh');
    const packageJson = read('package.json');

    expect(benchmark).toContain('--confirm-disposable-stage');
    expect(benchmark).toContain('prod|production');
    expect(benchmark).toContain('benchmark-*');
    expect(benchmark).toContain('memory_sizes=(128 256 512 1024)');
    expect(benchmark).toContain('success@simulator.amazonses.com');
    expect(benchmark).toContain('update-function-configuration');
    expect(benchmark).toContain('--log-type Tail');
    expect(benchmark).toContain('Billed Duration');
    expect(benchmark).toContain('restore_memory');
    expect(benchmark).toContain('trap restore_memory EXIT');
    expect(benchmark).toContain('cost_usd');
    expect(verify).toContain('5 * 1024 * 1024');
    expect(packageJson).toContain(
      '"benchmark:lambda": "bash scripts/benchmark-lambda-memory.sh"',
    );
    expect(packageJson).toContain(
      '"verify:artifacts": "bash scripts/verify-deployment-artifacts.sh"',
    );
  });
});
