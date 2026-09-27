import { Inject, Injectable, Logger } from '@nestjs/common';
import { payments, type Db } from '@dominify/db';
import { PLANS, type PlanCode } from '@dominify/shared';
import { and, between, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config';
import { CONFIG, DB } from '../infra/tokens';
import { BillingService } from './billing.service';

/** Коды ошибок Merchant API Payme. */
export const PaymeErr = {
  auth: -32504,
  method: -32601,
  parse: -32700,
  amount: -31001,
  notFound: -31003,
  cantCancel: -31007,
  cantPerform: -31008,
  account: -31050,
  accountBusy: -31051,
} as const;

const TIMEOUT_MS = 12 * 3600 * 1000;

type Msg = { ru: string; uz: string; en: string };
const MSG: Record<string, Msg> = {
  auth: { ru: 'Недостаточно привилегий', uz: 'Huquqlar yetarli emas', en: 'Insufficient privileges' },
  method: { ru: 'Метод не найден', uz: 'Metod topilmadi', en: 'Method not found' },
  amount: { ru: 'Неверная сумма', uz: "Noto'g'ri summa", en: 'Invalid amount' },
  notFound: { ru: 'Транзакция не найдена', uz: 'Tranzaksiya topilmadi', en: 'Transaction not found' },
  cantCancel: { ru: 'Услуга оказана, отмена невозможна', uz: "Xizmat ko'rsatilgan, bekor qilib bo'lmaydi", en: 'Cannot cancel: service delivered' },
  cantPerform: { ru: 'Невозможно выполнить операцию', uz: "Amalni bajarib bo'lmaydi", en: 'Unable to perform operation' },
  account: { ru: 'Счёт не найден', uz: 'Hisob topilmadi', en: 'Invoice not found' },
  accountBusy: { ru: 'Счёт уже оплачен или ожидает оплаты', uz: "Hisob to'langan yoki kutilmoqda", en: 'Invoice already paid or pending' },
};

export class PaymeError extends Error {
  constructor(
    readonly code: number,
    readonly msg: Msg,
    readonly data?: string,
  ) {
    super(msg.en);
  }
}

interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
  id: number | string;
}

/**
 * Merchant API Payme (JSON-RPC). Payme вызывает эти методы, когда человек оплачивает счёт на странице оплаты.
 * Реквизит счёта в кабинете Payme называется invoice_id.
 */
