import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { JobsOptions, Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Config } from '../config';
import { CONFIG, QUEUE_NAMES, type QueueName } from './tokens';

export interface ParseJob {
  requestId: number;
}
export interface DispatchJob {
  requestId: number;
  wave: number;
}
export interface CheckWaveJob {
  requestId: number;
}
export interface NotifyJob {
  notificationId: number;
}
export interface OfferDigestJob {
  requestId: number;
}

/** BullMQ требует отдельное соединение с maxRetriesPerRequest: null. */
export function bullConnection(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly conn: IORedis;
  readonly queues: Record<QueueName, Queue>;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.conn = bullConnection(cfg.REDIS_URL);
    const defaults: JobsOptions = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 7 * 86_400 },
    };
    this.queues = {
      parse: new Queue(QUEUE_NAMES.parse, { connection: this.conn, defaultJobOptions: defaults }),
      matching: new Queue(QUEUE_NAMES.matching, { connection: this.conn, defaultJobOptions: { ...defaults, attempts: 5 } }),
      notify: new Queue(QUEUE_NAMES.notify, { connection: this.conn, defaultJobOptions: { ...defaults, attempts: 5 } }),
      scheduled: new Queue(QUEUE_NAMES.scheduled, { connection: this.conn, defaultJobOptions: defaults }),
    };
  }

  /** delayMs > 0 — для альбомов в боте: ждём остальные фото, прежде чем разбирать заявку. */
  parse(job: ParseJob, delayMs = 0) {
    return this.queues.parse.add('parse', job, { priority: 1, jobId: `parse-${job.requestId}-${Date.now()}`, delay: delayMs });
  }

  dispatch(job: DispatchJob, delayMs = 0) {
    return this.queues.matching.add('dispatch', job, { jobId: `dispatch-${job.requestId}-w${job.wave}`, delay: delayMs });
  }

  checkWave(job: CheckWaveJob, delayMs: number) {
    return this.queues.matching.add('check-wave', job, { jobId: `check-${job.requestId}`, delay: delayMs });
  }

  notify(job: NotifyJob, delayMs = 0) {
    return this.queues.notify.add('send', job, { jobId: `n-${job.notificationId}`, delay: Math.max(0, delayMs) });
  }

  /** Сводка откликов: пока задача с этим jobId ждёт, повторные вызовы ничего не добавляют. */
  offerDigest(job: OfferDigestJob, delayMs: number) {
    return this.queues.notify.add('offer-digest', job, {
      jobId: `digest-${job.requestId}-${Math.floor(Date.now() / delayMs)}`,
      delay: delayMs,
    });
  }

  async onModuleDestroy() {
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
    await this.conn.quit().catch(() => undefined);
  }
}
