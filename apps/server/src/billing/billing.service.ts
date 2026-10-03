import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { auditLog, companies, deals, invoices, memberships, moderationItems, offers, payments, requests, subscriptions, users, type Db } from '@dominify/db';
import { formatUzs, GRACE_DAYS, PERIOD_DAYS, PLANS, type PlanCode } from '@dominify/shared';
import { and, desc, eq, gte, lt, ne, or, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { randomToken } from '../common/crypto';
import { AppError, notFound } from '../common/http';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PaidVia = 'bank_transfer' | 'payme' | 'click' | 'manual';
type Invoice = typeof invoices.$inferSelect;
export interface PaidResult {
  invoice: Invoice;
  activated: boolean;
  until?: Date;
  /** Счёт заказа: сделка после зачисления оплаты. */
  deal?: typeof deals.$inferSelect;
}
export const PAYME_TIMEOUT_MS = 12 * 3600 * 1000;
export const CLICK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Тарифы, счета и подписки. Оплата идёт вне Mini App: банковский перевод по счёту
 * или веб-страница счёта с Payme и Click.
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('Billing');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly notifications: NotificationsService,
  ) {}

  async subscription(companyId: number) {
    const [s] = await this.db.select().from(subscriptions).where(eq(subscriptions.companyId, companyId));
    if (s) return s;
    const [created] = await this.db.insert(subscriptions).values({ companyId, planCode: 'free', status: 'active' }).onConflictDoNothing().returning();
    return created ?? (await this.db.select().from(subscriptions).where(eq(subscriptions.companyId, companyId)))[0];
  }

  /** Действующий тариф: в grace-периоде платный ещё работает, после истечения — бесплатный. */
  async effectivePlan(companyId: number): Promise<PlanCode> {
    const s = await this.subscription(companyId);
    if (s.status === 'expired') return 'free';
    return s.planCode as PlanCode;
  }

  /** Откликов с начала текущего месяца по Ташкенту. */
  async offersThisMonth(companyId: number): Promise<number> {
    const [r] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(offers)
      .where(
        and(
          eq(offers.supplierCompanyId, companyId),
          sql`${offers.createdAt} >= date_trunc('month', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'`,
        ),
      );
    return r?.c ?? 0;
  }

  /**
   * Откликов этого месяца с бесплатных компаний, отправленных людьми с тем же номером телефона.
   * Без этого бесплатный лимит обходится созданием новых компаний.
   */
  async freeOffersThisMonthByPhone(phoneHash: string): Promise<number> {
    const r = await this.db.execute<{ c: number }>(sql`
      select count(*)::int as c
      from offers o
      join users u on u.id = o.author_user_id
      where u.phone_hash = ${phoneHash}
        and o.created_at >= date_trunc('month', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent'
        and not exists (
          select 1 from subscriptions s
          where s.company_id = o.supplier_company_id and s.plan_code <> 'free' and s.status <> 'expired'
        )`);
    return Number(r.rows[0]?.c ?? 0);
  }

  /** Экран «Тариф» в Mini App: что включено и до какого числа. Без цен и кнопок оплаты. */
  async planInfo(companyId: number) {
    const s = await this.subscription(companyId);
    const plan = await this.effectivePlan(companyId);
    const def = PLANS[plan];
    return {
      planCode: plan,
      planName: def.name,
      status: s.status,
      periodEnd: s.periodEnd,
      offersPerMonth: def.offersPerMonth,
      offersUsed: await this.offersThisMonth(companyId),
      notifyDelayMin: def.notifyDelayMin,
      seats: def.seats,
      maxCategories: def.maxCategories,
    };
  }

  /** Просьба связаться по тарифу: задача менеджеру в админке. */
  async contactManager(companyId: number, userId: number, note?: string) {
    await this.db.insert(moderationItems).values({
      kind: 'billing_contact',
      refType: 'company',
      refId: companyId,
      note: note?.slice(0, 500) ?? `Пользователь ${userId} просит связаться по тарифу`,
    });
    return { ok: true };
  }

  async createInvoice(staffUserId: number, companyId: number, planCode: PlanCode, months: number, note?: string) {
    if (planCode === 'free') throw new AppError('bad_plan', 'Бесплатный тариф не выставляется');
    const [c] = await this.db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!c) throw notFound('Компания');
    const [inv] = await this.db
      .insert(invoices)
      .values({
        companyId,
        planCode,
        months,
        amountUzs: PLANS[planCode].priceUzs * months,
        payToken: randomToken(18),
        issuedByUserId: staffUserId,
        note: note ?? null,
      })
      .returning();
    await this.db.insert(auditLog).values({ staffUserId, action: 'invoice.create', refType: 'invoice', refId: inv.id, data: { companyId, planCode, months } });
    return { ...inv, payUrl: `${this.cfg.PUBLIC_API_URL}/pay/${inv.payToken}` };
  }

  async invoiceByToken(token: string) {
    const [inv] = await this.db.select().from(invoices).where(eq(invoices.payToken, token));
    return inv ?? null;
  }

  async invoiceById(id: number) {
    const [inv] = await this.db.select().from(invoices).where(eq(invoices.id, id));
    return inv ?? null;
  }

  async listInvoices(companyId?: number) {
    return this.db
      .select({
        id: invoices.id,
        kind: invoices.kind,
        dealId: invoices.dealId,
        companyId: invoices.companyId,
        companyName: companies.name,
        planCode: invoices.planCode,
        months: invoices.months,
        amountUzs: invoices.amountUzs,
        status: invoices.status,
        paidAt: invoices.paidAt,
        paidVia: invoices.paidVia,
        payToken: invoices.payToken,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(companies, eq(companies.id, invoices.companyId))
      .where(companyId ? eq(invoices.companyId, companyId) : undefined)
      .orderBy(desc(invoices.createdAt))
      .limit(200);
  }

  /**
   * Счёт оплачен: продлить подписку. Идемпотентно — повторный вызов для оплаченного счёта ничего не меняет.
   * Если тот же тариф ещё действует, новый период добавляется к концу текущего.
   */
  async markPaid(invoiceId: number, via: PaidVia, staffUserId?: number) {
    return this.db.transaction((tx) => this.applyPaid(tx, invoiceId, via, staffUserId)).then((r) => this.afterPaid(r));
  }

  async afterPaid<R extends PaidResult>(r: R): Promise<R> {
    if (r.deal) {
      const d = r.deal;
      const [req] = await this.db.select({ title: requests.title }).from(requests).where(eq(requests.id, d.requestId));
      const payload = { dealId: d.id, requestId: d.requestId, title: req?.title ?? '', amount: formatUzs(d.amountUzs), payout: formatUzs(d.amountUzs - d.feeUzs) };
      if (d.paymentStatus === 'held') {
        await this.notifications.notifyCompany(d.supplierCompanyId, 'deal_paid', payload, { urgent: true });
        await this.notifications.notify(d.buyerUserId, 'deal_paid_buyer', payload, { urgent: true });
      } else {
        await this.db.insert(moderationItems).values({ kind: 'escrow_refund', refType: 'deal', refId: d.id, note: `Оплата пришла по закрытой сделке #${d.id}: вернуть покупателю` });
      }
      return r;
    }
    if (r.activated && r.until) {
      await this.notifications.notifyCompany(r.invoice.companyId, 'subscription_activated', {
        plan: PLANS[r.invoice.planCode as PlanCode].name.ru,
        until: fmtDate(r.until),
      });
    }
    return r;
  }

  /** Отметка оплаты внутри уже открытой транзакции: платёж провайдера и счёт меняются атомарно. */
  async applyPaid(tx: Tx, invoiceId: number, via: PaidVia, staffUserId?: number): Promise<PaidResult> {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    if (!inv) throw notFound('Счёт');
    if (inv.status === 'paid') return { invoice: inv, activated: false, until: undefined };
    if (inv.status === 'cancelled') throw new AppError('cancelled', 'Счёт отменён');
    if ((via === 'bank_transfer' || via === 'manual') && (await this.paymentInFlight(tx, invoiceId))) {
      throw new AppError('payment_pending', 'По счёту идёт оплата через Payme или Click. Дождитесь её завершения.', HttpStatus.CONFLICT);
    }
    if (inv.kind === 'deal') return this.applyDealPaid(tx, inv, via, staffUserId);
    const planCode = inv.planCode as PlanCode;

    const now = new Date();
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.companyId, inv.companyId)).for('update');
    const samePlanActive = sub && sub.planCode === inv.planCode && sub.status !== 'expired' && sub.periodEnd && sub.periodEnd > now;
    const start = samePlanActive ? sub!.periodEnd! : now;
    const end = new Date(start.getTime() + PERIOD_DAYS * inv.months * 86_400_000);

    await tx.update(invoices).set({ status: 'paid', paidAt: now, paidVia: via }).where(eq(invoices.id, inv.id));
    if (sub) {
      await tx
        .update(subscriptions)
        .set({ planCode, status: 'active', periodStart: samePlanActive ? sub.periodStart : now, periodEnd: end, source: via, remindedAt: null, updatedAt: now })
        .where(eq(subscriptions.id, sub.id));
    } else {
      await tx.insert(subscriptions).values({ companyId: inv.companyId, planCode, status: 'active', periodStart: now, periodEnd: end, source: via });
    }
    if (staffUserId) {
      await tx.insert(auditLog).values({ staffUserId, action: 'invoice.paid', refType: 'invoice', refId: inv.id, data: { via } });
    }
    const [paid] = await tx.select().from(invoices).where(eq(invoices.id, inv.id));
    return { invoice: paid, activated: true, until: end };
  }

  /**
   * Покупатель оплатил заказ: деньги на счёте платформы до приёмки работы.
   * Если сделку успели отменить, пока шла оплата, деньги сразу помечаются к возврату.
   */
  private async applyDealPaid(tx: Tx, inv: Invoice, via: PaidVia, staffUserId?: number): Promise<PaidResult> {
    const now = new Date();
    const [d] = await tx.select().from(deals).where(eq(deals.id, inv.dealId!)).for('update');
    const open = d.status === 'active' || d.status === 'disputed';
    await tx.update(invoices).set({ status: 'paid', paidAt: now, paidVia: via }).where(eq(invoices.id, inv.id));
    const [deal] = await tx
      .update(deals)
      .set({
        paymentStatus: open ? 'held' : 'refund_due',
        paidAt: now,
        escrow: true,
        feeUzs: Math.round((d.amountUzs * this.cfg.ESCROW_FEE_PERCENT) / 100),
      })
      .where(eq(deals.id, d.id))
      .returning();
    if (staffUserId) {
      await tx.insert(auditLog).values({ staffUserId, action: 'invoice.paid', refType: 'invoice', refId: inv.id, data: { via, dealId: d.id } });
    }
    const [paid] = await tx.select().from(invoices).where(eq(invoices.id, inv.id));
    return { invoice: paid, activated: false, deal };
  }

  /** Неоплаченный счёт заказа больше не нужен (сделку отменили): бонусы возвращаются покупателю. */
  async cancelDealInvoiceTx(tx: Tx, inv: Invoice, buyerUserId: number) {
    await tx.update(invoices).set({ status: 'cancelled' }).where(eq(invoices.id, inv.id));
    if (inv.bonusUzs > 0) await tx.update(users).set({ bonusUzs: sql`${users.bonusUzs} + ${inv.bonusUzs}` }).where(eq(users.id, buyerUserId));
  }

  /**
   * Платёжная система вернула деньги за оплаченный заказ (Payme CancelTransaction после проведения).
   * Разрешено, пока деньги ещё у платформы: удержаны или ждут возврата. После выплаты исполнителю — нельзя.
   */
  async refundDealByProvider(tx: Tx, invoiceId: number): Promise<boolean> {
    const inv = await this.lockInvoice(tx, invoiceId);
    if (!inv || inv.kind !== 'deal' || !inv.dealId) return false;
    const [d] = await tx.select().from(deals).where(eq(deals.id, inv.dealId)).for('update');
    if (!['held', 'refund_due', 'refunded'].includes(d.paymentStatus)) return false;
    if (d.paymentStatus !== 'refunded') {
      await tx.update(deals).set({ paymentStatus: 'refunded', settledAt: new Date() }).where(eq(deals.id, d.id));
    }
    return true;
  }

  async cancelInvoice(invoiceId: number, staffUserId: number) {
    await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
      if (!inv) throw notFound('Счёт');
      if (inv.status === 'paid') throw new AppError('paid', 'Оплаченный счёт отменить нельзя');
      if (await this.paymentInFlight(tx, invoiceId)) {
        throw new AppError('payment_pending', 'По счёту идёт оплата через Payme или Click. Дождитесь её завершения.', HttpStatus.CONFLICT);
      }
      if (inv.kind === 'deal' && inv.dealId) {
        const [d] = await tx.select().from(deals).where(eq(deals.id, inv.dealId));
        await this.cancelDealInvoiceTx(tx, inv, d.buyerUserId);
        await tx.update(deals).set({ paymentStatus: 'none' }).where(and(eq(deals.id, d.id), eq(deals.paymentStatus, 'awaiting')));
      } else {
        await tx.update(invoices).set({ status: 'cancelled' }).where(eq(invoices.id, invoiceId));
      }
      await tx.insert(auditLog).values({ staffUserId, action: 'invoice.cancel', refType: 'invoice', refId: invoiceId, data: {} });
    });
  }

  /** Блокирует строку счёта до конца транзакции: Payme, Click и админка работают со счётом по очереди. */
  async lockInvoice(tx: Tx, invoiceId: number) {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
    return inv ?? null;
  }

  /**
   * Есть ли по счёту незавершённая транзакция в любой платёжной системе (кроме указанной).
   * Payme держит транзакцию в состоянии 1 до 12 часов, Click между Prepare и Complete — минуты.
   * Пока такая транзакция жива, вторую не открываем: иначе один счёт оплатят дважды.
   */
  async paymentInFlight(tx: Tx, invoiceId: number, except?: { provider: 'payme' | 'click'; txnId: string }): Promise<boolean> {
    const now = Date.now();
    const [row] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.invoiceId, invoiceId),
          eq(payments.state, 1),
          or(
            and(eq(payments.provider, 'payme'), gte(payments.providerTime, now - PAYME_TIMEOUT_MS)),
            and(eq(payments.provider, 'click'), gte(payments.providerTime, now - CLICK_TIMEOUT_MS)),
          ),
          except ? sql`not (${payments.provider} = ${except.provider} and ${payments.providerTxnId} = ${except.txnId})` : undefined,
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Есть ли по счёту успешная транзакция другой платёжной системы. */
  async paidElsewhere(tx: Tx, invoiceId: number, paymentId: number): Promise<boolean> {
    const [row] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.invoiceId, invoiceId), eq(payments.state, 2), ne(payments.id, paymentId)))
      .limit(1);
    return !!row;
  }

  /** Ежедневная задача: напоминания, grace-период и перевод на бесплатный тариф. */
  async lifecycle(now = new Date()): Promise<{ reminded: number; grace: number; expired: number }> {
    const in3days = new Date(now.getTime() + 3 * 86_400_000);
    const graceEdge = new Date(now.getTime() - GRACE_DAYS * 86_400_000);
    let reminded = 0;
    let grace = 0;
    let expired = 0;

    const expiring = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'active'), sql`${subscriptions.planCode} <> 'free'`, lt(subscriptions.periodEnd, in3days), gte(subscriptions.periodEnd, now), sql`${subscriptions.remindedAt} is null`));
    for (const s of expiring) {
      await this.db.update(subscriptions).set({ remindedAt: now }).where(eq(subscriptions.id, s.id));
      await this.notifyOwners(s.companyId, 'subscription_expiring', { plan: PLANS[s.planCode as PlanCode].name.ru, until: fmtDate(s.periodEnd!) });
      reminded++;
    }

    const ended = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'active'), sql`${subscriptions.planCode} <> 'free'`, lt(subscriptions.periodEnd, now)));
    for (const s of ended) {
      await this.db.update(subscriptions).set({ status: 'grace', updatedAt: now }).where(eq(subscriptions.id, s.id));
      await this.notifyOwners(s.companyId, 'subscription_grace', { plan: PLANS[s.planCode as PlanCode].name.ru });
      grace++;
    }

    const dead = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.status, 'grace'), lt(subscriptions.periodEnd, graceEdge)));
    for (const s of dead) {
      await this.db.update(subscriptions).set({ status: 'active', planCode: 'free', periodStart: null, periodEnd: null, updatedAt: now }).where(eq(subscriptions.id, s.id));
      await this.notifyOwners(s.companyId, 'subscription_expired', {});
      expired++;
    }
    if (reminded + grace + expired) this.log.log(`Подписки: напомнили ${reminded}, grace ${grace}, на бесплатный ${expired}`);
    return { reminded, grace, expired };
  }

  private async notifyOwners(companyId: number, type: 'subscription_expiring' | 'subscription_grace' | 'subscription_expired', payload: Record<string, unknown>) {
    const owners = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner')));
    for (const o of owners) await this.notifications.notify(o.userId, type, payload);
  }
}