@Injectable()
export class PaymeService {
  private readonly log = new Logger('Payme');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly billing: BillingService,
  ) {}

  checkAuth(header: string | undefined): boolean {
    if (!this.cfg.PAYME_KEY || !header?.startsWith('Basic ')) return false;
    const expected = Buffer.from(`Paycom:${this.cfg.PAYME_KEY}`).toString('base64');
    const got = header.slice(6).trim();
    return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }

  async handle(req: RpcRequest, authHeader?: string): Promise<{ id: unknown; result?: unknown; error?: unknown }> {
    const id = req?.id ?? null;
    try {
      if (!this.checkAuth(authHeader)) throw new PaymeError(PaymeErr.auth, MSG.auth);
      const p = req.params ?? {};
      switch (req.method) {
        case 'CheckPerformTransaction':
          return { id, result: await this.checkPerform(p) };
        case 'CreateTransaction':
          return { id, result: await this.create(p) };
        case 'PerformTransaction':
          return { id, result: await this.perform(p) };
        case 'CancelTransaction':
          return { id, result: await this.cancel(p) };
        case 'CheckTransaction':
          return { id, result: await this.check(p) };
        case 'GetStatement':
          return { id, result: await this.statement(p) };
        default:
          throw new PaymeError(PaymeErr.method, MSG.method);
      }
    } catch (e) {
      if (e instanceof PaymeError) return { id, error: { code: e.code, message: e.msg, data: e.data } };
      this.log.error(e instanceof Error ? e.stack : String(e));
      return { id, error: { code: PaymeErr.cantPerform, message: MSG.cantPerform } };
    }
  }

  private async invoiceFor(p: Record<string, unknown>) {
    const account = (p.account ?? {}) as Record<string, unknown>;
    const invoiceId = Number(account.invoice_id);
    if (!invoiceId) throw new PaymeError(PaymeErr.account, MSG.account, 'invoice_id');
    const inv = await this.billing.invoiceById(invoiceId);
    if (!inv) throw new PaymeError(PaymeErr.account, MSG.account, 'invoice_id');
    return inv;
  }

  private async checkPerform(p: Record<string, unknown>) {
    const inv = await this.invoiceFor(p);
    if (inv.status !== 'issued') throw new PaymeError(PaymeErr.accountBusy, MSG.accountBusy, 'invoice_id');
    if (Number(p.amount) !== inv.amountUzs * 100) throw new PaymeError(PaymeErr.amount, MSG.amount);
    const result: Record<string, unknown> = { allow: true };
    if (this.cfg.PAYME_IKPU_CODE) {
      result.detail = {
        receipt_type: 0,
        items: [
          {
            title: `Тариф «${PLANS[inv.planCode as PlanCode].name.ru}», ${inv.months} мес.`,
            price: inv.amountUzs * 100,
            count: 1,
            code: this.cfg.PAYME_IKPU_CODE,
            package_code: this.cfg.PAYME_PACKAGE_CODE,
            vat_percent: 0,
          },
        ],
      };
    }
    return result;
  }

  private async byTxn(txnId: string) {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, 'payme'), eq(payments.providerTxnId, txnId)));
    return row ?? null;
  }

  private async create(p: Record<string, unknown>) {
    const txnId = String(p.id);
    const time = Number(p.time);
    const existing = await this.byTxn(txnId);
    if (existing) {
      if (existing.state !== 1) throw new PaymeError(PaymeErr.cantPerform, MSG.cantPerform);
      if (Date.now() - Number(existing.providerTime) > TIMEOUT_MS) {
        await this.db.update(payments).set({ state: -1, reason: 4, cancelTime: Date.now() }).where(eq(payments.id, existing.id));
        throw new PaymeError(PaymeErr.cantPerform, MSG.cantPerform);
      }
      return { create_time: Number(existing.providerTime), transaction: String(existing.id), state: 1 };
    }
    await this.checkPerform(p);
    const inv = await this.invoiceFor(p);
    // По счёту может быть только одна активная транзакция.
    const [active] = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.provider, 'payme'), eq(payments.state, 1)));
    if (active) throw new PaymeError(PaymeErr.accountBusy, MSG.accountBusy, 'invoice_id');
    const [row] = await this.db
      .insert(payments)
      .values({ invoiceId: inv.id, provider: 'payme', providerTxnId: txnId, amountTiyin: Number(p.amount), state: 1, providerTime: time })
      .returning();
    return { create_time: time, transaction: String(row.id), state: 1 };
  }

  private async perform(p: Record<string, unknown>) {
    const row = await this.byTxn(String(p.id));
    if (!row) throw new PaymeError(PaymeErr.notFound, MSG.notFound);
    if (row.state === 2) return { transaction: String(row.id), perform_time: Number(row.performTime), state: 2 };
    if (row.state !== 1) throw new PaymeError(PaymeErr.cantPerform, MSG.cantPerform);
    if (Date.now() - Number(row.providerTime) > TIMEOUT_MS) {
      await this.db.update(payments).set({ state: -1, reason: 4, cancelTime: Date.now() }).where(eq(payments.id, row.id));
      throw new PaymeError(PaymeErr.cantPerform, MSG.cantPerform);
    }
    const performTime = Date.now();
    await this.db.update(payments).set({ state: 2, performTime }).where(eq(payments.id, row.id));
    await this.billing.markPaid(row.invoiceId, 'payme');
    return { transaction: String(row.id), perform_time: performTime, state: 2 };
  }

  private async cancel(p: Record<string, unknown>) {
    const row = await this.byTxn(String(p.id));
    if (!row) throw new PaymeError(PaymeErr.notFound, MSG.notFound);
    if (row.state === 1) {
      const cancelTime = Date.now();
      await this.db.update(payments).set({ state: -1, reason: Number(p.reason) || null, cancelTime }).where(eq(payments.id, row.id));
      return { transaction: String(row.id), cancel_time: cancelTime, state: -1 };
    }
    if (row.state === 2) {
      // Подписка уже активирована: отмена только вручную через поддержку.
      throw new PaymeError(PaymeErr.cantCancel, MSG.cantCancel);
    }
    return { transaction: String(row.id), cancel_time: Number(row.cancelTime ?? 0), state: row.state };
  }

  private async check(p: Record<string, unknown>) {
    const row = await this.byTxn(String(p.id));
    if (!row) throw new PaymeError(PaymeErr.notFound, MSG.notFound);
    return {
      create_time: Number(row.providerTime),
      perform_time: Number(row.performTime ?? 0),
      cancel_time: Number(row.cancelTime ?? 0),
      transaction: String(row.id),
      state: row.state,
      reason: row.reason ?? null,
    };
  }

  private async statement(p: Record<string, unknown>) {
    const rows = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, 'payme'), between(payments.providerTime, Number(p.from), Number(p.to))));
    return {
      transactions: rows.map((r) => ({
        id: r.providerTxnId,
        time: Number(r.providerTime),
        amount: Number(r.amountTiyin),
        account: { invoice_id: String(r.invoiceId) },
        create_time: Number(r.providerTime),
        perform_time: Number(r.performTime ?? 0),
        cancel_time: Number(r.cancelTime ?? 0),
        transaction: String(r.id),
        state: r.state,
        reason: r.reason ?? null,
      })),
    };
  }
}

