import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Post } from '@nestjs/common';
import { companies, deals, memberships, offers, requests, reviews, type Db } from '@dominify/db';
import { OPEN_REQUEST_STATUSES, reviewSchema, type ReviewDto } from '@dominify/shared';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, type AuthUser } from '../auth/guards';
import { Analytics } from '../infra/infra.module';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

type Side = 'buyer' | 'supplier';

@Injectable()
export class DealsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeEmitter,
    private readonly analytics: Analytics,
  ) {}

  /** Покупатель выбирает исполнителя: создаётся сделка, остальные отклики отклоняются. */
  async choose(userId: number, offerId: number) {
    const [offer] = await this.db.select().from(offers).where(eq(offers.id, offerId));
    if (!offer) throw notFound('Отклик');
    const [req] = await this.db.select().from(requests).where(eq(requests.id, offer.requestId));
    if (req.authorUserId !== userId) throw forbidden('Это не ваша заявка');
    if (!(OPEN_REQUEST_STATUSES as string[]).includes(req.status)) throw new AppError('closed', 'Исполнитель уже выбран или заявка закрыта');
    if (offer.status !== 'sent') throw new AppError('bad_status', 'Отклик недоступен');

    const deal = await this.db.transaction(async (tx) => {
      await tx.update(offers).set({ status: 'chosen', updatedAt: new Date() }).where(eq(offers.id, offerId));
      await tx
        .update(offers)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(and(eq(offers.requestId, req.id), ne(offers.id, offerId), eq(offers.status, 'sent')));
      await tx.update(requests).set({ status: 'supplier_chosen', closedAt: new Date(), updatedAt: new Date() }).where(eq(requests.id, req.id));
      const [d] = await tx
        .insert(deals)
        .values({
          requestId: req.id,
          offerId,
          buyerUserId: userId,
          buyerCompanyId: req.buyerCompanyId,
          supplierCompanyId: offer.supplierCompanyId,
          amountUzs: offer.priceUzs,
        })
        .returning();
      return d;
    });

    // Контакты покупателя открываются выбранному поставщику только сейчас.
    const buyer = await this.users.byId(userId);
    const phone = this.users.phoneOf(buyer);
    const contact = [buyer.firstName, buyer.username ? `@${buyer.username}` : null, phone ? `+${phone}` : null].filter(Boolean).join(', ');
    await this.notifications.notifyCompany(offer.supplierCompanyId, 'chosen', { requestId: req.id, title: req.title, contact, dealId: deal.id }, { urgent: true });

    const others = await this.db
      .select({ companyId: offers.supplierCompanyId })
      .from(offers)
      .where(and(eq(offers.requestId, req.id), eq(offers.status, 'rejected')));
    for (const o of others) await this.notifications.notifyCompany(o.companyId, 'not_chosen', { requestId: req.id });

    this.realtime.toRequest(req.id, 'request.updated', { id: req.id, status: 'supplier_chosen' });
    this.analytics.track('deal.created', userId, { dealId: deal.id, requestId: req.id });
    return this.view(userId, deal.id);
  }

  private async sideOf(userId: number, deal: typeof deals.$inferSelect): Promise<Side | null> {
    if (deal.buyerUserId === userId) return 'buyer';
    const [m] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, deal.supplierCompanyId)));
    return m ? 'supplier' : null;
  }

  private async load(dealId: number) {
    const [d] = await this.db.select().from(deals).where(eq(deals.id, dealId));
    if (!d) throw notFound('Сделка');
    return d;
  }

  async view(userId: number, dealId: number) {
    const d = await this.load(dealId);
    const side = await this.sideOf(userId, d);
    if (!side) throw notFound('Сделка');
    const [req] = await this.db.select({ id: requests.id, title: requests.title, status: requests.status }).from(requests).where(eq(requests.id, d.requestId));
    const [supplier] = await this.db
      .select({ id: companies.id, name: companies.name, ratingAvg: companies.ratingAvg, trustLevel: companies.trustLevel })
      .from(companies)
      .where(eq(companies.id, d.supplierCompanyId));
    const [offer] = await this.db.select({ leadTimeDays: offers.leadTimeDays, comment: offers.comment }).from(offers).where(eq(offers.id, d.offerId));
    const myReview = await this.db.select().from(reviews).where(and(eq(reviews.dealId, dealId), eq(reviews.authorSide, side)));
    let buyer: { name: string | null; username: string | null; phone: string | null } | null = null;
    if (side === 'supplier') {
      const b = await this.users.byId(d.buyerUserId);
      const phone = this.users.phoneOf(b);
      buyer = { name: b.firstName, username: b.username, phone: phone ? `+${phone}` : null };
    }
    return {
      id: d.id,
      side,
      status: d.status,
      amountUzs: d.amountUzs,
      leadTimeDays: offer?.leadTimeDays,
      comment: offer?.comment,
      request: req,
      supplier,
      buyer,
      buyerConfirmed: !!d.buyerConfirmedAt,
      supplierConfirmed: !!d.supplierConfirmedAt,
      myReview: myReview[0] ?? null,
      createdAt: d.createdAt,
      completedAt: d.completedAt,
    };
  }

  async list(userId: number) {
    const myCompanies = (await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, userId))).map((m) => m.id);
    const rows = await this.db
      .select({
        id: deals.id,
        status: deals.status,
        amountUzs: deals.amountUzs,
        requestId: deals.requestId,
        title: requests.title,
        supplierName: companies.name,
        buyerUserId: deals.buyerUserId,
        createdAt: deals.createdAt,
      })
      .from(deals)
      .innerJoin(requests, eq(requests.id, deals.requestId))
      .innerJoin(companies, eq(companies.id, deals.supplierCompanyId))
      .where(or(eq(deals.buyerUserId, userId), myCompanies.length ? inArray(deals.supplierCompanyId, myCompanies) : sql`false`))
      .orderBy(desc(deals.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r, side: r.buyerUserId === userId ? 'buyer' : 'supplier' }));
  }

  /** Подтверждение выполнения. Когда подтвердили обе стороны, сделка закрыта и можно оставить отзыв. */
  async confirm(userId: number, dealId: number) {
    const d = await this.load(dealId);
    const side = await this.sideOf(userId, d);
    if (!side) throw notFound('Сделка');
    if (d.status !== 'active') throw new AppError('bad_status', 'Сделка уже закрыта');
    const now = new Date();
    const patch = side === 'buyer' ? { buyerConfirmedAt: d.buyerConfirmedAt ?? now } : { supplierConfirmedAt: d.supplierConfirmedAt ?? now };
    const bothDone = (side === 'buyer' ? true : !!d.buyerConfirmedAt) && (side === 'supplier' ? true : !!d.supplierConfirmedAt);

    await this.db.transaction(async (tx) => {
      await tx
        .update(deals)
        .set({ ...patch, ...(bothDone ? { status: 'completed', completedAt: now } : {}) })
        .where(eq(deals.id, dealId));
      if (bothDone) {
        await tx.update(requests).set({ status: 'completed', updatedAt: now }).where(eq(requests.id, d.requestId));
        await tx.update(companies).set({ dealsClosed: sql`${companies.dealsClosed} + 1` }).where(eq(companies.id, d.supplierCompanyId));
      }
    });

    if (bothDone) {
      await this.notifications.notify(d.buyerUserId, 'review_ask', { requestId: d.requestId, dealId });
      await this.notifications.notifyCompany(d.supplierCompanyId, 'review_ask', { requestId: d.requestId, dealId });
      await this.recomputeTrust(d.supplierCompanyId);
      this.analytics.track('deal.completed', userId, { dealId });
    } else if (side === 'buyer') {
      await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_confirm_other', { requestId: d.requestId, dealId });
    } else {
      await this.notifications.notify(d.buyerUserId, 'deal_confirm_other', { requestId: d.requestId, dealId });
    }
    return this.view(userId, dealId);
  }

  /** Отзыв только по закрытой сделке, один с каждой стороны. */
  async review(userId: number, dealId: number, dto: ReviewDto) {
    const d = await this.load(dealId);
    const side = await this.sideOf(userId, d);
    if (!side) throw notFound('Сделка');
    if (d.status !== 'completed') throw new AppError('not_completed', 'Отзыв можно оставить после подтверждения сделки обеими сторонами');
    const inserted = await this.db
      .insert(reviews)
      .values({
        dealId,
        authorUserId: userId,
        authorSide: side,
        targetCompanyId: side === 'buyer' ? d.supplierCompanyId : d.buyerCompanyId,
        targetUserId: side === 'supplier' ? d.buyerUserId : null,
        stars: dto.stars,
        text: dto.text ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) throw new AppError('already_reviewed', 'Вы уже оставили отзыв');
    if (side === 'buyer') await this.recomputeRating(d.supplierCompanyId);
    else if (d.buyerCompanyId) await this.recomputeRating(d.buyerCompanyId);

    const [{ c }] = await this.db.select({ c: sql<number>`count(*)::int` }).from(reviews).where(eq(reviews.dealId, dealId));
    if (c >= 2) await this.db.update(requests).set({ status: 'reviewed', updatedAt: new Date() }).where(eq(requests.id, d.requestId));
    return this.view(userId, dealId);
  }

  async recomputeRating(companyId: number) {
    await this.db.execute(sql`
      update companies set
        rating_avg = (select avg(stars)::real from reviews where target_company_id = ${companyId} and hidden = false),
        rating_count = (select count(*)::int from reviews where target_company_id = ${companyId} and hidden = false)
      where id = ${companyId}
    `);
    await this.recomputeTrust(companyId);
  }

  /** L1 — подтверждённый ИНН; L2 — ещё 5+ закрытых сделок и рейтинг от 4,5. L3 выставляется вручную по данным банка. */
  async recomputeTrust(companyId: number) {
    const [c] = await this.db.select().from(companies).where(eq(companies.id, companyId));
    if (!c || c.trustLevel >= 3) return;
    let level = c.innVerifiedAt ? 1 : 0;
    if (level === 1 && c.dealsClosed >= 5 && (c.ratingAvg ?? 0) >= 4.5) level = 2;
    if (level !== c.trustLevel) await this.db.update(companies).set({ trustLevel: level }).where(eq(companies.id, companyId));
  }
}

@Controller('v1')
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Post('offers/:id/choose')
  @HttpCode(HttpStatus.OK)
  choose(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.choose(u.id, id);
  }

  @Get('deals')
  list(@CurrentUser() u: AuthUser) {
    return this.deals.list(u.id);
  }

  @Get('deals/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.view(u.id, id);
  }

  @Post('deals/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.confirm(u.id, id);
  }

  @Post('deals/:id/review')
  review(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(reviewSchema)) dto: ReviewDto) {
    return this.deals.review(u.id, id, dto);
  }
}

