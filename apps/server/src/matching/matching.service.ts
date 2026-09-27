import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  companies,
  memberships,
  moderationItems,
  offers,
  requestDeliveries,
  requests,
  serviceAreas,
  subscriptions,
  supplierCategories,
  type Db,
} from '@dominify/db';
import {
  DEFAULT_WAVES,
  needsSecondWave,
  OPEN_REQUEST_STATUSES,
  pickLang,
  pickWave,
  PLANS,
  rootRegion,
  type Candidate,
  type Lang,
  type PlanCode,
} from '@dominify/shared';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { CatalogService } from '../catalog/catalog';
import { Analytics } from '../infra/infra.module';
import { QueueService } from '../infra/queues';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { summarize } from '../requests/summary';

/** Подбор поставщиков и рассылка заявки волнами. */
@Injectable()
export class MatchingService {
  private readonly log = new Logger('Matching');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly catalog: CatalogService,
    private readonly queues: QueueService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeEmitter,
    private readonly analytics: Analytics,
  ) {}

  /** Кандидаты: поставщики категории заявки или её вертикали, не сама компания покупателя. */
  async candidates(requestId: number): Promise<{ candidates: Candidate[]; delays: Map<number, number> }> {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req?.categoryId) return { candidates: [], delays: new Map() };
    const vertical = await this.catalog.rootOf(req.categoryId);
    const catIds = [req.categoryId, vertical];

    // Компании автора заявки исключаем: нельзя откликаться на свою заявку.
    const authorCompanies = (
      await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, req.authorUserId))
    ).map((r) => r.id);

    const rows = await this.db
      .select({
        id: companies.id,
        deliversNationwide: companies.deliversNationwide,
        ratingAvg: companies.ratingAvg,
        ratingCount: companies.ratingCount,
        dealsClosed: companies.dealsClosed,
        offersSent: companies.offersSent,
        medianResponseMin: companies.medianResponseMin,
        createdAt: companies.createdAt,
        planCode: subscriptions.planCode,
        planStatus: subscriptions.status,
        exact: sql<boolean>`bool_or(${supplierCategories.categoryId} = ${req.categoryId})`,
      })
      .from(companies)
      .innerJoin(supplierCategories, eq(supplierCategories.companyId, companies.id))
      .leftJoin(subscriptions, eq(subscriptions.companyId, companies.id))
      .where(
        and(
          eq(companies.isSupplier, true),
          eq(companies.blocked, false),
          inArray(supplierCategories.categoryId, catIds),
          authorCompanies.length ? notInArray(companies.id, authorCompanies) : undefined,
        ),
      )
      .groupBy(companies.id, subscriptions.planCode, subscriptions.status);

    if (!rows.length) return { candidates: [], delays: new Map() };
    const ids = rows.map((r) => r.id);

    const region = req.regionCode ?? 'tashkent';
    const areaRows = await this.db
      .select({ companyId: serviceAreas.companyId })
      .from(serviceAreas)
      .where(and(inArray(serviceAreas.companyId, ids), inArray(serviceAreas.regionCode, [region, rootRegion(region)])));
    const serves = new Set(areaRows.map((a) => a.companyId));

    const today = await this.db
      .select({ companyId: requestDeliveries.supplierCompanyId, c: sql<number>`count(*)::int` })
      .from(requestDeliveries)
      .where(and(inArray(requestDeliveries.supplierCompanyId, ids), sql`${requestDeliveries.createdAt} > now() - interval '24 hours'`))
      .groupBy(requestDeliveries.supplierCompanyId);
    const todayMap = new Map(today.map((t) => [t.companyId, t.c]));

    const delays = new Map<number, number>();
    const candidates: Candidate[] = rows.map((r) => {
      const plan: PlanCode = r.planStatus === 'expired' || !r.planCode ? 'free' : (r.planCode as PlanCode);
      delays.set(r.id, PLANS[plan].notifyDelayMin);
      return {
        companyId: r.id,
        exactCategory: !!r.exact,
        servesRegion: serves.has(r.id),
        deliversNationwide: r.deliversNationwide,
        ratingAvg: r.ratingAvg,
        ratingCount: r.ratingCount,
        dealsClosed: r.dealsClosed,
        offersSent: r.offersSent,
        medianResponseMin: r.medianResponseMin,
        planPriority: PLANS[plan].priority,
        createdAt: r.createdAt,
        deliveriesToday: todayMap.get(r.id) ?? 0,
      };
    });
    return { candidates, delays };
  }

  /** Разослать волну. Вызывается воркером из очереди matching. */
  async dispatch(requestId: number, wave: number): Promise<number> {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req || !(OPEN_REQUEST_STATUSES as string[]).includes(req.status)) return 0;
    if (req.wave >= wave) return 0; // волна уже была: повтор задачи не шлёт дубли

    const sent = await this.db
      .select({ id: requestDeliveries.supplierCompanyId })
      .from(requestDeliveries)
      .where(eq(requestDeliveries.requestId, requestId));
    const { candidates, delays } = await this.candidates(requestId);
    const size = wave === 1 ? DEFAULT_WAVES.wave1Size : DEFAULT_WAVES.wave2Size;
    const picked = pickWave(candidates, new Set(sent.map((s) => s.id)), size, new Date());

    const nextStatus = req.status === 'has_offers' ? 'has_offers' : wave === 1 ? 'wave_1' : 'wave_2';
    await this.db.update(requests).set({ wave, status: nextStatus, updatedAt: new Date() }).where(eq(requests.id, requestId));

    if (!picked.length) {
      if (wave === 1 || sent.length === 0) await this.toManual(requestId, 'request_no_suppliers', 'Нет подходящих поставщиков');
      this.log.log(`Заявка ${requestId}: волна ${wave} пустая`);
      return 0;
    }

    await this.deliver(req, picked.map((p) => ({ companyId: p.companyId, score: p.score, delayMin: delays.get(p.companyId) ?? 0 })), wave, false);

    if (wave === 1) await this.queues.checkWave({ requestId }, this.cfg.WAVE1_WAIT_MIN * 60_000);
    else await this.queues.queues.matching.add('check-final', { requestId }, { jobId: `final-${requestId}`, delay: this.cfg.WAVE1_WAIT_MIN * 60_000 });
    this.analytics.track('request.dispatched', null, { requestId, wave, count: picked.length });
    return picked.length;
  }

  /** Записи о рассылке и уведомления поставщикам. */
  private async deliver(
    req: typeof requests.$inferSelect,
    list: { companyId: number; score: number; delayMin: number }[],
    wave: number,
    manual: boolean,
  ) {
    const now = Date.now();
    const inserted = await this.db
      .insert(requestDeliveries)
      .values(
        list.map((p) => ({
          requestId: req.id,
          supplierCompanyId: p.companyId,
          wave,
          score: p.score,
          manual,
          notifyAt: new Date(now + p.delayMin * 60_000),
        })),
      )
      .onConflictDoNothing()
      .returning();

    const defs = req.categoryId ? await this.catalog.fieldsFor(req.categoryId) : [];
    for (const d of inserted) {
      const members = await this.db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.companyId, d.supplierCompanyId));
      for (const m of members) {
        const lang = (await this.langOf(m.userId)) as Lang;
        await this.notifications.notify(
          m.userId,
          'new_request',
          { requestId: req.id, title: req.title, summary: summarize(req, defs, lang), deliveryId: d.id },
          { delayMs: d.notifyAt.getTime() - now },
        );
      }
      await this.db.update(requestDeliveries).set({ sentAt: new Date() }).where(eq(requestDeliveries.id, d.id));
      this.realtime.toCompany(d.supplierCompanyId, 'feed.updated', { requestId: req.id });
    }
    return inserted.length;
  }

  private async langOf(userId: number): Promise<string> {
    const r = await this.db.execute(sql`select lang from users where id = ${userId}`);
    return pickLang((r.rows[0] as { lang?: string } | undefined)?.lang);
  }

  /** Через 30 минут после первой волны: мало откликов — вторая волна. */
  async checkWave(requestId: number) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req || !(OPEN_REQUEST_STATUSES as string[]).includes(req.status) || req.wave !== 1) return;
    const [{ c }] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(offers)
      .where(and(eq(offers.requestId, requestId), ne(offers.status, 'withdrawn')));
    if (needsSecondWave(c)) await this.dispatch(requestId, 2);
  }

  /** После второй волны тишина: заявку подбирают руками из админки. */
  async checkFinal(requestId: number) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req || !(OPEN_REQUEST_STATUSES as string[]).includes(req.status)) return;
    const [{ c }] = await this.db.select({ c: sql<number>`count(*)::int` }).from(offers).where(eq(offers.requestId, requestId));
    if (c === 0) await this.toManual(requestId, 'request_no_offers', 'Нет откликов после двух волн');
  }

  private async toManual(requestId: number, kind: string, note: string) {
    const [open] = await this.db
      .select({ id: moderationItems.id })
      .from(moderationItems)
      .where(and(eq(moderationItems.refId, requestId), eq(moderationItems.kind, kind), eq(moderationItems.status, 'open')));
    if (!open) await this.db.insert(moderationItems).values({ kind, refType: 'request', refId: requestId, note });
  }

  /** Ручная рассылка из админки: выбранным компаниям, без задержки тарифа. */
  async manualDispatch(requestId: number, companyIds: number[]): Promise<number> {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req) return 0;
    if (req.status === 'moderation' || req.status === 'submitted') {
      await this.db.update(requests).set({ status: 'wave_1', wave: Math.max(1, req.wave), updatedAt: new Date() }).where(eq(requests.id, requestId));
    }
    const valid = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(inArray(companies.id, companyIds), eq(companies.isSupplier, true), eq(companies.blocked, false)));
    return this.deliver(req, valid.map((v) => ({ companyId: v.id, score: 0, delayMin: 0 })), Math.max(1, req.wave), true);
  }

  /** Напоминание поставщикам, которые открыли заявку и молчат больше часа. */
  async remindSilent(): Promise<number> {
    const rows = await this.db
      .select({ id: requestDeliveries.id, companyId: requestDeliveries.supplierCompanyId, requestId: requests.id, title: requests.title })
      .from(requestDeliveries)
      .innerJoin(requests, eq(requests.id, requestDeliveries.requestId))
      .where(
        and(
          inArray(requests.status, OPEN_REQUEST_STATUSES),
          sql`${requestDeliveries.seenAt} < now() - (${this.cfg.SUPPLIER_REMIND_MIN} || ' minutes')::interval`,
          sql`${requestDeliveries.respondedAt} is null`,
          sql`${requestDeliveries.remindedAt} is null`,
        ),
      )
      .limit(500);
    for (const r of rows) {
      await this.db.update(requestDeliveries).set({ remindedAt: new Date() }).where(eq(requestDeliveries.id, r.id));
      await this.notifications.notifyCompany(r.companyId, 'supplier_reminder', { requestId: r.requestId, title: r.title });
    }
    return rows.length;
  }

  /** Ночной пересчёт медианного времени ответа за 30 дней. */
  async recomputeResponseTimes(): Promise<void> {
    await this.db.execute(sql`
      update companies c set median_response_min = s.med
      from (
        select supplier_company_id as cid,
               percentile_cont(0.5) within group (order by extract(epoch from (responded_at - notify_at)) / 60)::int as med
        from request_deliveries
        where responded_at is not null and created_at > now() - interval '30 days'
        group by supplier_company_id
      ) s
      where c.id = s.cid
    `);
  }
}
