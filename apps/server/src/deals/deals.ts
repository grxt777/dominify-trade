import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Post } from '@nestjs/common';
import { auditLog, companies, deals, gigs, invoices, memberships, moderationItems, offers, requests, reviews, users, type Db } from '@dominify/db';
import { formatUzs, OPEN_REQUEST_STATUSES, reviewSchema, type ReviewDto } from '@dominify/shared';
import { and, desc, eq, gte, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import { BillingService } from '../billing/billing.service';
import { maskContacts } from '../common/contacts';
import { randomToken } from '../common/crypto';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, RateLimit, type AuthUser } from '../auth/guards';
import { Analytics } from '../infra/infra.module';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';
import { decideReview, MODERATED_FLAGS } from './review-signals';

type Side = 'buyer' | 'supplier';
type Deal = typeof deals.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const dealReasonSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export type DealReasonDto = z.infer<typeof dealReasonSchema>;

export const resolveDealSchema = z.object({
  outcome: z.enum(['complete', 'cancel', 'resume']),
  note: z.string().trim().max(1000).optional(),
});
export type ResolveDealDto = z.infer<typeof resolveDealSchema>;

/** После отмены сделки заявка снова открыта хотя бы столько дней, чтобы покупатель успел выбрать другого. */
const REOPEN_MIN_DAYS = 3;
const OUTCOME_TEXT: Record<ResolveDealDto['outcome'], string> = {
  complete: 'сделка закрыта как выполненная',
  cancel: 'сделка отменена, заявка снова открыта',
  resume: 'сделка продолжается',
};

