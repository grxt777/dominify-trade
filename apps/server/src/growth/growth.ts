import { Inject, Injectable, Logger } from '@nestjs/common';
import { deals, gigViews, requests, type Db } from '@dominify/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';

/** Пользователь, которому бот может писать: нажал «Старт», не заблокировал бота и не удалил аккаунт. */
const reachable = sql`u.bot_started and not u.bot_blocked and u.deleted_at is null`;

/**
 * Возврат покупателей: напоминания о просмотренной услуге и неотправленной заявке,
 * предложение заказать снова через месяц после закрытой сделки. Каждое — один раз, без спама.
 */
@Injectable()
export class GrowthService {
  private readonly log = new Logger('Growth');

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
  ) {}

  async sweep() {
    const viewed = await this.gigReminders();
    const drafts = await this.draftReminders();
    const reorders = await this.reorderNudges();
    if (viewed + drafts + reorders) this.log.log(`Напоминания: услуги ${viewed}, черновики ${drafts}, повторный заказ ${reorders}`);
    return { viewed, drafts, reorders };
  }

  /**
   * Смотрел услугу 20–72 часа назад и так и не заказал её. Одно напоминание о самой свежей такой услуге
   * и не чаще раза в неделю на человека.
   */
  async gigReminders(): Promise<number> {
    const r = await this.db.execute<{ user_id: number; gig_id: number; title: string; seller: string; packages: { priceUzs: number }[] }>(sql`
      select distinct on (v.user_id) v.user_id, v.gig_id, g.title, c.name as seller, g.packages
      from gig_views v
      join users u on u.id = v.user_id
      join gigs g on g.id = v.gig_id and g.active
      join companies c on c.id = g.company_id and not c.blocked
      where v.viewed_at between now() - interval '72 hours' and now() - interval '20 hours'
        and v.reminded_at is null
        and ${reachable}
        and not exists (select 1 from requests r where r.author_user_id = v.user_id and r.gig_id = v.gig_id)
        and not exists (select 1 from memberships m where m.user_id = v.user_id and m.company_id = g.company_id)
        and not exists (
          select 1 from notifications n
          where n.user_id = v.user_id and n.type = 'gig_reminder' and n.created_at > now() - interval '7 days')
      order by v.user_id, v.viewed_at desc
      limit 500`);
    for (const row of r.rows) {
      await this.db.update(gigViews).set({ remindedAt: new Date() }).where(and(eq(gigViews.userId, row.user_id), eq(gigViews.gigId, row.gig_id)));
      const prices = (row.packages ?? []).map((p) => p.priceUzs).filter((p) => p > 0);
      await this.notifications.notify(row.user_id, 'gig_reminder', {
        gigId: row.gig_id,
        title: row.title,
        seller: row.seller,
        price: prices.length ? Math.min(...prices) : null,
      });
    }
    return r.rows.length;
  }

  /** Заявка разобрана, но не отправлена исполнителям: напомнить через 3 часа, один раз. */
  async draftReminders(): Promise<number> {
    const r = await this.db.execute<{ id: number; author_user_id: number; title: string | null }>(sql`
      select q.id, q.author_user_id, q.title
      from requests q
      join users u on u.id = q.author_user_id
      where q.status in ('draft', 'needs_info')
        and q.title is not null
        and q.reminded_at is null
        and q.created_at between now() - interval '3 days' and now() - interval '3 hours'
        and ${reachable}
      limit 500`);
    if (!r.rows.length) return 0;
    await this.db
      .update(requests)
      .set({ remindedAt: new Date() })
      .where(inArray(requests.id, r.rows.map((x) => x.id)));
    for (const q of r.rows) await this.notifications.notify(q.author_user_id, 'draft_reminder', { requestId: q.id, title: q.title });
    return r.rows.length;
  }

  /** Через 30 дней после закрытой сделки — предложить заказать снова, если покупатель ещё не вернулся к этому исполнителю. */
  async reorderNudges(): Promise<number> {
    const r = await this.db.execute<{ id: number; buyer_user_id: number; title: string | null; seller: string; gig_id: number | null }>(sql`
      select d.id, d.buyer_user_id, q.title, c.name as seller,
        (select g.id from gigs g where g.id = q.gig_id and g.active) as gig_id
      from deals d
      join requests q on q.id = d.request_id
      join companies c on c.id = d.supplier_company_id and not c.blocked
      join users u on u.id = d.buyer_user_id
      where d.status = 'completed'
        and d.reorder_nudged_at is null
        and d.completed_at between now() - interval '45 days' and now() - interval '30 days'
        and ${reachable}
        and not exists (
          select 1 from deals d2
          where d2.id <> d.id and d2.buyer_user_id = d.buyer_user_id and d2.supplier_company_id = d.supplier_company_id
            and d2.created_at > d.completed_at and d2.status <> 'cancelled')
      limit 500`);
    if (!r.rows.length) return 0;
    await this.db
      .update(deals)
      .set({ reorderNudgedAt: new Date() })
      .where(inArray(deals.id, r.rows.map((x) => x.id)));
    for (const d of r.rows) {
      await this.notifications.notify(d.buyer_user_id, 'reorder_nudge', { dealId: d.id, title: d.title ?? '', seller: d.seller, gigId: d.gig_id });
    }
    return r.rows.length;
  }
}
