import { Inject, Injectable } from '@nestjs/common';
import { memberships, notifications, type Db } from '@dominify/db';
import { eq } from 'drizzle-orm';
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

  /** Пользователь сейчас в Mini App: сокет пингует ключ online:<id>. */
  async isOnline(userId: number): Promise<boolean> {
    return (await this.redis.exists(`online:${userId}`)) === 1;
  }

  async markOnline(userId: number): Promise<void> {
    await this.redis.set(`online:${userId}`, '1', 'EX', this.cfg.ONLINE_TTL_SEC);
  }
}
