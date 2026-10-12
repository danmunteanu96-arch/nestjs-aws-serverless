import { NestFactory } from '@nestjs/core';
import serverlessExpress from '@codegenie/serverless-express';
import { Context } from 'aws-lambda';
import { AppModule } from './app.module';

type PromiseHandler = (event: any, context: Context) => Promise<unknown>;

let server: PromiseHandler;

async function bootstrap(): Promise<PromiseHandler> {
  const app = await NestFactory.create(AppModule);

  await app.init();

  const expressApp = app.getHttpAdapter().getInstance();

  return serverlessExpress({ app: expressApp }) as unknown as PromiseHandler;
}

export const handler: PromiseHandler = async (event: any, context: Context) => {
  server = server ?? (await bootstrap());

  return server(event, context);
};