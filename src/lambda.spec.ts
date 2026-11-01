import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { handler as lambdaHandler } from './lambda.js';

const expressHandler = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const loadRuntimeConfig = jest.fn<() => Promise<void>>().mockResolvedValue();
const createHttpApplication = jest.fn<() => Promise<unknown>>();
const serverlessExpress = jest.fn(() => expressHandler);

jest.unstable_mockModule('./config/runtime-config', () => ({
  loadRuntimeConfig,
}));
jest.unstable_mockModule('./http/create-http-application.js', () => ({
  createHttpApplication,
}));
jest.unstable_mockModule('@codegenie/serverless-express', () => ({
  default: serverlessExpress,
}));

let handler: typeof lambdaHandler;
beforeAll(async () => {
  const modulePath = './lambda';
  ({ handler } = await import(modulePath));
});

describe('Lambda HTTP adapter', () => {
  const enableShutdownHooks = jest.fn();

  beforeEach(() => {
    expressHandler.mockReset();
    enableShutdownHooks.mockReset();
    createHttpApplication.mockResolvedValue({
      init: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      enableShutdownHooks,
      getHttpAdapter: () => ({ getInstance: () => ({}) }),
      useLogger: jest.fn(),
    });
  });

  it('forwards event and context while reusing warm bootstrap', async () => {
    const event = {
      requestContext: { requestId: 'request-1' },
    } as APIGatewayProxyEventV2;
    const context = {} as Context;
    expressHandler.mockResolvedValue({ statusCode: 200 });

    await handler(event, context);
    await handler(event, context);

    expect(expressHandler).toHaveBeenLastCalledWith(event, context);
    expect(loadRuntimeConfig).toHaveBeenCalledTimes(1);
    // Signal handlers belong to cold bootstrap, never to individual warm requests.
    expect(enableShutdownHooks).toHaveBeenCalledTimes(1);
  });
});
