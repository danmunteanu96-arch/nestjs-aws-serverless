import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateRuntimeConfig } from './runtime-config';

// All entry points share this single runtime schema; feature modules never read process.env directly.

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateRuntimeConfig,
    }),
  ],
  exports: [ConfigModule],
})
export class ConfigurationModule {}
