import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const incomingRequestId = response.locals.requestId as string | undefined;
    const requestId =
      incomingRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    const startedAt = Date.now();

    response.locals.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    return next.handle().pipe(
      tap({
        next: () => this.logRequest(request, response, requestId, startedAt),
        error: (error: unknown) =>
          this.logRequest(request, response, requestId, startedAt, error),
      }),
    );
  }

  private logRequest(
    request: Request,
    response: Response,
    requestId: string,
    startedAt: number,
    error?: unknown,
  ): void {
    const statusCode =
      error === undefined
        ? response.statusCode
        : error instanceof HttpException
          ? error.getStatus()
          : 500;
    const metadata = JSON.stringify({
      requestId,
      method: request.method,
      route: request.route?.path ?? 'unmatched',
      statusCode,
      durationMs: Date.now() - startedAt,
    });

    if (error) {
      this.logger.error(metadata);
    } else {
      this.logger.log(metadata);
    }
  }
}
