import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class EdgeOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    // Local handlers do not pass through CloudFront, so only the deployed API enforces this check.
    if (this.config.get<string>('APP_FUNCTION') !== 'api') return true;

    const request = context.switchToHttp().getRequest<{
      get(name: string): string | undefined;
    }>();
    const provided = request.get('x-auctions-edge-key');
    const expected = this.config.get<string>('EDGE_SHARED_SECRET');

    if (!provided || !expected) throw new ForbiddenException();

    // Hashing equalizes input lengths before the constant-time comparison.
    const providedDigest = createHash('sha256').update(provided).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(providedDigest, expectedDigest)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
