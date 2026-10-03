import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { webhookCallback } from 'grammy';
import IORedis from 'ioredis';
import type { Db } from '@dominify/db';
import { configureBot, createBot } from './bot/bot';
import { loadConfig } from './config';
import { initMonitoring } from './infra/monitoring';
import { FilesService } from './files/files';
import { DB, REDIS } from './infra/tokens';
import { BotModule } from './modules';
import { ParsingService } from './parsing/parsing.service';
import { RequestsService } from './requests/requests.service';
import { UsersService } from './users/users.service';

/**
 * Процесс бота. На Railway — вебхук (BOT_MODE=webhook) за своим доменом, локально — long polling.
 * Бизнес-логика общая с api: те же сервисы из CoreModule.
 */
async function bootstrap() {
  const cfg = loadConfig();
  initMonitoring(cfg, 'bot');
  const logger = new ConsoleLogger({ json: cfg.NODE_ENV === 'production', prefix: 'bot' });
  const app = await NestFactory.createApplicationContext(BotModule, { logger });
  const log = new Logger('Bot');

  const bot = createBot({
    cfg,
    db: app.get<Db>(DB),
    redis: app.get<IORedis>(REDIS),
    users: app.get(UsersService),
    requests: app.get(RequestsService),
    files: app.get(FilesService),
    parsing: app.get(ParsingService),
  });
  await bot.init();
  await configureBot(bot, cfg).catch((e) => log.warn(`Не удалось настроить меню бота: ${e.message}`));

  if (cfg.BOT_MODE === 'webhook') {
    if (!cfg.BOT_PUBLIC_URL || !cfg.BOT_WEBHOOK_SECRET) throw new Error('Для вебхука нужны BOT_PUBLIC_URL и BOT_WEBHOOK_SECRET');
    const server = express();
    server.use(express.json({ limit: '1mb' }));
    server.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
    server.post('/tg/webhook', webhookCallback(bot, 'express', { secretToken: cfg.BOT_WEBHOOK_SECRET, timeoutMilliseconds: 25_000 }));
    const httpServer = server.listen(cfg.PORT, '0.0.0.0', () => log.log(`Вебхук бота слушает порт ${cfg.PORT}`));
    await bot.api.setWebhook(`${cfg.BOT_PUBLIC_URL.replace(/\/$/, '')}/tg/webhook`, {
      secret_token: cfg.BOT_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    });
    const shutdown = async () => {
      httpServer.close();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } else {
    await bot.api.deleteWebhook();
    log.log(`Бот @${bot.botInfo.username} запущен в режиме polling`);
    const shutdown = async () => {
      await bot.stop();
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    await bot.start({ allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
  }
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
