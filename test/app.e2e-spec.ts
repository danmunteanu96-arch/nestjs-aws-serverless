import { INestApplication } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { createHttpApplication } from './../src/http/create-http-application';

describe('HTTP API (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await createHttpApplication();
    await app.init();
  });

  it('returns health and a request ID', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ headers, body }) => {
        expect(body).toEqual({ status: 'ok' });
        expect(headers['x-request-id']).toMatch(/^[A-Za-z0-9-]+$/);
        expect(headers['content-security-policy']).toContain(
          "script-src 'self'",
        );
        expect(headers['content-security-policy']).not.toContain(
          'unsafe-inline',
        );
      });
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
  });
});