@Injectable()
export class DealsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeEmitter,
    private readonly analytics: Analytics,
    private readonly billing: BillingService,
  ) {}

  /** Покупатель выбирает исполнителя: создаётся сделка, остальные отклики отклоняются. */
  async choose(userId: number, offerId: number) {
    const [offer0] = await this.db.select().from(offers).where(eq(offers.id, offerId));
    if (!offer0) throw notFound('Отклик');
    const [req0] = await this.db.select().from(requests).where(eq(requests.id, offer0.requestId));
    if (req0.authorUserId !== userId) throw forbidden('Это не ваша заявка');
    const [selfMember] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, offer0.supplierCompanyId)));
    if (selfMember) throw new AppError('self_deal', 'Нельзя выбрать исполнителем собственную компанию', HttpStatus.FORBIDDEN);

    const { deal, req, offer } = await this.db.transaction(async (tx) => {
      // Блокировка заявки: два одновременных выбора не создадут две сделки и не перезапишут статусы друг друга.
      const [req] = await tx.select().from(requests).where(eq(requests.id, offer0.requestId)).for('update');
      if (!(OPEN_REQUEST_STATUSES as string[]).includes(req.status)) throw new AppError('closed', 'Исполнитель уже выбран или заявка закрыта');
      const [offer] = await tx.select().from(offers).where(eq(offers.id, offerId));
      if (offer.status !== 'sent') throw new AppError('bad_status', 'Отклик недоступен');

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
      return { deal: d, req, offer };
    });

    // Контакты покупателя открываются выбранному поставщику только сейчас.
    const buyer = await this.users.byId(userId);
    const phone = this.users.phoneOf(buyer);
    const contact = [buyer.firstName, buyer.username ? `@${buyer.username}` : null, phone ? `+${phone}` : null].filter(Boolean).join(', ');
    await this.notifications.notifyCompany(offer.supplierCompanyId, 'chosen', { requestId: req.id, title: req.title, contact, dealId: deal.id }, { urgent: true });

    const others = await this.db
      .select({ companyId: offers.supplierCompanyId })
      .from(offers)
      .where(and(eq(offers.requestId, req.id), eq(offers.status, 'rejected'), ne(offers.supplierCompanyId, offer.supplierCompanyId)));
    for (const o of others) await this.notifications.notifyCompany(o.companyId, 'not_chosen', { requestId: req.id });

    this.realtime.toRequest(req.id, 'request.updated', { id: req.id, status: 'supplier_chosen' });
    this.analytics.track('deal.created', userId, { dealId: deal.id, requestId: req.id });
    return this.view(userId, deal.id);
  }

  private async sideOf(userId: number, deal: Deal): Promise<Side | null> {
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

  private async loadForSide(userId: number, dealId: number) {
    const d = await this.load(dealId);
    const side = await this.sideOf(userId, d);
    if (!side) throw notFound('Сделка');
    return { d, side };
  }

  /**
   * Сколько покупатель заплатит за заказ: скидка на первый заказ (по номеру телефона, а не аккаунту —
   * иначе её получали бы с каждого нового аккаунта) и бонусы, но не больше BONUS_MAX_SHARE_PERCENT заказа.
   */
  private async quote(db: Db | Tx, userId: number, d: Deal) {
    const [u] = await db.select({ phoneHash: users.phoneHash, phoneVerifiedAt: users.phoneVerifiedAt, bonusUzs: users.bonusUzs }).from(users).where(eq(users.id, userId));
    let firstOrder = false;
    if (u?.phoneHash && u.phoneVerifiedAt && this.cfg.FIRST_ORDER_DISCOUNT_PERCENT > 0) {
      const r = await db.execute(sql`
        select 1 from invoices i
        join deals dd on dd.id = i.deal_id
        join users bu on bu.id = dd.buyer_user_id
        where i.kind = 'deal' and i.status <> 'cancelled' and dd.id <> ${d.id}
          and (bu.phone_hash = ${u.phoneHash} or dd.buyer_user_id = ${userId})
        limit 1`);
      firstOrder = r.rows.length === 0;
    }
    // Payme и Click не принимают платежи меньше 1000 сум.
    const room = Math.max(0, d.amountUzs - Math.min(d.amountUzs, 1000));
    const discountUzs = firstOrder
      ? Math.min(Math.round((d.amountUzs * this.cfg.FIRST_ORDER_DISCOUNT_PERCENT) / 100), this.cfg.FIRST_ORDER_DISCOUNT_MAX_UZS, room)
      : 0;
    const bonusCap = Math.floor(((d.amountUzs - discountUzs) * this.cfg.BONUS_MAX_SHARE_PERCENT) / 100);
    const bonusUzs = Math.max(0, Math.min(u?.bonusUzs ?? 0, bonusCap, room - discountUzs));
    return { firstOrder, phoneNeeded: !u?.phoneVerifiedAt, discountUzs, bonusUzs, payUzs: d.amountUzs - discountUzs - bonusUzs };
  }

  /** Покупатель оплачивает заказ через безопасную сделку: деньги ждут у платформы, пока он не примет работу. */
  async pay(userId: number, dealId: number) {
    const { d, side } = await this.loadForSide(userId, dealId);
    if (side !== 'buyer') throw forbidden('Заказ оплачивает покупатель');
    if (d.status !== 'active') throw new AppError('bad_status', 'Оплатить можно только сделку в работе');
    const inv = await this.db.transaction(async (tx) => {
      // Строка покупателя блокируется: два параллельных счёта не потратят одни и те же бонусы дважды.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).for('update');
      if (deal.status !== 'active') throw new AppError('bad_status', 'Оплатить можно только сделку в работе');
      const [open] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.dealId, dealId), eq(invoices.kind, 'deal'), ne(invoices.status, 'cancelled')));
      if (open?.status === 'paid' || !['none', 'awaiting'].includes(deal.paymentStatus)) throw new AppError('already_paid', 'Заказ уже оплачен');
      if (open) return open;
      const q = await this.quote(tx, userId, deal);
      if (q.bonusUzs > 0) {
        await tx.update(users).set({ bonusUzs: sql`${users.bonusUzs} - ${q.bonusUzs}` }).where(eq(users.id, userId));
      }
      const [created] = await tx
        .insert(invoices)
        .values({
          kind: 'deal',
          companyId: deal.supplierCompanyId,
          dealId,
          amountUzs: q.payUzs,
          discountUzs: q.discountUzs,
          bonusUzs: q.bonusUzs,
          payToken: randomToken(18),
        })
        .returning();
      await tx.update(deals).set({ paymentStatus: 'awaiting' }).where(eq(deals.id, dealId));
      return created;
    });
    this.analytics.track('deal.pay_started', userId, { dealId, amountUzs: inv.amountUzs });
    return { payUrl: `${this.cfg.PUBLIC_API_URL}/pay/${inv.payToken}`, amountUzs: inv.amountUzs, discountUzs: inv.discountUzs, bonusUzs: inv.bonusUzs };
  }

  /** Неоплаченный счёт по сделке, которая закрылась без онлайн-оплаты, отменяется, бонусы возвращаются. */
  private async dropOpenInvoiceTx(tx: Tx, d: Deal) {
    const [open] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.dealId, d.id), eq(invoices.kind, 'deal'), eq(invoices.status, 'issued')))
      .for('update');
    if (open) await this.billing.cancelDealInvoiceTx(tx, open, d.buyerUserId);
  }

  private async settleOnCloseTx(tx: Tx, d: Deal, outcome: 'complete' | 'cancel') {
    const [cur] = await tx.select({ paymentStatus: deals.paymentStatus }).from(deals).where(eq(deals.id, d.id));
    if (cur.paymentStatus === 'held') {
      await tx.update(deals).set({ paymentStatus: outcome === 'complete' ? 'payout_due' : 'refund_due' }).where(eq(deals.id, d.id));
    } else if (cur.paymentStatus === 'awaiting' || cur.paymentStatus === 'none') {
      await this.dropOpenInvoiceTx(tx, d);
      await tx.update(deals).set({ paymentStatus: 'none' }).where(eq(deals.id, d.id));
    }
    return cur.paymentStatus;
  }

  /** Админ отметил выплату исполнителю или возврат покупателю по выписке банка. */
  async settle(staffUserId: number, dealId: number, action: 'payout' | 'refund') {
    const from = action === 'payout' ? 'payout_due' : 'refund_due';
    const d = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deals).where(eq(deals.id, dealId)).for('update');
      if (!d) throw notFound('Сделка');
      if (d.paymentStatus !== from) throw new AppError('bad_status', action === 'payout' ? 'Выплата по сделке не ожидается' : 'Возврат по сделке не ожидается');
      await tx
        .update(deals)
        .set({ paymentStatus: action === 'payout' ? 'paid_out' : 'refunded', settledAt: new Date() })
        .where(eq(deals.id, dealId));
      await tx.insert(auditLog).values({ staffUserId, action: `escrow.${action}`, refType: 'deal', refId: dealId, data: {} });
      return d;
    });
    const payload = { dealId, requestId: d.requestId, payout: formatUzs(d.amountUzs - d.feeUzs) };
    if (action === 'payout') await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_payout_sent', payload);
    else await this.notifications.notify(d.buyerUserId, 'deal_refund_sent', payload);
    return this.load(dealId);
  }

  async escrowList(status: string) {
    const statuses = status === 'all' ? ['awaiting', 'held', 'payout_due', 'refund_due', 'paid_out', 'refunded'] : [status];
    return this.db
      .select({
        id: deals.id,
        requestId: deals.requestId,
        title: requests.title,
        status: deals.status,
        paymentStatus: deals.paymentStatus,
        amountUzs: deals.amountUzs,
        feeUzs: deals.feeUzs,
        paidAt: deals.paidAt,
        settledAt: deals.settledAt,
        supplierCompanyId: deals.supplierCompanyId,
        supplierName: companies.name,
        buyer: users.firstName,
        paidUzs: sql<number | null>`(select amount_uzs from invoices i where i.deal_id = ${deals.id} and i.kind = 'deal' and i.status = 'paid' limit 1)`.mapWith(Number),
        paidVia: sql<string | null>`(select paid_via from invoices i where i.deal_id = ${deals.id} and i.kind = 'deal' and i.status = 'paid' limit 1)`,
      })
      .from(deals)
      .innerJoin(requests, eq(requests.id, deals.requestId))
      .innerJoin(companies, eq(companies.id, deals.supplierCompanyId))
      .innerJoin(users, eq(users.id, deals.buyerUserId))
      .where(inArray(deals.paymentStatus, statuses))
      .orderBy(desc(deals.paidAt))
      .limit(200);
  }

  async view(userId: number, dealId: number) {
    const { d, side } = await this.loadForSide(userId, dealId);
    const [req] = await this.db
      .select({ id: requests.id, title: requests.title, status: requests.status, gigId: requests.gigId })
      .from(requests)
      .where(eq(requests.id, d.requestId));
    const [supplier] = await this.db
      .select({
        id: companies.id,
        name: companies.name,
        ratingAvg: companies.ratingAvg,
        trustLevel: companies.trustLevel,
        innVerified: sql<boolean>`${companies.innVerifiedAt} is not null`,
      })
      .from(companies)
      .where(eq(companies.id, d.supplierCompanyId));
    const payment = await this.paymentView(userId, side, d);
    const [offer] = await this.db.select({ leadTimeDays: offers.leadTimeDays, comment: offers.comment }).from(offers).where(eq(offers.id, d.offerId));
    const myReview = await this.db.select().from(reviews).where(and(eq(reviews.dealId, dealId), eq(reviews.authorSide, side)));
    let buyer: { name: string | null; username: string | null; phone: string | null } | null = null;
    // После отмены сделки контакт покупателя у бывшего исполнителя больше не показываем.
    if (side === 'supplier' && d.status !== 'cancelled') {
      const b = await this.users.byId(d.buyerUserId);
      const phone = this.users.phoneOf(b);
      buyer = { name: b.firstName, username: b.username, phone: phone ? `+${phone}` : null };
    }
    const otherConfirmed = side === 'buyer' ? !!d.supplierConfirmedAt : !!d.buyerConfirmedAt;
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
      payment,
      buyerConfirmed: !!d.buyerConfirmedAt,
      supplierConfirmed: !!d.supplierConfirmedAt,
      myReview: myReview[0] ?? null,
      closedBy: d.closedBy,
      closeReason: d.closeReason,
      cancelledAt: d.cancelledAt,
      disputedAt: d.disputedAt,
      canCancel: d.status === 'active' && !otherConfirmed && !(side === 'buyer' && d.paymentStatus === 'held'),
      canDispute: d.status === 'active',
      createdAt: d.createdAt,
      completedAt: d.completedAt,
    };
  }

  private async paymentView(userId: number, side: Side, d: Deal) {
    const [inv] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.dealId, d.id), eq(invoices.kind, 'deal'), ne(invoices.status, 'cancelled')));
    const base = {
      status: d.paymentStatus,
      feePercent: this.cfg.ESCROW_FEE_PERCENT,
      feeUzs: d.feeUzs || Math.round((d.amountUzs * this.cfg.ESCROW_FEE_PERCENT) / 100),
      paidAt: d.paidAt,
      settledAt: d.settledAt,
    };
    if (side === 'supplier') return { ...base, payoutUzs: d.amountUzs - base.feeUzs };
    const quote = d.status === 'active' && d.paymentStatus === 'none' ? await this.quote(this.db, userId, d) : null;
    return {
      ...base,
      quote,
      paidUzs: inv?.amountUzs ?? null,
      discountUzs: inv?.discountUzs ?? 0,
      bonusUzs: inv?.bonusUzs ?? 0,
      payUrl: inv?.status === 'issued' ? `${this.cfg.PUBLIC_API_URL}/pay/${inv.payToken}` : null,
    };
  }

  async list(userId: number) {
    const myCompanies = (await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, userId))).map((m) => m.id);
    const rows = await this.db
      .select({
        id: deals.id,
        status: deals.status,
        paymentStatus: deals.paymentStatus,
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
    const { side } = await this.loadForSide(userId, dealId);
    const now = new Date();

    // Строка сделки блокируется: при одновременном подтверждении обеими сторонами вторая транзакция
    // увидит отметку первой и закроет сделку, а не оставит её «подтверждённой наполовину».
    const { d, bothDone } = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deals).where(eq(deals.id, dealId)).for('update');
      if (d.status !== 'active') throw new AppError('bad_status', 'Сделка уже закрыта');
      const buyerAt = side === 'buyer' ? (d.buyerConfirmedAt ?? now) : d.buyerConfirmedAt;
      const supplierAt = side === 'supplier' ? (d.supplierConfirmedAt ?? now) : d.supplierConfirmedAt;
      const bothDone = !!buyerAt && !!supplierAt;
      await tx
        .update(deals)
        .set({ buyerConfirmedAt: buyerAt, supplierConfirmedAt: supplierAt })
        .where(eq(deals.id, dealId));
      if (bothDone) await this.completeTx(tx, d, now, null);
      return { d, bothDone };
    });

    if (bothDone) {
      await this.afterComplete(d, userId);
    } else if (side === 'buyer') {
      await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_confirm_other', { requestId: d.requestId, dealId });
    } else {
      await this.notifications.notify(d.buyerUserId, 'deal_confirm_other', { requestId: d.requestId, dealId });
    }
    this.realtime.toUser(d.buyerUserId, 'deal.updated', { id: dealId });
    return this.view(userId, dealId);
  }

  private async completeTx(tx: Tx, d: Deal, now: Date, closedBy: string | null) {
    await this.settleOnCloseTx(tx, d, 'complete');
    await tx.update(deals).set({ status: 'completed', completedAt: now, closedBy }).where(eq(deals.id, d.id));
    await tx.update(requests).set({ status: 'completed', updatedAt: now }).where(eq(requests.id, d.requestId));
    await tx.update(companies).set({ dealsClosed: sql`${companies.dealsClosed} + 1` }).where(eq(companies.id, d.supplierCompanyId));
    // Счётчик услуги растёт, только если выполнил именно тот, у кого заказали с витрины.
    await tx
      .update(gigs)
      .set({ ordersCount: sql`${gigs.ordersCount} + 1` })
      .where(and(eq(gigs.companyId, d.supplierCompanyId), sql`${gigs.id} = (select gig_id from requests where id = ${d.requestId})`));
  }

  private async afterComplete(d0: Deal, actorUserId: number | null) {
    const d = await this.load(d0.id);
    await this.notifications.notify(d.buyerUserId, 'review_ask', { requestId: d.requestId, dealId: d.id });
    await this.notifications.notifyCompany(d.supplierCompanyId, 'review_ask', { requestId: d.requestId, dealId: d.id });
    if (d.paymentStatus === 'payout_due') {
      await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_payout_due', { dealId: d.id, requestId: d.requestId, payout: formatUzs(d.amountUzs - d.feeUzs) });
    }
    // Бонус пригласившему — только за реально оплаченный через платформу заказ, иначе его «накручивают» фиктивными сделками.
    if (d.paidAt) {
      const reward = await this.users.rewardReferrer(d.buyerUserId, this.cfg.REFERRAL_BONUS_UZS);
      if (reward) await this.notifications.notify(reward.referrerUserId, 'referral_reward', { bonus: formatUzs(this.cfg.REFERRAL_BONUS_UZS), name: reward.friendName ?? '' });
    }
    await this.recomputeTrust(d.supplierCompanyId);
    this.analytics.track('deal.completed', actorUserId, { dealId: d.id });
  }

  /**
   * Отмена активной сделки любой стороной. Если другая сторона уже отметила выполнение, отменить нельзя —
   * только открыть спор: иначе покупатель мог бы «отменить» уже сделанную работу.
   * Заявка снова открывается, отклонённые при выборе отклики возвращаются в работу.
   */
  async cancel(userId: number, dealId: number, reason: string) {
    const { side } = await this.loadForSide(userId, dealId);
    const d = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deals).where(eq(deals.id, dealId)).for('update');
      if (d.status !== 'active') throw new AppError('bad_status', 'Сделку уже нельзя отменить');
      const otherConfirmed = side === 'buyer' ? !!d.supplierConfirmedAt : !!d.buyerConfirmedAt;
      if (otherConfirmed) {
        throw new AppError('other_confirmed', 'Другая сторона уже отметила сделку выполненной. Если есть разногласия, откройте спор.', HttpStatus.CONFLICT);
      }
      // Исполнитель начал работу под гарантию оплаты: вернуть деньги в одностороннем порядке покупатель не может.
      if (side === 'buyer' && d.paymentStatus === 'held') {
        throw new AppError('paid_use_dispute', 'Заказ оплачен. Если исполнитель не выполняет работу, откройте спор — модератор вернёт деньги.', HttpStatus.CONFLICT);
      }
      await this.cancelTx(tx, d, side, maskContacts(reason).text);
      return d;
    });
    await this.afterCancel(d, side, reason);
    this.analytics.track('deal.cancelled', userId, { dealId, side });
    return this.view(userId, dealId);
  }

  private async cancelTx(tx: Tx, d: Deal, closedBy: string, reason: string) {
    const now = new Date();
    await this.settleOnCloseTx(tx, d, 'cancel');
    await tx.update(deals).set({ status: 'cancelled', closedBy, closeReason: reason, cancelledAt: now }).where(eq(deals.id, d.id));
    // Исполнитель отменённой сделки повторно откликнуться не сможет.
    await tx.update(offers).set({ status: 'rejected', updatedAt: now }).where(eq(offers.id, d.offerId));
    const cancelledSuppliers = tx
      .select({ id: deals.supplierCompanyId })
      .from(deals)
      .where(and(eq(deals.requestId, d.requestId), eq(deals.status, 'cancelled')));
    await tx
      .update(offers)
      .set({ status: 'sent', updatedAt: now })
      .where(and(eq(offers.requestId, d.requestId), eq(offers.status, 'rejected'), notInArray(offers.supplierCompanyId, cancelledSuppliers)));
    const [left] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(offers)
      .where(and(eq(offers.requestId, d.requestId), eq(offers.status, 'sent')));
    const minExpiry = new Date(now.getTime() + REOPEN_MIN_DAYS * 86_400_000);
    await tx
      .update(requests)
      .set({
        status: (left?.c ?? 0) > 0 ? 'has_offers' : 'submitted',
        closedAt: null,
        expiresAt: sql`greatest(coalesce(${requests.expiresAt}, now()), ${minExpiry.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(eq(requests.id, d.requestId));
  }

  private async afterCancel(d: Deal, by: string, reason: string) {
    const payload = { requestId: d.requestId, dealId: d.id, reason };
    const [cur] = await this.db.select({ paymentStatus: deals.paymentStatus }).from(deals).where(eq(deals.id, d.id));
    if (cur?.paymentStatus === 'refund_due') await this.notifications.notify(d.buyerUserId, 'deal_refund_due', payload, { urgent: true });
    if (by !== 'buyer') await this.notifications.notify(d.buyerUserId, 'deal_cancelled', payload, { urgent: true });
    if (by !== 'supplier') await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_cancelled', payload, { urgent: true });
    const [req] = await this.db.select({ title: requests.title }).from(requests).where(eq(requests.id, d.requestId));
    const reopened = await this.db
      .select({ companyId: offers.supplierCompanyId })
      .from(offers)
      .where(and(eq(offers.requestId, d.requestId), eq(offers.status, 'sent')));
    for (const o of reopened) await this.notifications.notifyCompany(o.companyId, 'request_reopened', { requestId: d.requestId, title: req?.title });
    this.realtime.toRequest(d.requestId, 'request.updated', { id: d.requestId, status: 'reopened' });
    this.realtime.toUser(d.buyerUserId, 'deal.updated', { id: d.id });
  }

  /** Спор: сделка замораживается до решения модератора, обе стороны получают уведомление. */
  async dispute(userId: number, dealId: number, reason: string) {
    const { side } = await this.loadForSide(userId, dealId);
    const d = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deals).where(eq(deals.id, dealId)).for('update');
      if (d.status !== 'active') throw new AppError('bad_status', 'Спор можно открыть только по активной сделке');
      await tx.update(deals).set({ status: 'disputed', closedBy: side, closeReason: maskContacts(reason).text, disputedAt: new Date() }).where(eq(deals.id, dealId));
      await tx.insert(moderationItems).values({ kind: 'deal_dispute', refType: 'deal', refId: dealId, note: `${side === 'buyer' ? 'Покупатель' : 'Поставщик'}: ${reason}` });
      return d;
    });
    const payload = { requestId: d.requestId, dealId };
    await this.notifications.notify(d.buyerUserId, 'deal_disputed', payload, { urgent: true });
    await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_disputed', payload, { urgent: true });
    this.analytics.track('deal.disputed', userId, { dealId, side });
    return this.view(userId, dealId);
  }

  /** Решение модератора по спору. */
  async resolve(staffUserId: number, dealId: number, dto: ResolveDealDto) {
    const note = dto.note ?? '';
    const d = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(deals).where(eq(deals.id, dealId)).for('update');
      if (!d) throw notFound('Сделка');
      if (d.status !== 'disputed') throw new AppError('bad_status', 'По сделке нет открытого спора');
      if (dto.outcome === 'complete') await this.completeTx(tx, d, new Date(), 'staff');
      else if (dto.outcome === 'cancel') await this.cancelTx(tx, d, 'staff', note || 'Решение модератора');
      else await tx.update(deals).set({ status: 'active', closedBy: null, closeReason: null, disputedAt: null }).where(eq(deals.id, dealId));
      await tx
        .update(moderationItems)
        .set({ status: 'resolved', resolution: `${dto.outcome}${note ? `: ${note}` : ''}`, resolvedByUserId: staffUserId, resolvedAt: new Date() })
        .where(and(eq(moderationItems.kind, 'deal_dispute'), eq(moderationItems.refId, dealId), eq(moderationItems.status, 'open')));
      await tx.insert(auditLog).values({ staffUserId, action: 'deal.resolve', refType: 'deal', refId: dealId, data: { outcome: dto.outcome, note } });
      return d;
    });

    const payload = { dealId, requestId: d.requestId, outcome: OUTCOME_TEXT[dto.outcome], note };
    await this.notifications.notify(d.buyerUserId, 'deal_resolved', payload, { urgent: true });
    await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_resolved', payload, { urgent: true });
    if (dto.outcome === 'complete') await this.afterComplete(d, null);
    if (dto.outcome === 'cancel') await this.afterCancel(d, 'staff', note);
    return this.load(dealId);
  }

  /** Отзыв только по закрытой сделке, один с каждой стороны. Подозрительные отзывы видны, но не влияют на рейтинг. */
  async review(userId: number, dealId: number, dto: ReviewDto) {
    const { d, side } = await this.loadForSide(userId, dealId);
    if (d.status !== 'completed') throw new AppError('not_completed', 'Отзыв можно оставить после подтверждения сделки обеими сторонами');
    const targetCompanyId = side === 'buyer' ? d.supplierCompanyId : d.buyerCompanyId;
    const decision = targetCompanyId ? await this.reviewDecision(userId, targetCompanyId) : { counted: true, flag: null };

    const inserted = await this.db
      .insert(reviews)
      .values({
        dealId,
        authorUserId: userId,
        authorSide: side,
        targetCompanyId,
        targetUserId: side === 'supplier' ? d.buyerUserId : null,
        stars: dto.stars,
        text: dto.text ? maskContacts(dto.text).text : null,
        counted: decision.counted,
        flag: decision.flag,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) throw new AppError('already_reviewed', 'Вы уже оставили отзыв');
    if (decision.flag && MODERATED_FLAGS.includes(decision.flag)) {
      await this.db.insert(moderationItems).values({
        kind: 'review_suspicious',
        refType: 'review',
        refId: inserted[0].id,
        note: `Признак накрутки: ${decision.flag}. Сделка #${dealId}, ${dto.stars}★`,
      });
    }
    if (targetCompanyId) await this.recomputeRating(targetCompanyId);

    const [{ c }] = await this.db.select({ c: sql<number>`count(*)::int` }).from(reviews).where(eq(reviews.dealId, dealId));
    if (c >= 2) await this.db.update(requests).set({ status: 'reviewed', updatedAt: new Date() }).where(eq(requests.id, d.requestId));
    return this.view(userId, dealId);
  }

  private async reviewDecision(authorUserId: number, targetCompanyId: number) {
    const [author] = await this.db.select({ phoneHash: users.phoneHash, phoneVerifiedAt: users.phoneVerifiedAt }).from(users).where(eq(users.id, authorUserId));
    const members = await this.db
      .select({ userId: memberships.userId, phoneHash: users.phoneHash })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.companyId, targetCompanyId));
    const since = new Date(Date.now() - this.cfg.REVIEW_PAIR_COOLDOWN_DAYS * 86_400_000);
    const [pair] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(reviews)
      .where(and(eq(reviews.authorUserId, authorUserId), eq(reviews.targetCompanyId, targetCompanyId), eq(reviews.counted, true), gte(reviews.createdAt, since)));
    return decideReview({
      authorPhoneVerified: !!author?.phoneVerifiedAt,
      authorPhoneMatchesTarget: !!author?.phoneHash && members.some((m) => m.phoneHash === author.phoneHash),
      authorIsTargetMember: members.some((m) => m.userId === authorUserId),
      recentCountedPairReviews: pair?.c ?? 0,
    });
  }

  async recomputeRating(companyId: number) {
    await this.db.execute(sql`
      update companies set
        rating_avg = (select avg(stars)::real from reviews where target_company_id = ${companyId} and hidden = false and counted = true),
        rating_count = (select count(*)::int from reviews where target_company_id = ${companyId} and hidden = false and counted = true)
      where id = ${companyId}
    `);
    await this.recomputeTrust(companyId);
  }

  /**
   * L1 — подтверждённый ИНН; L2 — ещё 5+ закрытых сделок с разными покупателями, 3+ учтённых отзыва и рейтинг от 4,5.
   * Разные покупатели считаются по номеру телефона: десять сделок с самим собой через разные аккаунты не дают L2.
   * L3 выставляется вручную по данным банка.
   */
  async recomputeTrust(companyId: number) {
    const [c] = await this.db.select().from(companies).where(eq(companies.id, companyId));
    if (!c || c.trustLevel >= 3) return;
    let level = c.innVerifiedAt ? 1 : 0;
    if (level === 1 && (c.ratingAvg ?? 0) >= 4.5 && c.ratingCount >= 3) {
      const r = await this.db.execute(sql`
        select count(distinct coalesce(u.phone_hash, 'u' || u.id::text))::int as c
        from deals d join users u on u.id = d.buyer_user_id
        where d.supplier_company_id = ${companyId} and d.status = 'completed'`);
      if (Number((r.rows[0] as { c?: number } | undefined)?.c ?? 0) >= 5) level = 2;
    }
    if (level !== c.trustLevel) await this.db.update(companies).set({ trustLevel: level }).where(eq(companies.id, companyId));
  }

  /**
   * Ежечасная задача. Напоминает о зависших сделках раз в DEAL_REMIND_AFTER_DAYS дней,
   * а если одна сторона подтвердила, а другая молчит DEAL_AUTOCOMPLETE_DAYS дней, закрывает сделку.
   */
  async sweepActive(): Promise<{ reminded: number; autoCompleted: number }> {
    const autoBefore = new Date(Date.now() - this.cfg.DEAL_AUTOCOMPLETE_DAYS * 86_400_000);
    const stale = await this.db
      .select()
      .from(deals)
      .where(
        and(
          eq(deals.status, 'active'),
          or(
            and(lt(deals.buyerConfirmedAt, autoBefore), isNull(deals.supplierConfirmedAt)),
            and(lt(deals.supplierConfirmedAt, autoBefore), isNull(deals.buyerConfirmedAt)),
          ),
        ),
      )
      .limit(200);
    let autoCompleted = 0;
    for (const s of stale) {
      const done = await this.db.transaction(async (tx) => {
        const [d] = await tx.select().from(deals).where(eq(deals.id, s.id)).for('update');
        if (d.status !== 'active') return null;
        const now = new Date();
        await tx.update(deals).set({ buyerConfirmedAt: d.buyerConfirmedAt ?? now, supplierConfirmedAt: d.supplierConfirmedAt ?? now }).where(eq(deals.id, d.id));
        await this.completeTx(tx, d, now, 'auto');
        return d;
      });
      if (done) {
        autoCompleted++;
        await this.afterComplete(done, null);
      }
    }

    const remindBefore = new Date(Date.now() - this.cfg.DEAL_REMIND_AFTER_DAYS * 86_400_000);
    const due = await this.db
      .update(deals)
      .set({ remindedAt: new Date() })
      .where(
        and(
          eq(deals.status, 'active'),
          lt(deals.createdAt, remindBefore),
          or(isNull(deals.remindedAt), lt(deals.remindedAt, remindBefore)),
        ),
      )
      .returning();
    for (const d of due) {
      const [req] = await this.db.select({ title: requests.title }).from(requests).where(eq(requests.id, d.requestId));
      const payload = { requestId: d.requestId, dealId: d.id, title: req?.title ?? '' };
      if (!d.buyerConfirmedAt) await this.notifications.notify(d.buyerUserId, 'deal_reminder', payload);
      if (!d.supplierConfirmedAt) await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_reminder', payload);
    }
    return { reminded: due.length, autoCompleted };
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

  @Post('deals/:id/pay')
  @HttpCode(HttpStatus.OK)
  @RateLimit('deal-pay', 20, 3600)
  pay(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.pay(u.id, id);
  }

  @Post('deals/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.confirm(u.id, id);
  }

  @Post('deals/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit('deal-cancel', 10, 3600)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(dealReasonSchema)) b: DealReasonDto) {
    return this.deals.cancel(u.id, id, b.reason);
  }

  @Post('deals/:id/dispute')
  @HttpCode(HttpStatus.OK)
  @RateLimit('deal-dispute', 5, 3600)
  dispute(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(dealReasonSchema)) b: DealReasonDto) {
    return this.deals.dispute(u.id, id, b.reason);
  }

  @Post('deals/:id/review')
  review(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(reviewSchema)) dto: ReviewDto) {
    return this.deals.review(u.id, id, dto);
  }
}
