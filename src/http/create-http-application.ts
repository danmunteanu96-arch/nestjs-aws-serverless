import compression from 'compression';
// Default import keeps Node's CJS interop working when the bundle is ESM and
// express stays externalized in the shared Lambda layer.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
// ESM requires the explicit .js extension; the package has no exports map.
import { eventContext } from '@codegenie/serverless-express/src/middleware.js';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module';
import type { RequestWithApiGateway } from '../common/decorators/current-user.decorator';
import {
  correlationIdFor,
  runWithCorrelationId,
} from '../common/logging/correlation';
import { JsonLoggerService } from '../common/logging/json-logger.service';

export async function createHttpApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  // Buffer startup entries, then flush them through the one production JSON logger.
  app.useLogger(new JsonLoggerService('auctions-api'));
  const configService = app.get(ConfigService);
  // Exposes the API Gateway event on req.apiGateway so decorators can read
  // the JWT authorizer claims. Outside Lambda it attaches an empty object.
  app.use(eventContext());
  const docsEnabled = configService.getOrThrow<boolean>('API_DOCS_ENABLED');
  const helmetOptions = {
    xPoweredBy: false,
    noSniff: true,
    frameguard: { action: 'deny' as const },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
  };
  const apiSecurityHeaders = helmet(helmetOptions);
  const docsSecurityHeaders = helmet({
    ...helmetOptions,
    contentSecurityPolicy: false,
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    const gatewayRequestId = (request as RequestWithApiGateway).apiGateway
      ?.event?.requestContext?.requestId;
    const candidate = gatewayRequestId ?? request.get('x-correlation-id');
    const correlationId = correlationIdFor(candidate);
    // AsyncLocalStorage keeps the same correlation ID in services and error paths.
    runWithCorrelationId(correlationId, () => {
      response.locals.requestId = correlationId;
      response.setHeader('x-request-id', correlationId);
      response.setHeader('x-correlation-id', correlationId);
      next();
    });
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const isSwaggerRequest = docsEnabled && request.path.startsWith('/docs');
    const middleware = isSwaggerRequest
      ? docsSecurityHeaders
      : apiSecurityHeaders;
    middleware(request, response, next);
  });
  app.use(
    express.json({ limit: '1mb', strict: true, type: 'application/json' }),
  );
  app.use(
    express.urlencoded({
      extended: false,
      limit: '1mb',
      parameterLimit: 1000,
    }),
  );
  app.use(
    compression({
      level: 6,
      threshold: 1024,
    }),
  );
  app.enableCors({
    origin: configService
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (docsEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Auctions API')
        .setDescription('Auction management API')
        .setVersion('1.0')
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }

  return app;
}
