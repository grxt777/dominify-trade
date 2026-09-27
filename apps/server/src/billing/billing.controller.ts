import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { companies, type Db } from '@dominify/db';
import { formatUzs, PLANS, uzsToTiyin, type PlanCode } from '@dominify/shared';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config';
import { AppError, ZodPipe } from '../common/http';
import { CurrentUser, Public, RateLimit, type AuthUser } from '../auth/guards';
import { CONFIG, DB } from '../infra/tokens';
import { UsersService } from '../users/users.service';
import { BillingService } from './billing.service';
import { ClickService, type ClickParams } from './click';
import { PaymeService } from './payme';

/** Тариф в Mini App: только статус и лимиты, без цен и кнопок оплаты (правила Telegram для цифровых услуг). */
@Controller('v1/billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly users: UsersService,
  ) {}

  @Get('plan')
  async plan(@CurrentUser() u: AuthUser, @Query('companyId') companyIdRaw?: string) {
    const companyId = companyIdRaw ? Number(companyIdRaw) : u.activeCompanyId;
    if (!companyId) throw new AppError('no_company', 'Нет активной компании');
    await this.users.assertMember(u.id, companyId);
    return this.billing.planInfo(companyId);
  }

  @Post('contact')
  @HttpCode(HttpStatus.OK)
  @RateLimit('billing-contact', 5, 86_400)
  async contact(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ companyId: z.number().int().positive(), note: z.string().max(500).optional() }))) body: { companyId: number; note?: string }) {
    await this.users.assertMember(u.id, body.companyId);
    return this.billing.contactManager(body.companyId, u.id, body.note);
  }
}

/** Вебхуки платёжных систем. Payme всегда получает HTTP 200 с JSON-RPC ответом. */
@Controller('webhooks')
export class PaymentWebhooksController {
  constructor(
    private readonly payme: PaymeService,
    private readonly click: ClickService,
  ) {}

  @Public()
  @Post('payme')
  @HttpCode(HttpStatus.OK)
  paymeRpc(@Body() body: { method: string; params: Record<string, unknown>; id: number }, @Headers('authorization') auth?: string) {
    return this.payme.handle(body, auth);
  }

  @Public()
  @Post('click/prepare')
  @HttpCode(HttpStatus.OK)
  clickPrepare(@Body() body: ClickParams) {
    return this.click.prepare(body);
  }

  @Public()
  @Post('click/complete')
  @HttpCode(HttpStatus.OK)
  clickComplete(@Body() body: ClickParams) {
    return this.click.complete(body);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Веб-страница счёта: ссылку отправляет менеджер. Здесь оплачивают картой через Payme или Click,
 * либо видят реквизиты для перевода с расчётного счёта.
 */
@Controller('pay')
export class PayPageController {
  constructor(
    private readonly billing: BillingService,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Public()
  @Get(':token')
  async page(@Param('token') token: string, @Res() res: Response) {
    const inv = await this.billing.invoiceByToken(token);
    if (!inv) {
      res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Счёт не найден.</p>');
      return;
    }
    const [c] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, inv.companyId));
    const plan = PLANS[inv.planCode as PlanCode];
    const back = `${this.cfg.PUBLIC_API_URL}/pay/${token}`;
    const buttons: string[] = [];
    if (inv.status === 'issued' && this.cfg.PAYME_MERCHANT_ID) {
      const params = `m=${this.cfg.PAYME_MERCHANT_ID};ac.invoice_id=${inv.id};a=${uzsToTiyin(inv.amountUzs)};l=ru;c=${back}`;
      buttons.push(`<a class="btn payme" href="${this.cfg.PAYME_CHECKOUT_URL}/${Buffer.from(params).toString('base64')}">Оплатить через Payme</a>`);
    }
    if (inv.status === 'issued' && this.cfg.CLICK_SERVICE_ID) {
      const q = new URLSearchParams({
        service_id: this.cfg.CLICK_SERVICE_ID,
        merchant_id: this.cfg.CLICK_MERCHANT_ID,
        amount: String(inv.amountUzs),
        transaction_param: String(inv.id),
        return_url: back,
      });
      buttons.push(`<a class="btn click" href="https://my.click.uz/services/pay?${q}">Оплатить через Click</a>`);
    }
    const status =
      inv.status === 'paid'
        ? '<p class="ok">Счёт оплачен. Тариф активирован.</p>'
        : inv.status === 'cancelled'
          ? '<p class="bad">Счёт отменён.</p>'
          : '';
    const requisites = this.cfg.BANK_REQUISITES
      ? `<h2>Оплата переводом</h2><pre>${esc(this.cfg.BANK_REQUISITES)}</pre><p class="muted">В назначении платежа укажите: «Оплата по счёту №${inv.id}».</p>`
      : '';
    res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Счёт №${inv.id} · Dominify Trade</title>
<style>
:root{--bg:#F2F4F6;--card:#fff;--ink:#12151A;--muted:#5A6472;--line:#D6DCE3;--accent:#0087B8}
@media (prefers-color-scheme:dark){:root{--bg:#0E1115;--card:#161A20;--ink:#E6EAEF;--muted:#97A2B0;--line:#2A313A;--accent:#38BDEB}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif;padding:24px 16px}
main{max-width:520px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 8px}.muted{color:var(--muted)}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:16px 0}dt{color:var(--muted)}dd{margin:0;font-weight:500}
.sum{font-size:28px;font-weight:700;margin:8px 0 16px}.btn{display:block;text-align:center;padding:14px;border-radius:12px;text-decoration:none;font-weight:600;margin-top:10px;color:#fff}
.payme{background:#00B2B8}.click{background:#0074E4}pre{white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:10px;font:14px/1.5 ui-monospace,monospace}
.ok{color:#1F8A5B;font-weight:600}.bad{color:#C8006F;font-weight:600}
</style></head><body><main>
<h1>Счёт №${inv.id}</h1><p class="muted">Dominify Trade</p>
<dl><dt>Компания</dt><dd>${esc(c?.name ?? '')}</dd><dt>Тариф</dt><dd>${esc(plan.name.ru)}</dd><dt>Период</dt><dd>${inv.months} × 30 дней</dd></dl>
<div class="sum">${formatUzs(inv.amountUzs)} сум</div>
${status}${buttons.join('')}${requisites}
</main></body></html>`);
  }
}
