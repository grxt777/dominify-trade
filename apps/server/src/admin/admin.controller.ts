import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import {
  aiUsage,
  auditLog,
  blacklist,
  categories,
  companies,
  deals,
  memberships,
  moderationItems,
  offers,
  requestDeliveries,
  requests,
  reviews,
  staff,
  subscriptions,
  users,
  type Db,
} from '@dominify/db';
import { PLAN_CODES, scoreCandidate, STAFF_ROLES, type PlanCode } from '@dominify/shared';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import { decrypt, lookupHash, normalizePhone } from '../common/crypto';
import { AppError, notFound, ZodPipe } from '../common/http';
import { CurrentUser, Staff, type AuthUser } from '../auth/guards';
import { BillingService } from '../billing/billing.service';
import { CatalogService } from '../catalog/catalog';
import { DealsService, resolveDealSchema, type ResolveDealDto } from '../deals/deals';
import { CONFIG, DB } from '../infra/tokens';
import { MatchingService } from '../matching/matching.service';
import { RequestsService } from '../requests/requests.service';

const likePattern = (q: string) => `%${q.slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;

@Controller('admin')
@Staff()
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly requests: RequestsService,
    private readonly matching: MatchingService,
    private readonly billing: BillingService,
    private readonly deals: DealsService,
    private readonly catalog: CatalogService,
  ) {}

  private audit(u: AuthUser, action: string, refType: string | null, refId: number | null, data: Record<string, unknown> = {}) {
    return this.db.insert(auditLog).values({ staffUserId: u.id, action, refType, refId, data });
  }

  // ── Метрики ──

  /** Главная метрика маркетплейса: доля заявок с 3+ откликами за 60 минут после отправки. */
  @Get('stats')
  async stats() {
    const q = async <T>(s: ReturnType<typeof sql>) => (await this.db.execute(s)).rows[0] as T;
    const liquidity = await q<{ total: number; good: number }>(sql`
      select count(*)::int as total,
             count(*) filter (where (select count(*) from offers o where o.request_id = r.id and o.created_at <= r.submitted_at + interval '60 minutes') >= 3)::int as good
      from requests r where r.submitted_at > now() - interval '30 days'`);
    const firstOffer = await q<{ median_min: number | null }>(sql`
      select percentile_cont(0.5) within group (order by extract(epoch from (fo - r.submitted_at)) / 60) as median_min
      from requests r join lateral (select min(created_at) fo from offers o where o.request_id = r.id) x on x.fo is not null
      where r.submitted_at > now() - interval '30 days'`);
    const counts = await q<Record<string, number>>(sql`
      select
        (select count(*)::int from requests where created_at > now() - interval '24 hours') as requests_24h,
        (select count(*)::int from requests where submitted_at > now() - interval '7 days') as submitted_7d,
        (select count(*)::int from offers where created_at > now() - interval '7 days') as offers_7d,
        (select count(*)::int from deals where created_at > now() - interval '30 days') as deals_30d,
        (select count(*)::int from companies where is_supplier) as suppliers,
        (select count(*)::int from subscriptions where plan_code <> 'free' and status in ('active','grace')) as paying,
        (select count(*)::int from users) as users,
        (select count(*)::int from moderation_items where status = 'open') as moderation_open`);
    const ai = await q<{ calls: number; failed: number; input: number; output: number }>(sql`
      select count(*)::int calls, count(*) filter (where not ok)::int failed,
             coalesce(sum(input_tokens),0)::int input, coalesce(sum(output_tokens),0)::int output
      from ai_usage where created_at > now() - interval '24 hours'`);
    const byStatus = (await this.db.execute(sql`select status, count(*)::int c from requests where created_at > now() - interval '30 days' group by status order by c desc`)).rows;
    return {
      liquidity: { ...liquidity, share: liquidity.total ? liquidity.good / liquidity.total : null },
      medianFirstOfferMin: firstOffer?.median_min ?? null,
      counts,
      ai24h: ai,
      byStatus,
    };
  }

  // ── Модерация ──

  @Get('moderation')
  async moderation(@Query('status') status = 'open') {
    return this.db.select().from(moderationItems).where(eq(moderationItems.status, status)).orderBy(desc(moderationItems.createdAt)).limit(200);
  }

  @Post('moderation/:id/resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ resolution: z.string().max(500).default('') }))) b: { resolution: string }) {
    await this.db.update(moderationItems).set({ status: 'resolved', resolution: b.resolution, resolvedByUserId: u.id, resolvedAt: new Date() }).where(eq(moderationItems.id, id));
    await this.audit(u, 'moderation.resolve', 'moderation', id, b);
    return { ok: true };
  }

  // ── Заявки ──

  @Get('requests')
  async listRequests(@Query('status') status?: string, @Query('q') q?: string) {
    return this.db
      .select({
        id: requests.id,
        title: requests.title,
        status: requests.status,
        source: requests.source,
        categoryId: requests.categoryId,
        regionCode: requests.regionCode,
        confidence: requests.confidence,
        wave: requests.wave,
        createdAt: requests.createdAt,
        author: users.firstName,
        offersCount: sql<number>`(select count(*)::int from ${offers} o where o.request_id = ${requests.id})`,
        deliveries: sql<number>`(select count(*)::int from ${requestDeliveries} d where d.request_id = ${requests.id})`,
      })
      .from(requests)
      .innerJoin(users, eq(users.id, requests.authorUserId))
      .where(
        and(
          status ? eq(requests.status, status) : undefined,
          q ? or(ilike(requests.rawText, likePattern(q)), ilike(requests.title, likePattern(q))) : undefined,
        ),
      )
      .orderBy(desc(requests.createdAt))
      .limit(200);
  }

  @Get('requests/:id')
  async getRequest(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const view = await this.requests.view(u.id, id);
    const deliveries = await this.db
      .select({
        companyId: requestDeliveries.supplierCompanyId,
        name: companies.name,
        wave: requestDeliveries.wave,
        score: requestDeliveries.score,
        manual: requestDeliveries.manual,
        notifyAt: requestDeliveries.notifyAt,
        seenAt: requestDeliveries.seenAt,
        respondedAt: requestDeliveries.respondedAt,
      })
      .from(requestDeliveries)
      .innerJoin(companies, eq(companies.id, requestDeliveries.supplierCompanyId))
      .where(eq(requestDeliveries.requestId, id))
      .orderBy(requestDeliveries.wave, desc(requestDeliveries.score));
    return { ...view, deliveries };
  }

  /** Кандидаты с баллами — для ручного подбора поставщиков. */
  @Get('requests/:id/candidates')
  async candidates(@Param('id', ParseIntPipe) id: number) {
    const { candidates } = await this.matching.candidates(id);
    const ids = candidates.map((c) => c.companyId);
    const names = ids.length ? await this.db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, ids)) : [];
    const nameMap = new Map(names.map((n) => [n.id, n.name]));
    return candidates
      .map((c) => ({ ...c, name: nameMap.get(c.companyId), score: scoreCandidate(c, new Date()) }))
      .sort((a, b) => b.score - a.score);
  }

  @Post('requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.requests.approve(id);
    await this.audit(u, 'request.approve', 'request', id);
    return { ok: true };
  }

  @Post('requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ reason: z.string().min(3).max(500) }))) b: { reason: string }) {
    await this.requests.reject(id, b.reason);
    await this.audit(u, 'request.reject', 'request', id, b);
    return { ok: true };
  }

  @Post('requests/:id/dispatch')
  @HttpCode(HttpStatus.OK)
  async dispatch(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ companyIds: z.array(z.number().int().positive()).min(1).max(30) }))) b: { companyIds: number[] }) {
    const n = await this.matching.manualDispatch(id, b.companyIds);
    await this.audit(u, 'request.dispatch', 'request', id, b);
    return { sent: n };
  }

  @Patch('requests/:id')
  async patchRequest(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(z.object({ categoryId: z.number().int().positive().optional(), title: z.string().max(200).optional(), regionCode: z.string().max(64).optional(), fields: z.record(z.string(), z.unknown()).optional() })))
    b: { categoryId?: number; title?: string; regionCode?: string; fields?: Record<string, unknown> },
  ) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, id));
    if (!req) throw notFound('Заявка');
    await this.db
      .update(requests)
      .set({ ...b, fields: b.fields ? { ...req.fields, ...b.fields } : req.fields, confidence: b.categoryId ? 1 : req.confidence, updatedAt: new Date() })
      .where(eq(requests.id, id));
    await this.audit(u, 'request.patch', 'request', id, b);
    return { ok: true };
  }

  // ── Компании ──

  @Get('companies')
  async listCompanies(@Query('q') q?: string, @Query('supplier') supplier?: string) {
    return this.db
      .select({
        id: companies.id,
        name: companies.name,
        type: companies.type,
        isSupplier: companies.isSupplier,
        regionCode: companies.regionCode,
        trustLevel: companies.trustLevel,
        innVerified: sql<boolean>`${companies.innVerifiedAt} is not null`,
        hasInn: sql<boolean>`${companies.innHash} is not null`,
        ratingAvg: companies.ratingAvg,
        dealsClosed: companies.dealsClosed,
        offersSent: companies.offersSent,
        blocked: companies.blocked,
        planCode: subscriptions.planCode,
        planStatus: subscriptions.status,
        periodEnd: subscriptions.periodEnd,
        createdAt: companies.createdAt,
      })
      .from(companies)
      .leftJoin(subscriptions, eq(subscriptions.companyId, companies.id))
      .where(and(q ? ilike(companies.name, likePattern(q)) : undefined, supplier === '1' ? eq(companies.isSupplier, true) : undefined))
      .orderBy(desc(companies.createdAt))
      .limit(300);
  }

  @Get('companies/:id')
  async getCompany(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const [c] = await this.db.select().from(companies).where(eq(companies.id, id));
    if (!c) throw notFound('Компания');
    const members = await this.db
      .select({ userId: users.id, firstName: users.firstName, username: users.username, role: memberships.role, phoneVerified: sql<boolean>`${users.phoneVerifiedAt} is not null`, phoneEnc: users.phoneEnc })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.companyId, id));
    await this.audit(u, 'company.view_pii', 'company', id);
    return {
      ...c,
      innEnc: undefined,
      innHash: undefined,
      inn: c.innEnc ? decrypt(c.innEnc, this.cfg.ENCRYPTION_KEY) : null,
      members: members.map((m) => ({ ...m, phoneEnc: undefined, phone: m.phoneEnc ? decrypt(m.phoneEnc, this.cfg.ENCRYPTION_KEY) : null })),
      plan: await this.billing.planInfo(id),
      invoices: await this.billing.listInvoices(id),
    };
  }

  /** ИНН проверен модератором по госреестру: уровень доверия L1. */
  @Post('companies/:id/verify-inn')
  @HttpCode(HttpStatus.OK)
  async verifyInn(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const [c] = await this.db.select().from(companies).where(eq(companies.id, id));
    if (!c?.innHash) throw new AppError('no_inn', 'У компании не указан ИНН');
    await this.db.update(companies).set({ innVerifiedAt: new Date() }).where(eq(companies.id, id));
    await this.deals.recomputeTrust(id);
    await this.audit(u, 'company.verify_inn', 'company', id);
    return { ok: true };
  }

  @Post('companies/:id/block')
  @HttpCode(HttpStatus.OK)
  async block(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ blocked: z.boolean() }))) b: { blocked: boolean }) {
    await this.db.update(companies).set({ blocked: b.blocked }).where(eq(companies.id, id));
    await this.audit(u, b.blocked ? 'company.block' : 'company.unblock', 'company', id);
    return { ok: true };
  }

  /** L3: оборот подтверждён банком. Ставится вручную после проверки документов. */
  @Post('companies/:id/trust')
  @HttpCode(HttpStatus.OK)
  @Staff('admin')
  async trust(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ level: z.number().int().min(0).max(3) }))) b: { level: number }) {
    await this.db.update(companies).set({ trustLevel: b.level }).where(eq(companies.id, id));
    await this.audit(u, 'company.trust', 'company', id, b);
    return { ok: true };
  }

  // ── Счета и подписки ──

  @Get('invoices')
  invoices(@Query('companyId') companyId?: string) {
    return this.billing.listInvoices(companyId ? Number(companyId) : undefined);
  }

  @Post('invoices')
  @Staff('admin', 'support')
  createInvoice(
    @CurrentUser() u: AuthUser,
    @Body(new ZodPipe(z.object({ companyId: z.number().int().positive(), planCode: z.enum(PLAN_CODES), months: z.number().int().min(1).max(12).default(1), note: z.string().max(500).optional() })))
    b: { companyId: number; planCode: PlanCode; months: number; note?: string },
  ) {
    return this.billing.createInvoice(u.id, b.companyId, b.planCode, b.months, b.note);
  }

  /** Оплата переводом сверена с выпиской банка. */
  @Post('invoices/:id/paid')
  @HttpCode(HttpStatus.OK)
  @Staff('admin')
  paid(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ via: z.enum(['bank_transfer', 'manual']).default('bank_transfer') }))) b: { via: 'bank_transfer' | 'manual' }) {
    return this.billing.markPaid(id, b.via, u.id);
  }

  @Post('invoices/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Staff('admin')
  async cancelInvoice(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    await this.billing.cancelInvoice(id, u.id);
    return { ok: true };
  }

  // ── Чёрный список, отзывы, каталог, команда ──

  @Post('blacklist')
  @HttpCode(HttpStatus.OK)
  async addBlacklist(
    @CurrentUser() u: AuthUser,
    @Body(new ZodPipe(z.object({ kind: z.enum(['phone', 'inn', 'telegram_id']), value: z.string().min(3).max(64), reason: z.string().max(500).optional() })))
    b: { kind: 'phone' | 'inn' | 'telegram_id'; value: string; reason?: string },
  ) {
    const kind = b.kind === 'phone' ? 'phone_hash' : b.kind === 'inn' ? 'inn_hash' : 'telegram_id';
    const value = b.kind === 'phone' ? lookupHash(normalizePhone(b.value), this.cfg.HASH_KEY) : b.kind === 'inn' ? lookupHash(b.value, this.cfg.HASH_KEY) : b.value;
    await this.db.insert(blacklist).values({ kind, value, reason: b.reason ?? null }).onConflictDoNothing();
    await this.audit(u, 'blacklist.add', null, null, { kind });
    return { ok: true };
  }

  @Post('reviews/:id/hide')
  @HttpCode(HttpStatus.OK)
  async hideReview(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const [r] = await this.db.update(reviews).set({ hidden: true }).where(eq(reviews.id, id)).returning();
    if (r?.targetCompanyId) await this.deals.recomputeRating(r.targetCompanyId);
    await this.audit(u, 'review.hide', 'review', id);
    return { ok: true };
  }

  /** Отзывы с признаками накрутки (и любые другие при flagged=0). */
  @Get('reviews')
  listReviews(@Query('flagged') flagged = '1') {
    return this.db
      .select({
        id: reviews.id,
        dealId: reviews.dealId,
        authorSide: reviews.authorSide,
        author: users.firstName,
        targetCompanyId: reviews.targetCompanyId,
        targetName: companies.name,
        stars: reviews.stars,
        text: reviews.text,
        counted: reviews.counted,
        hidden: reviews.hidden,
        flag: reviews.flag,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.authorUserId))
      .leftJoin(companies, eq(companies.id, reviews.targetCompanyId))
      .where(flagged === '1' ? sql`${reviews.flag} is not null` : undefined)
      .orderBy(desc(reviews.createdAt))
      .limit(200);
  }

  /** Модератор проверил отзыв: учитывать в рейтинге или нет. */
  @Post('reviews/:id/counted')
  @HttpCode(HttpStatus.OK)
  async setReviewCounted(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ counted: z.boolean() }))) b: { counted: boolean }) {
    const [r] = await this.db.update(reviews).set({ counted: b.counted }).where(eq(reviews.id, id)).returning();
    if (!r) throw notFound('Отзыв');
    if (r.targetCompanyId) await this.deals.recomputeRating(r.targetCompanyId);
    await this.db
      .update(moderationItems)
      .set({ status: 'resolved', resolution: b.counted ? 'counted' : 'not_counted', resolvedByUserId: u.id, resolvedAt: new Date() })
      .where(and(eq(moderationItems.refType, 'review'), eq(moderationItems.refId, id), eq(moderationItems.status, 'open')));
    await this.audit(u, 'review.counted', 'review', id, b);
    return { ok: true };
  }

  // ── Сделки и споры ──

  @Get('deals')
  listDeals(@Query('status') status = 'disputed') {
    return this.db
      .select({
        id: deals.id,
        requestId: deals.requestId,
        title: requests.title,
        status: deals.status,
        paymentStatus: deals.paymentStatus,
        amountUzs: deals.amountUzs,
        supplierCompanyId: deals.supplierCompanyId,
        supplierName: companies.name,
        buyer: users.firstName,
        buyerConfirmed: sql<boolean>`${deals.buyerConfirmedAt} is not null`,
        supplierConfirmed: sql<boolean>`${deals.supplierConfirmedAt} is not null`,
        closedBy: deals.closedBy,
        closeReason: deals.closeReason,
        disputedAt: deals.disputedAt,
        createdAt: deals.createdAt,
      })
      .from(deals)
      .innerJoin(requests, eq(requests.id, deals.requestId))
      .innerJoin(companies, eq(companies.id, deals.supplierCompanyId))
      .innerJoin(users, eq(users.id, deals.buyerUserId))
      .where(status === 'all' ? undefined : eq(deals.status, status))
      .orderBy(desc(deals.createdAt))
      .limit(200);
  }

  @Post('deals/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @Staff('admin', 'moderator')
  resolveDeal(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(resolveDealSchema)) b: ResolveDealDto) {
    return this.deals.resolve(u.id, id, b);
  }

  // ── Безопасная сделка: выплаты исполнителям и возвраты покупателям ──

  @Get('escrow')
  escrow(@Query('status') status = 'payout_due') {
    const allowed = ['awaiting', 'held', 'payout_due', 'refund_due', 'paid_out', 'refunded', 'all'];
    return this.deals.escrowList(allowed.includes(status) ? status : 'payout_due');
  }

  @Post('escrow/:id/payout')
  @HttpCode(HttpStatus.OK)
  @Staff('admin')
  payout(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.settle(u.id, id, 'payout');
  }

  @Post('escrow/:id/refund')
  @HttpCode(HttpStatus.OK)
  @Staff('admin')
  refund(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.deals.settle(u.id, id, 'refund');
  }

  @Get('categories')
  categoriesTree() {
    return this.catalog.tree();
  }

  @Patch('categories/:id')
  @Staff('admin')
  async patchCategory(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodPipe(z.object({ active: z.boolean().optional(), keywords: z.string().max(2000).optional(), fields: z.array(z.any()).optional() })))
    b: { active?: boolean; keywords?: string; fields?: unknown[] },
  ) {
    await this.db
      .update(categories)
      .set({ ...(b as Partial<typeof categories.$inferInsert>), editedAt: new Date() })
      .where(eq(categories.id, id));
    this.catalog.invalidate();
    await this.audit(u, 'category.patch', 'category', id, b);
    return { ok: true };
  }

  @Get('staff')
  listStaff() {
    return this.db
      .select({ userId: staff.userId, role: staff.role, firstName: users.firstName, username: users.username, telegramId: users.telegramId })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId));
  }

  @Post('staff')
  @Staff('admin')
  async addStaff(
    @CurrentUser() u: AuthUser,
    @Body(new ZodPipe(z.object({ telegramId: z.number().int().positive(), role: z.enum(STAFF_ROLES) }))) b: { telegramId: number; role: string },
  ) {
    const [target] = await this.db.select().from(users).where(eq(users.telegramId, b.telegramId));
    if (!target) throw new AppError('no_user', 'Пользователь ещё не заходил в бота');
    await this.db.insert(staff).values({ userId: target.id, role: b.role }).onConflictDoUpdate({ target: staff.userId, set: { role: b.role } });
    await this.audit(u, 'staff.add', 'user', target.id, b);
    return { ok: true };
  }

  @Delete('staff/:userId')
  @Staff('admin')
  async removeStaff(@CurrentUser() u: AuthUser, @Param('userId', ParseIntPipe) userId: number) {
    if (userId === u.id) throw new AppError('self', 'Нельзя удалить себя');
    await this.db.delete(staff).where(eq(staff.userId, userId));
    await this.audit(u, 'staff.remove', 'user', userId);
    return { ok: true };
  }

  @Get('audit')
  auditList() {
    return this.db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(300);
  }

  @Get('ai-usage')
  aiUsageList() {
    return this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${aiUsage.createdAt}), 'YYYY-MM-DD')`,
        model: aiUsage.model,
        calls: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where not ${aiUsage.ok})::int`,
        input: sql<number>`sum(${aiUsage.inputTokens})::int`,
        output: sql<number>`sum(${aiUsage.outputTokens})::int`,
      })
      .from(aiUsage)
      .where(sql`${aiUsage.createdAt} > now() - interval '30 days'`)
      .groupBy(sql`1`, aiUsage.model)
      .orderBy(sql`1 desc`);
  }
}
