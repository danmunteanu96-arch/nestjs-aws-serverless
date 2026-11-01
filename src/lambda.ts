import serverlessExpress from '@codegenie/serverless-express';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { JsonLoggerService } from './common/logging/json-logger.service';
import { loadRuntimeConfig } from './config/runtime-config';

// Node.js 24 Lambda removed callback-style handlers. The adapter always returns
// a Promise when called with (event, context), so this wrapper stays async-only.
type ApiHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyResultV2>;

let server: Promise<ApiHandler> | undefined;

async function bootstrap(): Promise<ApiHandler> {
  // Load SSM SecureStrings BEFORE the Nest module graph is evaluated.
  // ConfigModule.forRoot validates env at import time, so a static import of
  // create-http-application would run validation before the secret exists.
  await loadRuntimeConfig();
  const { createHttpApplication } =
    await import('./http/create-http-application.js');
  const app = await createHttpApplication();
  app.useLogger(new JsonLoggerService('auctions-api'));
  // Cleanup runs only on environment shutdown, never between warm invocations.
  app.enableShutdownHooks();
  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp }) as unknown as ApiHandler;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  server ??= bootstrap();
  let serverHandler: ApiHandler;
  try {
    serverHandler = await server;
  } catch (error: unknown) {
    server = undefined;
    throw error;
  }

  // The adapter resolves its Promise once the Express response is complete.
  return serverHandler(event, context);
};
