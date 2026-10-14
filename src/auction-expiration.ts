import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuctionExpirationModule } from './auction-expiration.module';
import { AuctionExpirationService } from './auction-expiration.service';

let applicationContext: Promise<INestApplicationContext> | undefined;

export async function handler(): Promise<void> {
  applicationContext ??= NestFactory.createApplicationContext(
    AuctionExpirationModule,
  );
  const context = await applicationContext;
  const expirationService = context.get(AuctionExpirationService);
  await expirationService.closeExpiredAuctions();
}