import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { JsonLoggerService } from '../logging/json-logger.service';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new JsonLoggerService('auctions-api');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlationId = response.locals.requestId as string;
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () =>
          this.logRequest(request, response, correlationId, startedAt),
        error: (error: unknown) =>
          this.logRequest(request, response, correlationId, startedAt, error),
      }),
    );
  }

  private logRequest(
    request: Request,
    response: Response,
    correlationId: string,
    startedAt: number,
    error?: unknown,
  ): void {
    const statusCode =
      error === undefined
        ? response.statusCode
        : error instanceof HttpException
          ? error.getStatus()
          : 500;
    // Only route and timing metadata are logged; bodies, headers and actors are excluded.
    const metadata = {
      correlationId,
      method: request.method,
      route: request.route?.path ?? 'unmatched',
      statusCode,
      durationMs: Date.now() - startedAt,
    };

    if (error) this.logger.error('HTTP request failed', metadata);
    else this.logger.log('HTTP request completed', metadata);
  }
}
