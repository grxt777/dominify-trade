import { Inject, Injectable } from '@nestjs/common';
import { memberships, notifications, type Db } from '@dominify/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import type { Config } from '../config';
import { QueueService } from '../infra/queues';
import { CONFIG, DB, REDIS } from '../infra/tokens';
import { nextAllowedTime, URGENT, type NotificationType } from './templates';

export interface NotifyOpts {
  delayMs?: number;
  /** Не слать в бот, если пользователь сейчас в Mini App. */
  respectOnline?: boolean;
  /** Игнорировать тихие часы. */
  urgent?: boolean;
}

/** Постановка уведомлений в очередь. Отправляет воркер через Bot API. */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly queues: QueueService,
  ) {}

  async notify(userId: number, type: NotificationType, payload: Record<string, unknown>, opts: NotifyOpts = {}): Promise<number> {
    const [n] = await this.db
      .insert(notifications)
      .values({ userId, type, payload: { ...payload, _respectOnline: !!opts.respectOnline } })
      .returning({ id: notifications.id });
    let at = new Date(Date.now() + (opts.delayMs ?? 0));
    if (!opts.urgent && !URGENT.includes(type)) {
      at = nextAllowedTime(at, this.cfg.TIMEZONE_OFFSET_MIN, this.cfg.QUIET_HOURS_START, this.cfg.QUIET_HOURS_END);
    }
    await this.queues.notify({ notificationId: n.id }, at.getTime() - Date.now());
    return n.id;
  }

  async notifyCompany(companyId: number, type: NotificationType, payload: Record<string, unknown>, opts: NotifyOpts = {}) {
    const rows = await this.db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.companyId, companyId));
    for (const r of rows) await this.notify(r.userId, type, payload, opts);
  }

  /**
   * Страховка на случай, когда запись уведомления создана, а задача в Redis не попала (сбой Redis, рестарт).
   * jobId у задачи фиксированный (n-<id>), поэтому для уже стоящих в очереди повторная постановка ничего не меняет.
   * Застрявшие дольше двух суток уже неактуальны и помечаются как failed.
   */
  async sweep(): Promise<{ requeued: number; expired: number }> {
    const expired = await this.db
      .update(notifications)
      .set({ status: 'failed', error: 'stale' })
      .where(and(eq(notifications.status, 'queued'), lt(notifications.createdAt, sql`now() - interval '2 days'`)))
      .returning({ id: notifications.id });
    const stuck = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, 'queued'), lt(notifications.createdAt, sql`now() - interval '10 minutes'`)))
      .orderBy(notifications.createdAt)
      .limit(500);
    for (const n of stuck) await this.queues.notify({ notificationId: n.id });
    return { requeued: stuck.length, expired: expired.length };
  }

  /** Все попытки отправки исчерпаны: уведомление больше не ждёт в статусе queued. */
  async markFailed(notificationId: number, error: string) {
    await this.db
      .update(notifications)
      .set({ status: 'failed', error: error.slice(0, 500) })
      .where(and(eq(notifications.id, notificationId), eq(notifications.status, 'queued')));
  }

  /** Пользователь сейчас в Mini App: сокет пингует ключ online:<id>. */
  async isOnline(userId: number): Promise<boolean> {
    return (await this.redis.exists(`online:${userId}`)) === 1;
  }

  async markOnline(userId: number): Promise<void> {
    await this.redis.set(`online:${userId}`, '1', 'EX', this.cfg.ONLINE_TTL_SEC);
  }
}
