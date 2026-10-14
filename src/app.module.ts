import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigurationModule } from './config/configuration.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { AuctionsModule } from './modules/auctions/auctions.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [ConfigurationModule, AuctionsModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
