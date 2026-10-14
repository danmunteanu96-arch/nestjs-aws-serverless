import compression from 'compression';
import { json, urlencoded } from 'express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module';

export async function createHttpApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService);
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
    const incomingRequestId = request.get('x-request-id');
    const requestId =
      incomingRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    next();
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const isSwaggerRequest = docsEnabled && request.path.startsWith('/docs');
    const middleware = isSwaggerRequest
      ? docsSecurityHeaders
      : apiSecurityHeaders;
    middleware(request, response, next);
  });
  app.use(json({ limit: '1mb', strict: true, type: 'application/json' }));
  app.use(
    urlencoded({
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
