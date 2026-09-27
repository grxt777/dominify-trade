import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Post } from '@nestjs/common';
import { chats, companies, offers, requestDeliveries, requests, type Db } from '@dominify/db';
import { createOfferSchema, OPEN_REQUEST_STATUSES, PLANS, type CreateOfferDto } from '@dominify/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, type AuthUser } from '../auth/guards';
import { BillingService } from '../billing/billing.service';
import { Analytics } from '../infra/infra.module';
import { QueueService } from '../infra/queues';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestAccess } from '../requests/access';

@Injectable()
export class OffersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly access: RequestAccess,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeEmitter,
    private readonly queues: QueueService,
    private readonly analytics: Analytics,
  ) {}

  /** Отклик поставщика. Один отклик на компанию: повторный вызов обновляет цену и срок. */
  async create(userId: number, requestId: number, dto: CreateOfferDto) {
    const role = await this.access.roleOf(userId, requestId);
    if (!role || role.kind !== 'supplier') throw forbidden('Заявка вам не разослана');
    const companyId = role.companyId;
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!(OPEN_REQUEST_STATUSES as string[]).includes(req.status)) throw new AppError('closed', 'Заявка уже закрыта');
    const [company] = await this.db.select().from(companies).where(eq(companies.id, companyId));
    if (company.blocked) throw forbidden('Компания заблокирована');

    const [existing] = await this.db
      .select()
      .from(offers)
      .where(and(eq(offers.requestId, requestId), eq(offers.supplierCompanyId, companyId)));

    if (existing && existing.status === 'sent') {
      const [upd] = await this.db
        .update(offers)
        .set({ priceUzs: dto.priceUzs, leadTimeDays: dto.leadTimeDays, comment: dto.comment ?? null, fileIds: dto.fileIds, updatedAt: new Date() })
        .where(eq(offers.id, existing.id))
        .returning();
      this.realtime.toRequest(requestId, 'offer.updated', { requestId, offerId: upd.id });
      this.realtime.toUser(req.authorUserId, 'offer.updated', { requestId, offerId: upd.id });
      return upd;
    }
    if (existing) throw new AppError('offer_closed', 'Отклик уже нельзя изменить');

    // Лимит откликов по тарифу считается за календарный месяц.
    const plan = await this.billing.effectivePlan(companyId);
    const limit = PLANS[plan].offersPerMonth;
    if (limit !== null) {
      const used = await this.billing.offersThisMonth(companyId);
      if (used >= limit) {
        throw new AppError('plan_limit', `Лимит откликов на тарифе «${PLANS[plan].name.ru}» исчерпан: ${limit} в месяц. Чтобы расширить, свяжитесь с менеджером.`, HttpStatus.PAYMENT_REQUIRED);
      }
    }

    const hadOffers = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(offers)
      .where(and(eq(offers.requestId, requestId), ne(offers.status, 'withdrawn')));

    const offer = await this.db.transaction(async (tx) => {
      const [o] = await tx
        .insert(offers)
        .values({ requestId, supplierCompanyId: companyId, authorUserId: userId, priceUzs: dto.priceUzs, leadTimeDays: dto.leadTimeDays, comment: dto.comment ?? null, fileIds: dto.fileIds })
        .returning();
      await tx
        .update(requestDeliveries)
        .set({ respondedAt: new Date() })
        .where(and(eq(requestDeliveries.requestId, requestId), eq(requestDeliveries.supplierCompanyId, companyId)));
      await tx.update(companies).set({ offersSent: sql`${companies.offersSent} + 1` }).where(eq(companies.id, companyId));
      await tx.update(requests).set({ status: 'has_offers', updatedAt: new Date() }).where(eq(requests.id, requestId));
      await tx.insert(chats).values({ requestId, supplierCompanyId: companyId, buyerUserId: req.authorUserId }).onConflictDoNothing();
      return o;
    });

    // Первый отклик — сразу, остальные — сводкой раз в OFFER_DIGEST_MIN минут.
    if ((hadOffers[0]?.c ?? 0) === 0) {
      await this.notifications.notify(
        req.authorUserId,
        'new_offer',
        { requestId, priceUzs: dto.priceUzs, leadTimeDays: dto.leadTimeDays, supplierName: company.name },
        { respectOnline: true },
      );
    } else {
      await this.queues.offerDigest({ requestId }, this.cfg.OFFER_DIGEST_MIN * 60_000);
    }
    this.realtime.toRequest(requestId, 'offer.created', { requestId, offerId: offer.id });
    this.realtime.toUser(req.authorUserId, 'offer.created', { requestId, offerId: offer.id });
    this.analytics.track('offer.created', userId, { requestId, companyId, offerId: offer.id });
    return offer;
  }

  async withdraw(userId: number, offerId: number) {
    const [o] = await this.db.select().from(offers).where(eq(offers.id, offerId));
    if (!o) throw notFound('Отклик');
    const role = await this.access.roleOf(userId, o.requestId);
    if (!role || role.kind !== 'supplier' || role.companyId !== o.supplierCompanyId) throw forbidden();
    if (o.status !== 'sent') throw new AppError('bad_status', 'Отклик уже нельзя отозвать');
    await this.db.update(offers).set({ status: 'withdrawn', updatedAt: new Date() }).where(eq(offers.id, offerId));
    this.realtime.toRequest(o.requestId, 'offer.updated', { requestId: o.requestId, offerId });
    return { ok: true };
  }

  /** Отклики компании поставщика. */
  async mine(companyId: number) {
    return this.db
      .select({
        id: offers.id,
        requestId: offers.requestId,
        title: requests.title,
        requestStatus: requests.status,
        priceUzs: offers.priceUzs,
        leadTimeDays: offers.leadTimeDays,
        status: offers.status,
        createdAt: offers.createdAt,
      })
      .from(offers)
      .innerJoin(requests, eq(requests.id, offers.requestId))
      .where(eq(offers.supplierCompanyId, companyId))
      .orderBy(desc(offers.createdAt))
      .limit(100);
  }

  /** Сводка откликов для покупателя (задача offer-digest). */
  async digest(requestId: number) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req || !(OPEN_REQUEST_STATUSES as string[]).includes(req.status)) return;
    const [agg] = await this.db
      .select({ c: sql<number>`count(*)::int`, best: sql<number>`min(${offers.priceUzs})::bigint` })
      .from(offers)
      .where(and(eq(offers.requestId, requestId), eq(offers.status, 'sent')));
    if (!agg || agg.c <= 1) return;
    await this.notifications.notify(req.authorUserId, 'offer_digest', { requestId, count: agg.c, bestPrice: Number(agg.best) }, { respectOnline: true });
  }
}

@Controller('v1')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Post('requests/:id/offers')
  create(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(createOfferSchema)) dto: CreateOfferDto) {
    return this.offers.create(u.id, id, dto);
  }

  @Post('offers/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.offers.withdraw(u.id, id);
  }

  @Get('offers')
  mine(@CurrentUser() u: AuthUser) {
    if (!u.activeCompanyId) throw new AppError('no_company', 'Нет активной компании');
    return this.offers.mine(u.activeCompanyId);
  }
}

