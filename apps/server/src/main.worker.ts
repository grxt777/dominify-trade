import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker, type Job } from 'bullmq';
import { loadConfig } from './config';
import { bullConnection } from './infra/queues';
import { QUEUE_NAMES } from './infra/tokens';
import { BillingService } from './billing/billing.service';
import { MatchingService } from './matching/matching.service';
import { OffersService } from './offers/offers';
import { ParsingService } from './parsing/parsing.service';
import { RequestsService } from './requests/requests.service';
import { WorkerModule } from './modules';
import { NotificationSender, RateLimited } from './worker/sender';
import { QueueService } from './infra/queues';

/**
 * Воркер: всё медленное и отложенное. Очереди parse, matching, notify, scheduled.
 * Масштабируется репликами на Railway; при росте parse выносится в отдельный сервис.
 */
async function bootstrap() {
  const cfg = loadConfig();
  const logger = new ConsoleLogger({ json: cfg.NODE_ENV === 'production', prefix: 'worker' });
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger });
  const log = new Logger('Worker');

  const parsing = app.get(ParsingService);
  const requests = app.get(RequestsService);
  const matching = app.get(MatchingService);
  const offers = app.get(OffersService);
  const sender = app.get(NotificationSender);
  const billing = app.get(BillingService);
  const queues = app.get(QueueService);

  const connection = bullConnection(cfg.REDIS_URL);
  const workers: Worker[] = [];

  workers.push(
    new Worker(
      QUEUE_NAMES.parse,
      async (job: Job<{ requestId: number }>) => {
        const outcome = await parsing.parseRequest(job.data.requestId);
        if (outcome) await requests.afterParse(job.data.requestId, outcome);
        return outcome?.status ?? 'skipped';
      },
      { connection, concurrency: 5 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.matching,
      async (job: Job<{ requestId: number; wave?: number }>) => {
        if (job.name === 'dispatch') return matching.dispatch(job.data.requestId, job.data.wave ?? 1);
        if (job.name === 'check-wave') return matching.checkWave(job.data.requestId);
        if (job.name === 'check-final') return matching.checkFinal(job.data.requestId);
        return null;
      },
      { connection, concurrency: 5 },
    ),
  );

  // Telegram ограничивает частоту сообщений бота: держим не больше 25 в секунду.
  const notifyWorker: Worker = new Worker(
    QUEUE_NAMES.notify,
    async (job: Job<{ notificationId?: number; requestId?: number }>) => {
      if (job.name === 'offer-digest') return offers.digest(job.data.requestId!);
      try {
        return await sender.send(job.data.notificationId!);
      } catch (e) {
        if (e instanceof RateLimited) {
          await notifyWorker.rateLimit(e.retryAfterSec * 1000);
          throw Worker.RateLimitError();
        }
        throw e;
      }
    },
    { connection, concurrency: 10, limiter: { max: 25, duration: 1000 } },
  );
  workers.push(notifyWorker);

  workers.push(
    new Worker(
      QUEUE_NAMES.scheduled,
      async (job: Job) => {
        switch (job.name) {
          case 'expire-requests':
            return requests.expireOld();
          case 'remind-silent':
            return matching.remindSilent();
          case 'subscriptions':
            return billing.lifecycle();
          case 'response-times':
            return matching.recomputeResponseTimes();
          default:
            return null;
        }
      },
      { connection, concurrency: 1 },
    ),
  );

  // Повторяющиеся задачи. upsertJobScheduler идемпотентен: реплики воркера не создают дубли.
  const sched = queues.queues.scheduled;
  await sched.upsertJobScheduler('expire-requests', { every: 60 * 60_000 }, { name: 'expire-requests' });
  await sched.upsertJobScheduler('remind-silent', { every: 10 * 60_000 }, { name: 'remind-silent' });
  await sched.upsertJobScheduler('subscriptions', { pattern: '0 4 * * *', tz: 'Asia/Tashkent' }, { name: 'subscriptions' });
  await sched.upsertJobScheduler('response-times', { pattern: '30 3 * * *', tz: 'Asia/Tashkent' }, { name: 'response-times' });

  for (const w of workers) {
    w.on('failed', (job, err) => log.warn(`${w.name}/${job?.name} #${job?.id} упала: ${err.message}`));
    w.on('error', (err) => log.error(`${w.name}: ${err.message}`));
  }
  log.log(`Воркер запущен: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async () => {
    log.log('Останавливаюсь, дорабатываю текущие задачи');
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
