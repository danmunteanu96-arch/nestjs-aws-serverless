import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedUser {
  sub: string;
  email?: string;
}

export interface RequestWithApiGateway extends Request {
  apiGateway?: {
    event?: {
      requestContext?: {
        authorizer?: { jwt?: { claims?: Record<string, unknown> } };
      };
    };
  };
}

/**
 * Reads the caller identity from the JWT claims injected by the API Gateway
 * JWT authorizer (event.requestContext.authorizer.jwt.claims). Fails closed:
 * without claims (local run, authorizer bypass) the request is rejected.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithApiGateway>();
    const claims =
      request.apiGateway?.event?.requestContext?.authorizer?.jwt?.claims;

    const sub = claims?.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new UnauthorizedException('Missing authenticated user claims');
    }

    const email = claims?.email;
    return {
      sub,
      ...(typeof email === 'string' ? { email } : {}),
    };
  },
);
