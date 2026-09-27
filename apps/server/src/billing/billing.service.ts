import { Inject, Injectable, Logger } from '@nestjs/common';
import { auditLog, companies, invoices, memberships, moderationItems, offers, subscriptions, type Db } from '@dominify/db';
import { GRACE_DAYS, PERIOD_DAYS, PLANS, type PlanCode } from '@dominify/shared';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { randomToken } from '../common/crypto';
import { AppError, notFound } from '../common/http';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

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
  async markPaid(invoiceId: number, via: 'bank_transfer' | 'payme' | 'click' | 'manual', staffUserId?: number) {
    return this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update');
      if (!inv) throw notFound('Счёт');
      if (inv.status === 'paid') return { invoice: inv, activated: false };
      if (inv.status === 'cancelled') throw new AppError('cancelled', 'Счёт отменён');

      const now = new Date();
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.companyId, inv.companyId)).for('update');
      const samePlanActive = sub && sub.planCode === inv.planCode && sub.status !== 'expired' && sub.periodEnd && sub.periodEnd > now;
      const start = samePlanActive ? sub!.periodEnd! : now;
      const end = new Date(start.getTime() + PERIOD_DAYS * inv.months * 86_400_000);

      await tx.update(invoices).set({ status: 'paid', paidAt: now, paidVia: via }).where(eq(invoices.id, inv.id));
      if (sub) {
        await tx
          .update(subscriptions)
          .set({ planCode: inv.planCode, status: 'active', periodStart: samePlanActive ? sub.periodStart : now, periodEnd: end, source: via, remindedAt: null, updatedAt: now })
          .where(eq(subscriptions.id, sub.id));
      } else {
        await tx.insert(subscriptions).values({ companyId: inv.companyId, planCode: inv.planCode, status: 'active', periodStart: now, periodEnd: end, source: via });
      }
      if (staffUserId) {
        await tx.insert(auditLog).values({ staffUserId, action: 'invoice.paid', refType: 'invoice', refId: inv.id, data: { via } });
      }
      const [paid] = await tx.select().from(invoices).where(eq(invoices.id, inv.id));
      return { invoice: paid, activated: true, until: end };
    }).then(async (r) => {
      if (r.activated && r.until) {
        await this.notifications.notifyCompany(r.invoice.companyId, 'subscription_activated', {
          plan: PLANS[r.invoice.planCode as PlanCode].name.ru,
          until: fmtDate(r.until),
        });
      }
      return r;
    });
  }

  async cancelInvoice(invoiceId: number, staffUserId: number) {
    const [inv] = await this.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!inv) throw notFound('Счёт');
    if (inv.status === 'paid') throw new AppError('paid', 'Оплаченный счёт отменить нельзя');
    await this.db.update(invoices).set({ status: 'cancelled' }).where(eq(invoices.id, invoiceId));
    await this.db.insert(auditLog).values({ staffUserId, action: 'invoice.cancel', refType: 'invoice', refId: invoiceId, data: {} });
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
