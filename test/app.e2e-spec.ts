import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { INestApplication } from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { createHttpApplication } from './../src/http/create-http-application';
import type { RequestWithApiGateway } from './../src/common/decorators/current-user.decorator';

// Provides real PNG magic bytes for multipart tests without reading a fixture file.
const validPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

// Simulates the claims the API Gateway JWT authorizer injects on real requests,
// so validation/pipeline behaviour can be exercised locally.
const fakeGatewayClaims = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  (req as RequestWithApiGateway).apiGateway = {
    event: {
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'e2e-user' } } },
      },
    },
  };
  next();
};

describe('HTTP API (e2e)', () => {
  let app: INestApplication;
  const originalQueueUrl = process.env.WINNER_NOTIFICATIONS_QUEUE_URL;

  beforeEach(async () => {
    // Health checks receive a deterministic queue URL without reading local credentials.
    process.env.WINNER_NOTIFICATIONS_QUEUE_URL = 'https://sqs.test/queue';
    app = await createHttpApplication();
    app.use(fakeGatewayClaims);
    await app.init();
  });

  it('returns dependency health and a request ID', async () => {
    const dynamo = jest
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockImplementation(() => Promise.resolve({}) as never);
    const sqs = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(() => Promise.resolve({}) as never);
    try {
      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect(({ headers, body }) => {
          expect(body).toEqual({
            status: 'ok',
            checks: { dynamodb: 'up', sqs: 'up' },
          });
          expect(headers['x-request-id']).toMatch(/^[A-Za-z0-9-]+$/);
          expect(headers['content-security-policy']).toContain(
            "script-src 'self'",
          );
          expect(headers['content-security-policy']).not.toContain(
            'unsafe-inline',
          );
        });
    } finally {
      dynamo.mockRestore();
      sqs.mockRestore();
    }
  });

  it('returns a safe 503 when a health dependency fails', async () => {
    const dynamo = jest
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockImplementation(
        () => Promise.reject(new Error('provider internals')) as never,
      );
    const sqs = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(() => Promise.resolve({}) as never);
    try {
      await request(app.getHttpServer())
        .get('/health')
        .expect(503)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            status: 'error',
            checks: { dynamodb: 'down', sqs: 'up' },
          });
          expect(JSON.stringify(body)).not.toContain('provider internals');
        });
    } finally {
      dynamo.mockRestore();
      sqs.mockRestore();
    }
  });

  it('serves Swagger UI with its CSP exception scoped to docs', () => {
    return request(app.getHttpServer())
      .get('/docs/')
      .expect(200)
      .expect('Content-Type', /html/)
      .expect(({ headers }) => {
        expect(headers['content-security-policy']).toBeUndefined();
      });
  });

  it('/docs-json (GET)', () => {
    return request(app.getHttpServer())
      .get('/docs-json')
      .expect(200)
      .expect(({ body }) => {
        expect(body.info.title).toBe('Auctions API');
        expect(body.paths['/auctions'].get.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'status', in: 'query' }),
          ]),
        );
      });
  });

  it('rejects malformed auction bodies before persistence', () => {
    return request(app.getHttpServer())
      .post('/auctions')
      .send({ title: 'Missing deadline', status: 'ACTIVE' })
      .expect(400)
      .expect(({ headers, body }) => {
        expect(body.statusCode).toBe(400);
        expect(body.requestId).toBe(headers['x-request-id']);
      });
  });

  it('validates DTO fields sent through multipart form data', () => {
    return request(app.getHttpServer())
      .post('/auctions')
      .field('title', 'Missing deadline')
      .field('status', 'ACTIVE')
      .attach('image', validPng, {
        filename: 'pixel.png',
        contentType: 'image/png',
      })
      .expect(400);
  });

  it('rejects a valid multipart auction without its required image', () => {
    return request(app.getHttpServer())
      .post('/auctions')
      .field('title', 'Missing image')
      .field('status', 'ACTIVE')
      .field('endDate', '2030-01-01T00:00:00.000Z')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toMatch(/image/i);
      });
  });

  it('rejects unknown multipart fields before persistence', () => {
    return request(app.getHttpServer())
      .post('/auctions')
      .field('title', 'Unknown field')
      .field('status', 'ACTIVE')
      .field('endDate', '2030-01-01T00:00:00.000Z')
      .field('createdBy', 'untrusted-user')
      .attach('image', validPng, {
        filename: 'pixel.png',
        contentType: 'image/png',
      })
      .expect(400);
  });

  it('rejects images larger than five MiB before persistence', () => {
    return request(app.getHttpServer())
      .post('/auctions')
      .field('title', 'Oversized image')
      .field('status', 'ACTIVE')
      .field('endDate', '2030-01-01T00:00:00.000Z')
      .attach('image', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'oversized.jpg',
        contentType: 'image/jpeg',
      })
      .expect(413);
  });

  it('rejects mutations without API Gateway JWT claims', async () => {
    const anonymousApp = await createHttpApplication();
    await anonymousApp.init();
    try {
      await request(anonymousApp.getHttpServer())
        .post('/auctions')
        .send({
          title: 'Anonymous auction',
          status: 'ACTIVE',
          endDate: '2030-01-01T00:00:00.000Z',
        })
        .expect(401);
    } finally {
      await anonymousApp.close();
    }
  });

  it('rejects unknown auction status filters', () => {
    return request(app.getHttpServer())
      .get('/auctions?status=PAUSED')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(
          expect.arrayContaining([expect.stringContaining('status')]),
        );
      });
  });

  // A page-size ceiling bounds DynamoDB work and prevents expensive client-controlled reads.
  it('rejects auction page limits above one hundred', () => {
    return request(app.getHttpServer())
      .get('/auctions?limit=101')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toEqual(
          expect.arrayContaining([expect.stringContaining('limit')]),
        );
      });
  });

  // Malformed opaque cursors fail at the application boundary before a database call.
  it('rejects malformed auction cursors', () => {
    return request(app.getHttpServer())
      .get('/auctions?cursor=not-a-valid-cursor')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toMatch(/cursor/i);
      });
  });

  // PATCH requires the same trusted gateway identity as the other mutation routes.
  it('rejects auction updates without API Gateway JWT claims', async () => {
    const anonymousApp = await createHttpApplication();
    await anonymousApp.init();
    try {
      await request(anonymousApp.getHttpServer())
        .patch('/auctions/123e4567-e89b-42d3-a456-426614174000')
        .send({ title: 'Anonymous update' })
        .expect(401);
    } finally {
      await anonymousApp.close();
    }
  });

  it('rejects malformed auction IDs at the route boundary', () => {
    return request(app.getHttpServer())
      .get('/auctions/not-a-uuid')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toMatch(/uuid/i);
        expect(body.requestId).toBeDefined();
      });
  });

  it('uses the shared 404 contract and request ID for unknown routes', () => {
    return request(app.getHttpServer())
      .get('/not-a-route')
      .expect(404)
      .expect(({ headers, body }) => {
        expect(body.statusCode).toBe(404);
        expect(body.requestId).toBe(headers['x-request-id']);
      });
  });

  afterEach(async () => {
    await app.close();
    if (originalQueueUrl === undefined) {
      delete process.env.WINNER_NOTIFICATIONS_QUEUE_URL;
    } else {
      process.env.WINNER_NOTIFICATIONS_QUEUE_URL = originalQueueUrl;
    }
  });
});
