import serverlessExpress from '@codegenie/serverless-express';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
  Handler,
} from 'aws-lambda';
import { createHttpApplication } from './http/create-http-application';

type ApiHandler = Handler<APIGatewayProxyEventV2, APIGatewayProxyResultV2>;
type PromiseApiHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
) => Promise<APIGatewayProxyResultV2>;

let server: Promise<ApiHandler> | undefined;

async function bootstrap(): Promise<ApiHandler> {
  const app = await createHttpApplication();
  await app.init();
  const expressApp = app.getHttpAdapter().getInstance();
  return serverlessExpress({ app: expressApp }) as ApiHandler;
}

export const handler: PromiseApiHandler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
) => {
  server ??= bootstrap();
  let serverHandler: ApiHandler;
  try {
    serverHandler = await server;
  } catch (error: unknown) {
    server = undefined;
    throw error;
  }

  return new Promise<APIGatewayProxyResultV2>((resolve, reject) => {
    serverHandler(event, context, (error, result) => {
      if (error) {
        reject(error);
      } else if (result === undefined) {
        reject(new Error('Lambda HTTP adapter returned no response'));
      } else {
        resolve(result);
      }
    });
  });
};
