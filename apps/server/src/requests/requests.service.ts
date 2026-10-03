import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  companies,
  deals,
  files,
  gigs,
  memberships,
  moderationItems,
  offers,
  requestDeliveries,
  requestFiles,
  requests,
  users,
  type Db,
} from '@dominify/db';
import {
  missingRequired,
  OPEN_REQUEST_STATUSES,
  pickLang,
  type Lang,
  type ParseRequestDto,
  type SubmitRequestDto,
} from '@dominify/shared';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import type { Config } from '../config';
import { AppError, forbidden, notFound } from '../common/http';
import { CatalogService } from '../catalog/catalog';
import { FilesService } from '../files/files';
import { GigsService } from '../gigs/gigs';
import { Analytics } from '../infra/infra.module';
import { QueueService } from '../infra/queues';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { CONFIG, DB, REDIS } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import type { ParseOutcome } from '../parsing/parsing.service';
import { RequestAccess } from './access';
import { summarize } from './summary';

type RequestRow = typeof requests.$inferSelect;

/** После стольких ответов бот перестаёт спрашивать: остальное покупатель заполняет в форме. */
const MAX_CLARIFICATIONS = 4;
/** Столько же, сколько допускает схема заявки из Mini App. */
const MAX_REQUEST_FILES = 10;

