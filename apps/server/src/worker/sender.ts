import { Inject, Injectable, Logger } from '@nestjs/common';
import { notifications, users, type Db } from '@dominify/db';
import { pickLang, type Lang } from '@dominify/shared';
import { Api, GrammyError, InlineKeyboard } from 'grammy';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { render, type NotificationType } from '../notifications/templates';

export const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Пользовательский текст в payload экранируем: сообщения уходят с parse_mode HTML. */
function escapePayload(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? escapeHtml(v) : v]));
}

export class RateLimited extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Telegram 429, повтор через ${retryAfterSec} с`);
  }
}

/** Отправка уведомлений через Bot API. Вызывается воркером очереди notify. */
@Injectable()
export class NotificationSender {
  private readonly log = new Logger('Notify');
  private readonly api: Api;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly notifications: NotificationsService,
  ) {
    this.api = new Api(cfg.BOT_TOKEN);
  }

  miniAppUrl(route: string): string {
    return `${this.cfg.MINIAPP_URL.replace(/\/$/, '')}/?r=${encodeURIComponent(route)}`;
  }

  async send(notificationId: number): Promise<'sent' | 'skipped' | 'failed'> {
    const [n] = await this.db.select().from(notifications).where(eq(notifications.id, notificationId));
    if (!n || n.status !== 'queued') return 'skipped';
    const [u] = await this.db.select().from(users).where(eq(users.id, n.userId));
    const mark = (status: string, error?: string) =>
      this.db.update(notifications).set({ status, error: error ?? null, sentAt: status === 'sent' ? new Date() : null }).where(eq(notifications.id, n.id));

    if (!u || u.botBlocked || !u.botStarted) {
      await mark('skipped', u?.botBlocked ? 'bot_blocked' : 'bot_not_started');
      return 'skipped';
    }
    if (n.payload._respectOnline && (await this.notifications.isOnline(u.id))) {
      await mark('skipped', 'online');
      return 'skipped';
    }

    const lang = pickLang(u.lang) as Lang;
    const msg = render(n.type as NotificationType, escapePayload(n.payload), lang);
    const kb = new InlineKeyboard();
    for (const b of msg.buttons) {
      if (b.route) kb.webApp(b.text, this.miniAppUrl(b.route)).row();
      else if (b.callback) kb.text(b.text, b.callback).row();
    }

    if (this.cfg.NOTIFY_DRIVER === 'log') {
      this.log.log(`[${n.type}] → ${u.telegramId}: ${msg.text.replace(/\n/g, ' | ')}`);
      await mark('sent');
      return 'sent';
    }

    try {
      await this.api.sendMessage(u.telegramId, msg.text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: msg.buttons.length ? kb : undefined,
      });
      await mark('sent');
      return 'sent';
    } catch (e) {
      if (e instanceof GrammyError) {
        if (e.error_code === 403) {
          await this.db.update(users).set({ botBlocked: true }).where(eq(users.id, u.id));
          await mark('failed', 'bot_blocked');
          return 'failed';
        }
        if (e.error_code === 429) throw new RateLimited(e.parameters.retry_after ?? 5);
        if (e.error_code === 400) {
          await mark('failed', e.description);
          return 'failed';
        }
      }
      throw e;
    }
  }
}
