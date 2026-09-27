import { Inject, Injectable, Logger } from '@nestjs/common';
import { payments, type Db } from '@dominify/db';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Config } from '../config';
import { CONFIG, DB } from '../infra/tokens';
import { BillingService } from './billing.service';

/** Коды ошибок SHOP API Click. */
export const ClickErr = {
  ok: 0,
  sign: -1,
  amount: -2,
  action: -3,
  alreadyPaid: -4,
  notFound: -5,
  txnNotFound: -6,
  update: -7,
  request: -8,
  cancelled: -9,
} as const;

export interface ClickParams {
  click_trans_id: string;
  service_id: string;
  click_paydoc_id?: string;
  merchant_trans_id: string;
  merchant_prepare_id?: string;
  amount: string;
  action: string;
  error: string;
  error_note?: string;
  sign_time: string;
  sign_string: string;
}

/** md5(click_trans_id + service_id + secret + merchant_trans_id + [merchant_prepare_id] + amount + action + sign_time). */
export function clickSign(p: ClickParams, secret: string): string {
  const prepare = p.action === '1' ? (p.merchant_prepare_id ?? '') : '';
  return createHash('md5')
    .update(`${p.click_trans_id}${p.service_id}${secret}${p.merchant_trans_id}${prepare}${p.amount}${p.action}${p.sign_time}`)
    .digest('hex');
}

/**
 * SHOP API Click: два шага — Prepare (action=0) и Complete (action=1).
 * merchant_trans_id — ID нашего счёта.
 */
@Injectable()
export class ClickService {
  private readonly log = new Logger('Click');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly billing: BillingService,
  ) {}

  private reply(p: Partial<ClickParams>, error: number, note: string, extra: Record<string, unknown> = {}) {
    return { click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id, error, error_note: note, ...extra };
  }

  async prepare(p: ClickParams) {
    if (p.action !== '0') return this.reply(p, ClickErr.action, 'Action not found');
    if (!this.cfg.CLICK_SECRET_KEY || clickSign(p, this.cfg.CLICK_SECRET_KEY) !== p.sign_string) return this.reply(p, ClickErr.sign, 'SIGN CHECK FAILED');
    const inv = await this.billing.invoiceById(Number(p.merchant_trans_id));
    if (!inv) return this.reply(p, ClickErr.notFound, 'Invoice not found');
    if (inv.status === 'paid') return this.reply(p, ClickErr.alreadyPaid, 'Already paid');
    if (inv.status === 'cancelled') return this.reply(p, ClickErr.cancelled, 'Transaction cancelled');
    if (Math.round(Number(p.amount) * 100) !== inv.amountUzs * 100) return this.reply(p, ClickErr.amount, 'Incorrect parameter amount');

    const [existing] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, 'click'), eq(payments.providerTxnId, p.click_trans_id)));
    const row =
      existing ??
      (
        await this.db
          .insert(payments)
          .values({ invoiceId: inv.id, provider: 'click', providerTxnId: p.click_trans_id, amountTiyin: Math.round(Number(p.amount) * 100), state: 1, providerTime: Date.now() })
          .returning()
      )[0];
    return this.reply(p, ClickErr.ok, 'Success', { merchant_prepare_id: row.id });
  }

  async complete(p: ClickParams) {
    if (p.action !== '1') return this.reply(p, ClickErr.action, 'Action not found');
    if (!this.cfg.CLICK_SECRET_KEY || clickSign(p, this.cfg.CLICK_SECRET_KEY) !== p.sign_string) return this.reply(p, ClickErr.sign, 'SIGN CHECK FAILED');
    const [row] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.provider, 'click'), eq(payments.id, Number(p.merchant_prepare_id))));
    if (!row || row.providerTxnId !== p.click_trans_id) return this.reply(p, ClickErr.txnNotFound, 'Transaction does not exist');
    const inv = await this.billing.invoiceById(row.invoiceId);
    if (!inv) return this.reply(p, ClickErr.notFound, 'Invoice not found');
    if (row.state === 2) return this.reply(p, ClickErr.alreadyPaid, 'Already paid', { merchant_confirm_id: row.id });
    if (row.state === -1) return this.reply(p, ClickErr.cancelled, 'Transaction cancelled');
    if (Math.round(Number(p.amount) * 100) !== Number(row.amountTiyin)) return this.reply(p, ClickErr.amount, 'Incorrect parameter amount');

    // Click сообщает об ошибке платежа отрицательным error: отменяем подготовленную транзакцию.
    if (Number(p.error) < 0) {
      await this.db.update(payments).set({ state: -1, cancelTime: Date.now() }).where(eq(payments.id, row.id));
      return this.reply(p, ClickErr.cancelled, 'Transaction cancelled');
    }
    if (inv.status === 'paid') return this.reply(p, ClickErr.alreadyPaid, 'Already paid');

    await this.db.update(payments).set({ state: 2, performTime: Date.now() }).where(eq(payments.id, row.id));
    await this.billing.markPaid(inv.id, 'click');
    return this.reply(p, ClickErr.ok, 'Success', { merchant_confirm_id: row.id });
  }
}
