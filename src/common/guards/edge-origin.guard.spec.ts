import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EdgeOriginGuard } from './edge-origin.guard';

describe('EdgeOriginGuard', () => {
  let guard: EdgeOriginGuard;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EdgeOriginGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'APP_FUNCTION'
                ? 'api'
                : 'test-edge-secret-with-enough-length',
            ),
          },
        },
      ],
    }).compile();
    guard = module.get(EdgeOriginGuard);
  });

  function contextWithHeader(header?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          get: (name: string) =>
            name === 'x-auctions-edge-key' ? header : undefined,
        }),
      }),
    } as ExecutionContext;
  }

  it('rejects direct requests without the edge header', () => {
    expect(() => guard.canActivate(contextWithHeader())).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an incorrect edge header', () => {
    expect(() => guard.canActivate(contextWithHeader('wrong'))).toThrow(
      ForbiddenException,
    );
  });

  it('allows the request only when the secret matches', () => {
    expect(
      guard.canActivate(
        contextWithHeader('test-edge-secret-with-enough-length'),
      ),
    ).toBe(true);
  });
});
