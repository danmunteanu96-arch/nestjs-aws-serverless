import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';

export const AWS_CLIENT = Symbol('AWS_CLIENT');
export interface DestroyableAwsClient {
  destroy(): void;
}

// One lifecycle provider per infrastructure module gives each warm client idempotent cleanup.
@Injectable()
export class AwsClientLifecycle implements OnModuleDestroy {
  private destroyed = false;

  constructor(
    @Inject(AWS_CLIENT) private readonly client: DestroyableAwsClient,
  ) {}

  onModuleDestroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.client.destroy();
  }
}
