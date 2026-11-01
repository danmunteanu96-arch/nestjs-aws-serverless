import { ConfigService } from '@nestjs/config';
import { JsonLoggerService } from './common/logging/json-logger.service';
import { loadRuntimeConfig } from './config/runtime-config';
import { createHttpApplication } from './http/create-http-application';

async function bootstrap(): Promise<void> {
  await loadRuntimeConfig();
  const app = await createHttpApplication();
  app.useLogger(new JsonLoggerService('auctions-api'));
  // SIGTERM triggers Nest lifecycle hooks and idempotent AWS client cleanup.
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  await app.listen(configService.getOrThrow<number>('PORT'));
}

void bootstrap();
