import 'reflect-metadata';
import { ConsoleLogger, Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { runMigrations } from '@dominify/db';
import type { NextFunction, Request, Response } from 'express';
import type { ServerOptions } from 'socket.io';
import { loadConfig } from './config';
import { initMonitoring } from './infra/monitoring';
import { ApiModule } from './modules';

/** WebSocket принимает подключения только с тех же доменов, что и HTTP API. */
class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.origins, credentials: true } });
  }
}

/** API отдаёт JSON и файлы: страницы в iframe не встраиваются, MIME не угадывается браузером. */
function securityHeaders(prod: boolean) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (prod) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

async function bootstrap() {
  const cfg = loadConfig();
  initMonitoring(cfg, 'api');
  const logger = new ConsoleLogger({ json: cfg.NODE_ENV === 'production', prefix: 'api' });

  if (process.env.MIGRATE_ON_START === '1') {
    await runMigrations(cfg.DATABASE_URL);
    logger.log('Миграции применены');
  }

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger, bufferLogs: true });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders(cfg.NODE_ENV === 'production'));
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  const origins = [cfg.MINIAPP_URL, cfg.ADMIN_URL, ...cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];
  app.enableCors({ origin: origins, credentials: true, maxAge: 86_400 });
  app.useWebSocketAdapter(new CorsIoAdapter(app, origins));
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, '0.0.0.0');
  Logger.log(`api слушает порт ${cfg.PORT}`, 'Bootstrap');
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
