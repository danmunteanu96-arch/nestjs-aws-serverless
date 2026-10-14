import { ConfigService } from '@nestjs/config';
import { createHttpApplication } from './http/create-http-application';

async function bootstrap(): Promise<void> {
  const app = await createHttpApplication();
  const configService = app.get(ConfigService);
  await app.listen(configService.getOrThrow<number>('PORT'));
}

void bootstrap();
