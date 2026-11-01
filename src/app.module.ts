import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigurationModule } from './config/configuration.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { EdgeOriginGuard } from './common/guards/edge-origin.guard';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { AuctionsModule } from './modules/auctions/auctions.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [ConfigurationModule, AuctionsModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Every HTTP route rejects direct origin access before reaching feature logic.
    { provide: APP_GUARD, useClass: EdgeOriginGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