@Injectable()
export class RequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(REDIS) private readonly redis: IORedis,
    private readonly catalog: CatalogService,
    private readonly queues: QueueService,
    private readonly realtime: RealtimeEmitter,
    private readonly notifications: NotificationsService,
    private readonly access: RequestAccess,
    private readonly analytics: Analytics,
    private readonly files: FilesService,
    private readonly gigs: GigsService,
  ) {}

  /** Черновик из текста и вложений; разбор идёт в воркере, результат придёт по WebSocket или в чат бота. */
  async createDraft(userId: number, dto: ParseRequestDto, source: 'miniapp' | 'bot' = 'miniapp', parseDelayMs = 0) {
    if (!dto.text && dto.fileIds.length === 0 && !dto.gigId) throw new AppError('empty', 'Опишите, что нужно, или приложите фото');
    await this.files.assertOwnReady(userId, dto.fileIds);
    let order: { gigId: number; gigPackage: string | null; preferredCompanyId: number; title: string } | null = null;
    if (dto.gigId) {
      const { gig, pkg } = await this.gigs.packageFor(dto.gigId, dto.packageCode);
      const [own] = await this.db
        .select({ id: memberships.companyId })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.companyId, gig.companyId)))
        .limit(1);
      if (own) throw new AppError('own_gig', 'Нельзя заказать собственную услугу');
      order = { gigId: gig.id, gigPackage: pkg?.code ?? null, preferredCompanyId: gig.companyId, title: gig.title };
    }
    await this.chargeParse(userId);
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    let regionCode = dto.regionCode ?? null;
    let buyerCompanyId: number | null = null;
    if (u?.activeCompanyId) {
      const [c] = await this.db.select().from(companies).where(eq(companies.id, u.activeCompanyId));
      if (c) {
        buyerCompanyId = c.id;
        regionCode = regionCode ?? c.regionCode;
      }
    }
    const [row] = await this.db
      .insert(requests)
      .values({
        authorUserId: userId,
        buyerCompanyId,
        rawText: dto.text || order?.title || '',
        source,
        regionCode,
        lang: u?.lang ?? 'ru',
        status: 'draft',
        gigId: order?.gigId ?? null,
        gigPackage: order?.gigPackage ?? null,
        preferredCompanyId: order?.preferredCompanyId ?? null,
      })
      .returning();
    if (dto.fileIds.length) await this.db.insert(requestFiles).values(dto.fileIds.map((fileId) => ({ requestId: row.id, fileId })));
    await this.queues.parse({ requestId: row.id }, parseDelayMs);
    this.analytics.track('request.created', userId, { requestId: row.id, source, gigId: order?.gigId });
    return this.view(userId, row.id);
  }

  /**
   * Следующее фото из того же альбома Telegram: прикрепляем к уже созданному черновику, а не создаём новую заявку.
   * Подпись альбома может прийти с любым фото — дописываем её к тексту.
   */
  async attachToDraft(userId: number, requestId: number, fileIds: number[], caption?: string) {
    const req = await this.own(userId, requestId);
    await this.files.assertOwnReady(userId, fileIds);
    const [{ c }] = await this.db.select({ c: sql<number>`count(*)::int` }).from(requestFiles).where(eq(requestFiles.requestId, requestId));
    if (c + fileIds.length > MAX_REQUEST_FILES) return;
    if (fileIds.length) await this.db.insert(requestFiles).values(fileIds.map((fileId) => ({ requestId, fileId }))).onConflictDoNothing();
    if (caption && req.status === 'draft') {
      await this.db
        .update(requests)
        .set({ rawText: req.rawText ? `${req.rawText}\n${caption}` : caption, updatedAt: new Date() })
        .where(eq(requests.id, requestId));
    }
  }

  /** Ответ на уточняющий вопрос: дописываем к заявке и разбираем заново. */
  async answer(userId: number, requestId: number, answer: string) {
    const req = await this.own(userId, requestId);
    if (!['draft', 'needs_info'].includes(req.status)) throw new AppError('bad_status', 'Заявка уже отправлена');
    if (req.answers.length >= MAX_CLARIFICATIONS) {
      throw new AppError('too_many_answers', 'Достаточно уточнений: заполните оставшиеся поля в приложении и отправьте заявку', HttpStatus.CONFLICT);
    }
    await this.chargeParse(userId);
    await this.db
      .update(requests)
      .set({ answers: [...req.answers, { q: req.question ?? '', a: answer }], status: 'draft', updatedAt: new Date() })
      .where(eq(requests.id, requestId));
    await this.queues.parse({ requestId });
    return this.view(userId, requestId);
  }

  /**
   * Каждый разбор — платный вызов LLM. Считаем вызовы (а не заявки) за сутки по Ташкенту:
   * иначе лимит обходится бесконечными ответами на уточняющие вопросы.
   */
  private async chargeParse(userId: number) {
    const day = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
    const key = `parse:${userId}:${day}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 2 * 86_400);
    if (n > this.cfg.AI_DAILY_PARSE_LIMIT_PER_USER) {
      throw new AppError('daily_limit', 'На сегодня лимит заявок исчерпан. Если это ошибка, напишите в поддержку.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Вызывается воркером после разбора: сообщить автору в Mini App и, если заявка из бота, в чат. */
  async afterParse(requestId: number, outcome: ParseOutcome) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req) return;
    this.realtime.toUser(req.authorUserId, 'request.updated', { id: requestId, status: req.status });
    if (req.source !== 'bot') return;
    const lang = pickLang(req.lang) as Lang;
    if (outcome.status === 'needs_info' && req.question) {
      // Следующее текстовое сообщение в боте будет ответом на этот вопрос.
      await this.redis.set(`await:${req.authorUserId}`, String(requestId), 'EX', 86_400);
      await this.notifications.notify(req.authorUserId, 'request_question', { requestId, question: req.question }, { urgent: true });
    } else {
      await this.redis.del(`await:${req.authorUserId}`);
      const defs = req.categoryId ? await this.catalog.fieldsFor(req.categoryId) : [];
      await this.notifications.notify(
        req.authorUserId,
        'request_parsed',
        { requestId, title: req.title, summary: summarize(req, defs, lang) },
        { urgent: true },
      );
    }
  }

  /** Отправить заявку поставщикам. Ручные правки полей из Mini App применяются здесь. */
  async submit(userId: number, dto: SubmitRequestDto) {
    const req = await this.own(userId, dto.requestId);
    if (!['draft', 'needs_info'].includes(req.status)) throw new AppError('bad_status', 'Заявка уже отправлена');

    const categoryId = dto.categoryId ?? req.categoryId;
    if (!categoryId) throw new AppError('no_category', 'Выберите категорию');
    const cat = await this.catalog.byId(categoryId);
    if (!cat) throw new AppError('bad_category', 'Категория не найдена');
    const fields = { ...req.fields, ...(dto.fields ?? {}) };
    const defs = await this.catalog.fieldsFor(categoryId);
    const missing = missingRequired(defs, fields);
    if (missing.length) {
      const lang = pickLang(req.lang) as Lang;
      throw new AppError('missing_fields', `Заполните: ${missing.map((m) => m.label[lang]).join(', ')}`);
    }
    const manualCategory = dto.categoryId !== undefined && dto.categoryId !== req.categoryId;
    const lowConfidence = !manualCategory && (req.confidence ?? 0) < this.cfg.LLM_CONFIDENCE_THRESHOLD;
    const status = lowConfidence ? 'moderation' : 'submitted';
    const now = new Date();

    await this.db
      .update(requests)
      .set({
        categoryId,
        fields,
        regionCode: dto.regionCode ?? req.regionCode ?? 'tashkent',
        title: dto.title ?? req.title ?? cat.name.ru,
        deadline: dto.deadline !== undefined ? dto.deadline : req.deadline,
        budgetUzs: dto.budgetUzs !== undefined ? dto.budgetUzs : req.budgetUzs,
        quantity: typeof fields.quantity === 'number' ? fields.quantity : req.quantity,
        missingFields: [],
        question: null,
        status,
        submittedAt: now,
        expiresAt: new Date(now.getTime() + this.cfg.REQUEST_TTL_DAYS * 86_400_000),
        updatedAt: now,
      })
      .where(eq(requests.id, req.id));

    if (lowConfidence) {
      await this.db.insert(moderationItems).values({
        kind: 'request_low_confidence',
        refType: 'request',
        refId: req.id,
        note: `Уверенность разбора ${(req.confidence ?? 0).toFixed(2)}`,
      });
      await this.notifications.notify(userId, 'request_moderation', { requestId: req.id }, { urgent: true });
    } else {
      await this.queues.dispatch({ requestId: req.id, wave: 1 });
      await this.notifications.notify(userId, 'request_submitted', { requestId: req.id }, { urgent: true, respectOnline: true });
    }
    this.analytics.track('request.submitted', userId, { requestId: req.id, moderation: lowConfidence });
    return this.view(userId, req.id);
  }

  /** Модератор одобрил заявку: уходит в рассылку. */
  async approve(requestId: number) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req) throw notFound('Заявка');
    if (req.status !== 'moderation') throw new AppError('bad_status', 'Заявка не на модерации');
    await this.db.update(requests).set({ status: 'submitted', updatedAt: new Date() }).where(eq(requests.id, requestId));
    await this.queues.dispatch({ requestId, wave: 1 });
    await this.notifications.notify(req.authorUserId, 'request_submitted', { requestId }, { urgent: true });
  }

  async reject(requestId: number, reason: string) {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req) throw notFound('Заявка');
    await this.db
      .update(requests)
      .set({ status: 'rejected', moderationReason: reason, closedAt: new Date(), updatedAt: new Date() })
      .where(eq(requests.id, requestId));
    await this.notifications.notify(req.authorUserId, 'request_rejected', { requestId, reason }, { urgent: true });
  }

  async cancel(userId: number, requestId: number) {
    const req = await this.own(userId, requestId);
    if (['supplier_chosen', 'completed', 'reviewed', 'cancelled'].includes(req.status)) throw new AppError('bad_status', 'Эту заявку уже нельзя отменить');
    await this.db
      .update(requests)
      .set({ status: 'cancelled', closedAt: new Date(), updatedAt: new Date() })
      .where(eq(requests.id, requestId));
    this.realtime.toRequest(requestId, 'request.updated', { id: requestId, status: 'cancelled' });
    return this.view(userId, requestId);
  }

  async listMine(userId: number) {
    const rows = await this.db
      .select({
        id: requests.id,
        title: requests.title,
        status: requests.status,
        categoryId: requests.categoryId,
        createdAt: requests.createdAt,
        offersCount: sql<number>`(select count(*)::int from ${offers} o where o.request_id = ${requests.id} and o.status <> 'withdrawn')`,
        bestPrice: sql<number | null>`(select min(o.price_uzs)::bigint from ${offers} o where o.request_id = ${requests.id} and o.status <> 'withdrawn')`,
      })
      .from(requests)
      .where(and(eq(requests.authorUserId, userId), sql`${requests.status} <> 'cancelled'`))
      .orderBy(desc(requests.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r, bestPrice: r.bestPrice === null ? null : Number(r.bestPrice) }));
  }

  /** Лента поставщика: разосланные его компании заявки, у которых наступило время показа. */
  async feed(userId: number, companyId: number) {
    const rows = await this.db
      .select({
        id: requests.id,
        title: requests.title,
        status: requests.status,
        categoryId: requests.categoryId,
        regionCode: requests.regionCode,
        deadline: requests.deadline,
        budgetUzs: requests.budgetUzs,
        quantity: requests.quantity,
        createdAt: requests.createdAt,
        wave: requestDeliveries.wave,
        seenAt: requestDeliveries.seenAt,
        notifyAt: requestDeliveries.notifyAt,
        myOfferStatus: offers.status,
        myOfferPrice: offers.priceUzs,
      })
      .from(requestDeliveries)
      .innerJoin(requests, eq(requests.id, requestDeliveries.requestId))
      .leftJoin(offers, and(eq(offers.requestId, requests.id), eq(offers.supplierCompanyId, companyId)))
      .where(and(eq(requestDeliveries.supplierCompanyId, companyId), lte(requestDeliveries.notifyAt, new Date())))
      .orderBy(desc(requestDeliveries.notifyAt))
      .limit(100);
    return rows.map((r) => ({ ...r, isOpen: (OPEN_REQUEST_STATUSES as string[]).includes(r.status), isNew: !r.seenAt }));
  }

  /** Карточка заявки с учётом роли: автор видит отклики, поставщик — свой отклик, команда — всё. */
  async view(userId: number, requestId: number) {
    const role = await this.access.roleOf(userId, requestId);
    if (!role) throw notFound('Заявка');
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    const defs = req.categoryId ? await this.catalog.fieldsFor(req.categoryId) : [];
    const cat = req.categoryId ? await this.catalog.byId(req.categoryId) : undefined;
    const fileRows = await this.db
      .select({ id: files.id, mime: files.mime, fileName: files.fileName })
      .from(requestFiles)
      .innerJoin(files, eq(files.id, requestFiles.fileId))
      .where(eq(requestFiles.requestId, requestId));
    const order = req.gigId ? await this.orderOf(req.gigId, req.gigPackage) : null;

    const base = {
      id: req.id,
      title: req.title,
      status: req.status,
      source: req.source,
      rawText: req.rawText,
      lang: req.lang,
      category: cat ? { id: cat.id, slug: cat.slug, name: cat.name } : null,
      fieldDefs: defs,
      fields: Object.fromEntries(Object.entries(req.fields).filter(([k]) => !k.startsWith('_'))),
      duplicateOf: (req.fields._duplicateOf as number | undefined) ?? null,
      regionCode: req.regionCode,
      deadline: req.deadline,
      budgetUzs: req.budgetUzs,
      quantity: req.quantity,
      files: fileRows,
      createdAt: req.createdAt,
      submittedAt: req.submittedAt,
      expiresAt: req.expiresAt,
      wave: req.wave,
      order,
    };

    if (role.kind === 'supplier') {
      await this.db
        .update(requestDeliveries)
        .set({ seenAt: sql`coalesce(${requestDeliveries.seenAt}, now())` })
        .where(eq(requestDeliveries.id, role.deliveryId));
      const [mine] = await this.db
        .select()
        .from(offers)
        .where(and(eq(offers.requestId, requestId), eq(offers.supplierCompanyId, role.companyId)));
      const [buyer] = req.buyerCompanyId
        ? await this.db.select({ name: companies.name, trustLevel: companies.trustLevel }).from(companies).where(eq(companies.id, req.buyerCompanyId))
        : [];
      const [author] = await this.db.select({ firstName: users.firstName }).from(users).where(eq(users.id, req.authorUserId));
      const [deal] = await this.db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.requestId, requestId), eq(deals.supplierCompanyId, role.companyId)))
        .orderBy(desc(deals.createdAt))
        .limit(1);
      return {
        ...base,
        rawText: undefined,
        role: 'supplier' as const,
        companyId: role.companyId,
        buyer: { name: buyer?.name ?? author?.firstName ?? 'Покупатель', trustLevel: buyer?.trustLevel ?? 0 },
        myOffer: mine ?? null,
        dealId: deal?.id ?? null,
        isOpen: (OPEN_REQUEST_STATUSES as string[]).includes(req.status),
      };
    }

    const offerRows = await this.offersFor(requestId);
    const [deal] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.requestId, requestId), sql`${deals.status} <> 'cancelled'`))
      .limit(1);
    return {
      ...base,
      role: role.kind,
      confidence: req.confidence,
      missingFields: req.missingFields,
      question: req.question,
      answers: req.answers,
      offers: offerRows,
      dealId: deal?.id ?? null,
    };
  }

  /** Заказ с витрины: что именно выбрал покупатель. Услугу могли снять — тогда блока нет. */
  private async orderOf(gigId: number, packageCode: string | null) {
    const [g] = await this.db
      .select({ id: gigs.id, title: gigs.title, cover: gigs.cover, packages: gigs.packages, companyId: companies.id, companyName: companies.name })
      .from(gigs)
      .innerJoin(companies, eq(companies.id, gigs.companyId))
      .where(eq(gigs.id, gigId));
    if (!g) return null;
    const pkg = g.packages.find((p) => p.code === packageCode) ?? null;
    return {
      gigId: g.id,
      title: g.title,
      cover: g.cover,
      companyId: g.companyId,
      companyName: g.companyName,
      package: pkg ? { code: pkg.code, name: pkg.name, priceUzs: pkg.priceUzs, days: pkg.days, revisions: pkg.revisions, features: pkg.features } : null,
    };
  }

  private async offersFor(requestId: number) {
    return this.db
      .select({
        id: offers.id,
        priceUzs: offers.priceUzs,
        leadTimeDays: offers.leadTimeDays,
        comment: offers.comment,
        status: offers.status,
        fileIds: offers.fileIds,
        createdAt: offers.createdAt,
        supplier: {
          id: companies.id,
          name: companies.name,
          trustLevel: companies.trustLevel,
          ratingAvg: companies.ratingAvg,
          ratingCount: companies.ratingCount,
          dealsClosed: companies.dealsClosed,
          medianResponseMin: companies.medianResponseMin,
        },
      })
      .from(offers)
      .innerJoin(companies, eq(companies.id, offers.supplierCompanyId))
      .where(and(eq(offers.requestId, requestId), sql`${offers.status} <> 'withdrawn'`))
      .orderBy(offers.priceUzs);
  }

  private async own(userId: number, requestId: number): Promise<RequestRow> {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req) throw notFound('Заявка');
    if (req.authorUserId !== userId) throw forbidden('Это не ваша заявка');
    return req;
  }

  /** Ежечасная задача: открытые заявки без выбора исполнителя за REQUEST_TTL_DAYS закрываются. */
  async expireOld(): Promise<number> {
    const rows = await this.db
      .update(requests)
      .set({ status: 'expired', closedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(requests.status, OPEN_REQUEST_STATUSES), lte(requests.expiresAt, new Date())))
      .returning({ id: requests.id, authorUserId: requests.authorUserId });
    for (const r of rows) await this.notifications.notify(r.authorUserId, 'request_expired', { requestId: r.id });
    return rows.length;
  }
}
