import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const requestId = response.locals.requestId as string | undefined;

    response.status(statusCode).json({
      statusCode,
      message:
        exception instanceof HttpException
          ? this.getSafeMessage(exception)
          : 'Internal server error',
      path: request.route?.path ?? 'unmatched',
      requestId,
    });
  }

  private getSafeMessage(exception: HttpException): string | string[] {
    const payload = exception.getResponse();
    if (typeof payload === 'string') {
      return payload;
    }

    const message = (payload as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
    if (
      Array.isArray(message) &&
      message.every((entry): entry is string => typeof entry === 'string')
    ) {
      return message;
    }

    return exception.message;
  }
}
