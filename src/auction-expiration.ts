import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuctionExpirationModule } from './modules/auctions/expiration/auction-expiration.module';
import { AuctionExpirationService } from './modules/auctions/expiration/auction-expiration.service';

let applicationContext: Promise<INestApplicationContext> | undefined;

export async function handler(): Promise<void> {
  applicationContext ??= NestFactory.createApplicationContext(
    AuctionExpirationModule,
  );

  let context: INestApplicationContext;
  try {
    context = await applicationContext;
  } catch (error: unknown) {
    applicationContext = undefined;
    throw error;
  }

  const expirationService = context.get(AuctionExpirationService);
  await expirationService.closeExpiredAuctions();
}
