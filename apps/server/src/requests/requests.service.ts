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
  DEFAULT_WAVES,
  missingRequired,
  OPEN_REQUEST_STATUSES,
  type FieldDef,
  pickLang,
  type AnswerRequestDto,
  type Lang,
  type ParseRequestDto,
  type SubmitRequestDto,
} from '@dominify/shared';
import { and, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
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
import { MAX_QUESTIONS, nextAsk, SLOT_KEYS, type Ask } from './clarify';
import { RequestAccess } from './access';
import { summarize } from './summary';

type RequestRow = typeof requests.$inferSelect;
/** Какие вопросы уже задавали (в том числе пропущенные). */
const askedOf = (req: RequestRow): string[] => (Array.isArray(req.fields._asked) ? (req.fields._asked as string[]) : []);
/** Воронка подбора одной волны: сколько поставщиков рассмотрели и сколько получили заявку. */
type Funnel = { pool: number; region: number; ready: number; sent: number };

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

  /**
   * Ответ на уточняющий вопрос. Ответ кнопкой (field/value) или «Пропустить» записываем сразу —
   * без вызова ИИ и без ожидания; свободный текст дописываем к заявке и разбираем заново.
   */
  async answer(userId: number, requestId: number, dto: AnswerRequestDto | string) {
    const d: Partial<AnswerRequestDto> & { answer: string } = typeof dto === 'string' ? { answer: dto } : dto;
    const req = await this.own(userId, requestId);
    if (!['draft', 'needs_info'].includes(req.status)) throw new AppError('bad_status', 'Заявка уже отправлена');
    if (req.answers.length >= MAX_QUESTIONS) {
      throw new AppError('too_many_answers', 'Достаточно уточнений: проверьте детали и отправьте заявку', HttpStatus.CONFLICT);
    }
    const defs = req.categoryId ? await this.catalog.fieldsFor(req.categoryId) : [];
    const ask = this.askOf(req, defs);
    if (d.field !== undefined && (await this.applyQuick(req, defs, ask, d))) return this.view(userId, requestId);
    if (!d.answer) throw new AppError('empty', 'Напишите ответ');

    await this.chargeParse(userId);
    const fields = { ...req.fields };
    // Необязательный вопрос, на который ответили текстом, второй раз не задаём — даже если модель не поняла ответ.
    if (ask?.optional) fields._asked = [...askedOf(req), ask.key];
    await this.db
      .update(requests)
      // confidence = null — признак «идёт разбор»: Mini App показывает, что ИИ учитывает ответ.
      .set({ fields, answers: [...req.answers, { q: ask?.text ?? req.question ?? '', a: d.answer }], status: 'draft', confidence: null, updatedAt: new Date() })
      .where(eq(requests.id, requestId));
    await this.queues.parse({ requestId });
    return this.view(userId, requestId);
  }

  /** Ответ кнопкой или пропуск. Значение проверяем по типу параметра или по шаблону категории. */
  private async applyQuick(req: RequestRow, defs: FieldDef[], ask: Ask | null, d: Partial<AnswerRequestDto> & { answer: string }): Promise<boolean> {
    const key = d.field!;
    const v = d.value;
    const fields: Record<string, unknown> = { ...req.fields };
    const patch: Partial<typeof requests.$inferInsert> = {};
    let shown = d.answer;

    if (d.skip) {
      if (!(SLOT_KEYS as readonly string[]).includes(key)) return false;
      shown = '—';
    } else if (key === 'quantity' && typeof v === 'number' && v > 0) {
      fields.quantity = Math.round(v);
      patch.quantity = Math.round(v);
    } else if (key === 'deadline' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      patch.deadline = v;
    } else if (key === 'budget' && typeof v === 'number' && v > 0) {
      patch.budgetUzs = Math.round(v);
    } else if (key === 'delivery' && typeof v === 'boolean') {
      patch.deliveryNeeded = v;
      if (!v) Object.assign(patch, { deliveryLat: null, deliveryLng: null, deliveryAddress: null });
    } else if (key === 'location' && v && typeof v === 'object') {
      Object.assign(patch, { deliveryNeeded: true, deliveryLat: v.lat, deliveryLng: v.lng, deliveryAddress: v.address ?? null });
      shown = v.address || `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}`;
    } else {
      const def = defs.find((x) => x.key === key);
      if (!def || v === undefined || typeof v === 'object') return false;
      if (def.type === 'select' && !def.options?.some((o) => o.value === v)) return false;
      if (def.type === 'boolean' && typeof v !== 'boolean') return false;
      if (def.type === 'number' && typeof v !== 'number') return false;
      fields[key] = v;
      if (key === 'quantity' && typeof v === 'number') patch.quantity = v;
    }

    delete fields._ask;
    fields._asked = [...new Set([...askedOf(req), key])];
    const miss = missingRequired(defs, fields);
    const lang = pickLang(req.lang) as Lang;
    await this.db
      .update(requests)
      .set({
        ...patch,
        fields,
        answers: [...req.answers, { q: ask?.key === key ? ask.text : (req.question ?? ''), a: shown || String(v) }],
        missingFields: miss.map((m) => m.key),
        // Поле question читает бот: там спрашиваем только обязательное.
        question: miss[0] ? (miss[0].ask?.[lang] ?? `${miss[0].label[lang]}?`) : null,
        status: miss.length || !req.categoryId ? 'needs_info' : 'draft',
        updatedAt: new Date(),
      })
      .where(eq(requests.id, req.id));
    this.realtime.toUser(req.authorUserId, 'request.updated', { id: req.id });
    return true;
  }

  /** Следующий вопрос ИИ к черновику. */
  private askOf(req: RequestRow, defs: FieldDef[]): Ask | null {
    return nextAsk({
      lang: pickLang(req.lang) as Lang,
      categoryKnown: !!req.categoryId,
      freeQuestion: req.categoryId ? null : req.question,
      defs,
      fields: req.fields,
      quantity: req.quantity,
      deadline: req.deadline,
      budgetUzs: req.budgetUzs,
      deliveryNeeded: req.deliveryNeeded,
      hasDeliveryPoint: req.deliveryLat != null,
      asked: askedOf(req),
      answers: req.answers.length,
      llmQuestion: req.question,
      today: new Date(),
    });
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
    const fields: Record<string, unknown> = { ...req.fields, ...(dto.fields ?? {}) };
    delete fields._ask;
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
        ...(dto.deliveryNeeded !== undefined && { deliveryNeeded: dto.deliveryNeeded }),
        ...(dto.deliveryNeeded === false && { deliveryLat: null, deliveryLng: null, deliveryAddress: null }),
        ...(dto.delivery && { deliveryNeeded: true, deliveryLat: dto.delivery.lat, deliveryLng: dto.delivery.lng, deliveryAddress: dto.delivery.address ?? null }),
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
      delivery: {
        needed: req.deliveryNeeded,
        lat: req.deliveryLat,
        lng: req.deliveryLng,
        address: req.deliveryAddress,
      },
      files: fileRows,
      createdAt: req.createdAt,
      submittedAt: req.submittedAt,
      expiresAt: req.expiresAt,
      wave: req.wave,
      order,
    };

    if (role.kind === 'supplier') {
      const firstSeen = await this.db
        .update(requestDeliveries)
        .set({ seenAt: new Date() })
        .where(and(eq(requestDeliveries.id, role.deliveryId), isNull(requestDeliveries.seenAt)))
        .returning({ id: requestDeliveries.id });
      // Покупатель видит, что заявку открыли: счётчик «смотрят» растёт у него на глазах.
      if (firstSeen.length) this.realtime.toRequest(requestId, 'request.progress', { id: requestId });
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
    const progress = req.submittedAt ? await this.progressOf(req, offerRows.length) : null;
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
      ask: ['draft', 'needs_info'].includes(req.status) ? this.askOf(req, defs) : null,
      answers: req.answers,
      offers: offerRows,
      progress,
      dealId: deal?.id ?? null,
    };
  }

  /**
   * Как идёт рассылка — для экрана ожидания покупателя. Только реальные данные:
   * воронка подбора, записанная при рассылке, и записи request_deliveries.
   */
  private async progressOf(req: RequestRow, offersCount: number) {
    const [d] = await this.db
      .select({
        delivered: sql<number>`count(*)::int`,
        notified: sql<number>`(count(*) filter (where ${requestDeliveries.notifyAt} <= now()))::int`,
        seen: sql<number>`(count(*) filter (where ${requestDeliveries.seenAt} is not null))::int`,
        nextNotifyAt: sql<string | null>`min(${requestDeliveries.notifyAt}) filter (where ${requestDeliveries.notifyAt} > now())`,
        firstAt: sql<string | null>`min(${requestDeliveries.createdAt})`,
        typicalMin: sql<number | null>`percentile_cont(0.5) within group (order by ${companies.medianResponseMin})::int`,
      })
      .from(requestDeliveries)
      .innerJoin(companies, eq(companies.id, requestDeliveries.supplierCompanyId))
      .where(eq(requestDeliveries.requestId, req.id));
    const funnel = (req.fields._funnel as Record<string, Funnel> | undefined) ?? {};
    const secondWaveAt =
      req.wave === 1 && offersCount < DEFAULT_WAVES.minOffersAfterWave1 && d.firstAt
        ? new Date(new Date(d.firstAt).getTime() + this.cfg.WAVE1_WAIT_MIN * 60_000).toISOString()
        : null;
    return {
      funnel: funnel['1'] ?? null,
      funnel2: funnel['2'] ?? null,
      delivered: d.delivered,
      notified: d.notified,
      seen: d.seen,
      offers: offersCount,
      nextNotifyAt: d.nextNotifyAt,
      secondWaveAt,
      typicalResponseMin: d.typicalMin,
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
