import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { runMigrations } from '@dominify/db';
import { loadConfig } from './config';
import { ApiModule } from './modules';

async function bootstrap() {
  const cfg = loadConfig();
  const logger = new ConsoleLogger({ json: cfg.NODE_ENV === 'production', prefix: 'api' });

  if (process.env.MIGRATE_ON_START === '1') {
    await runMigrations(cfg.DATABASE_URL);
    logger.log('Миграции применены');
  }

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger, bufferLogs: true });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  const origins = [cfg.MINIAPP_URL, cfg.ADMIN_URL, ...cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];
  app.enableCors({ origin: origins, credentials: true, maxAge: 86_400 });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, '0.0.0.0');
  Logger.log(`api слушает порт ${cfg.PORT}`, 'Bootstrap');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
