import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import type { FieldDef, I18nText } from '@dominify/shared';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: 'number' });

// ───────────────────────── Люди и компании ─────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  firstName: varchar('first_name', { length: 128 }),
  lastName: varchar('last_name', { length: 128 }),
  username: varchar('username', { length: 64 }),
  lang: varchar('lang', { length: 8 }).notNull().default('ru'),
  phoneEnc: text('phone_enc'),
  phoneHash: varchar('phone_hash', { length: 64 }),
  phoneVerifiedAt: ts('phone_verified_at'),
  activeRole: varchar('active_role', { length: 16 }).notNull().default('buyer'),
  activeCompanyId: integer('active_company_id'),
  botStarted: boolean('bot_started').notNull().default(false),
  botBlocked: boolean('bot_blocked').notNull().default(false),
  consentAt: ts('consent_at'),
  lastSeenAt: ts('last_seen_at'),
  createdAt: createdAt(),
});

export const staff = pgTable('staff', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).notNull(),
  createdAt: createdAt(),
});

export const companies = pgTable(
  'companies',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    type: varchar('type', { length: 16 }).notNull().default('llc'),
    innEnc: text('inn_enc'),
    innHash: varchar('inn_hash', { length: 64 }),
    innVerifiedAt: ts('inn_verified_at'),
    regionCode: varchar('region_code', { length: 64 }).notNull().default('tashkent'),
    about: text('about'),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isBuyer: boolean('is_buyer').notNull().default(true),
    deliversNationwide: boolean('delivers_nationwide').notNull().default(false),
    trustLevel: integer('trust_level').notNull().default(0),
    ratingAvg: real('rating_avg'),
    ratingCount: integer('rating_count').notNull().default(0),
    dealsClosed: integer('deals_closed').notNull().default(0),
    offersSent: integer('offers_sent').notNull().default(0),
    medianResponseMin: integer('median_response_min'),
    blocked: boolean('blocked').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('companies_inn_hash_uq').on(t.innHash).where(sql`${t.innHash} is not null`)],
);

export const memberships = pgTable(
  'memberships',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.companyId] })],
);

// ───────────────────────── Каталог ─────────────────────────

export const categories = pgTable(
  'categories',
  {
    id: serial('id').primaryKey(),
    parentId: integer('parent_id'),
    slug: varchar('slug', { length: 120 }).notNull().unique(),
    name: jsonb('name').$type<I18nText>().notNull(),
    fields: jsonb('fields').$type<FieldDef[]>().notNull().default([]),
    keywords: text('keywords').notNull().default(''),
    sort: integer('sort').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('categories_parent_idx').on(t.parentId)],
);

export const supplierCategories = pgTable(
  'supplier_categories',
  {
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.categoryId] }), index('supplier_categories_cat_idx').on(t.categoryId)],
);

export const serviceAreas = pgTable(
  'service_areas',
  {
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    regionCode: varchar('region_code', { length: 64 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.regionCode] })],
);

// ───────────────────────── Файлы ─────────────────────────

export const files = pgTable('files', {
  id: serial('id').primaryKey(),
  ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  key: varchar('key', { length: 300 }).notNull().unique(),
  mime: varchar('mime', { length: 100 }).notNull(),
  size: integer('size').notNull(),
  fileName: varchar('file_name', { length: 200 }),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  telegramFileId: varchar('telegram_file_id', { length: 200 }),
  createdAt: createdAt(),
});

// ───────────────────────── Заявки ─────────────────────────

export const requests = pgTable(
  'requests',
  {
    id: serial('id').primaryKey(),
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    buyerCompanyId: integer('buyer_company_id').references(() => companies.id),
    categoryId: integer('category_id').references(() => categories.id),
    status: varchar('status', { length: 24 }).notNull().default('draft'),
    source: varchar('source', { length: 16 }).notNull().default('miniapp'),
    title: varchar('title', { length: 200 }),
    rawText: text('raw_text').notNull().default(''),
    lang: varchar('lang', { length: 8 }).notNull().default('ru'),
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default({}),
    regionCode: varchar('region_code', { length: 64 }),
    deadline: date('deadline', { mode: 'string' }),
    budgetUzs: money('budget_uzs'),
    quantity: integer('quantity'),
    confidence: real('confidence'),
    missingFields: jsonb('missing_fields').$type<string[]>().notNull().default([]),
    question: text('question'),
    answers: jsonb('answers').$type<{ q: string; a: string }[]>().notNull().default([]),
    wave: integer('wave').notNull().default(0),
    moderationReason: text('moderation_reason'),
    submittedAt: ts('submitted_at'),
    closedAt: ts('closed_at'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('requests_cat_status_created_idx').on(t.categoryId, t.status, t.createdAt),
    index('requests_author_idx').on(t.authorUserId, t.createdAt),
    index('requests_status_idx').on(t.status),
  ],
);

export const requestFiles = pgTable(
  'request_files',
  {
    requestId: integer('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.fileId] })],
);

/** Кому и когда разослана заявка. Основа прав доступа поставщика к заявке и аналитики скорости. */
export const requestDeliveries = pgTable(
  'request_deliveries',
  {
    id: serial('id').primaryKey(),
    requestId: integer('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    supplierCompanyId: integer('supplier_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    wave: integer('wave').notNull(),
    score: real('score').notNull().default(0),
    manual: boolean('manual').notNull().default(false),
    notifyAt: ts('notify_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    seenAt: ts('seen_at'),
    respondedAt: ts('responded_at'),
    remindedAt: ts('reminded_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('request_deliveries_uq').on(t.requestId, t.supplierCompanyId),
    index('request_deliveries_supplier_idx').on(t.supplierCompanyId, t.createdAt),
  ],
);

export const offers = pgTable(
  'offers',
  {
    id: serial('id').primaryKey(),
    requestId: integer('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    supplierCompanyId: integer('supplier_company_id')
      .notNull()
      .references(() => companies.id),
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    priceUzs: money('price_uzs').notNull(),
    leadTimeDays: integer('lead_time_days').notNull(),
    comment: text('comment'),
    fileIds: jsonb('file_ids').$type<number[]>().notNull().default([]),
    status: varchar('status', { length: 16 }).notNull().default('sent'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('offers_request_supplier_uq').on(t.requestId, t.supplierCompanyId),
    index('offers_supplier_idx').on(t.supplierCompanyId, t.createdAt),
  ],
);

export const deals = pgTable(
  'deals',
  {
    id: serial('id').primaryKey(),
    requestId: integer('request_id')
      .notNull()
      .references(() => requests.id),
    offerId: integer('offer_id')
      .notNull()
      .references(() => offers.id),
    buyerUserId: integer('buyer_user_id')
      .notNull()
      .references(() => users.id),
    buyerCompanyId: integer('buyer_company_id').references(() => companies.id),
    supplierCompanyId: integer('supplier_company_id')
      .notNull()
      .references(() => companies.id),
    amountUzs: money('amount_uzs').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    escrow: boolean('escrow').notNull().default(false),
    buyerConfirmedAt: ts('buyer_confirmed_at'),
    supplierConfirmedAt: ts('supplier_confirmed_at'),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('deals_request_uq').on(t.requestId), index('deals_supplier_idx').on(t.supplierCompanyId)],
);

export const reviews = pgTable(
  'reviews',
  {
    id: serial('id').primaryKey(),
    dealId: integer('deal_id')
      .notNull()
      .references(() => deals.id),
    authorUserId: integer('author_user_id')
      .notNull()
      .references(() => users.id),
    authorSide: varchar('author_side', { length: 16 }).notNull(),
    targetCompanyId: integer('target_company_id').references(() => companies.id),
    targetUserId: integer('target_user_id').references(() => users.id),
    stars: integer('stars').notNull(),
    text: text('text'),
    hidden: boolean('hidden').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('reviews_deal_side_uq').on(t.dealId, t.authorSide), index('reviews_target_idx').on(t.targetCompanyId)],
);

// ───────────────────────── Чат ─────────────────────────

export const chats = pgTable(
  'chats',
  {
    id: serial('id').primaryKey(),
    requestId: integer('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'cascade' }),
    supplierCompanyId: integer('supplier_company_id')
      .notNull()
      .references(() => companies.id),
    buyerUserId: integer('buyer_user_id')
      .notNull()
      .references(() => users.id),
    lastMessageAt: ts('last_message_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('chats_request_supplier_uq').on(t.requestId, t.supplierCompanyId)],
);

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    chatId: integer('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderUserId: integer('sender_user_id')
      .notNull()
      .references(() => users.id),
    text: text('text'),
    fileId: integer('file_id').references(() => files.id),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_chat_idx').on(t.chatId, t.id)],
);

// ───────────────────────── Биллинг ─────────────────────────

export const subscriptions = pgTable('subscriptions', {
  id: serial('id').primaryKey(),
  companyId: integer('company_id')
    .notNull()
    .unique()
    .references(() => companies.id, { onDelete: 'cascade' }),
  planCode: varchar('plan_code', { length: 16 }).notNull().default('free'),
  status: varchar('status', { length: 16 }).notNull().default('active'),
  periodStart: ts('period_start'),
  periodEnd: ts('period_end'),
  source: varchar('source', { length: 16 }),
  remindedAt: ts('reminded_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const invoices = pgTable(
  'invoices',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    planCode: varchar('plan_code', { length: 16 }).notNull(),
    months: integer('months').notNull().default(1),
    amountUzs: money('amount_uzs').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('issued'),
    payToken: varchar('pay_token', { length: 64 }).notNull().unique(),
    issuedByUserId: integer('issued_by_user_id').references(() => users.id),
    paidAt: ts('paid_at'),
    paidVia: varchar('paid_via', { length: 16 }),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('invoices_company_idx').on(t.companyId)],
);

/** Транзакции платёжных систем. (provider, provider_txn_id) уникальны: повторный вебхук не зачтёт оплату дважды. */
export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    provider: varchar('provider', { length: 16 }).notNull(),
    providerTxnId: varchar('provider_txn_id', { length: 100 }).notNull(),
    amountTiyin: money('amount_tiyin').notNull(),
    /** Payme: 1 создана, 2 проведена, -1 отменена до проведения, -2 отменена после. Click: 1 подготовлена, 2 завершена, -1 отменена. */
    state: integer('state').notNull(),
    providerTime: money('provider_time'),
    performTime: money('perform_time'),
    cancelTime: money('cancel_time'),
    reason: integer('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payments_provider_txn_uq').on(t.provider, t.providerTxnId)],
);

// ───────────────────────── Уведомления, модерация, аналитика ─────────────────────────

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 48 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    error: text('error'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const moderationItems = pgTable(
  'moderation_items',
  {
    id: serial('id').primaryKey(),
    kind: varchar('kind', { length: 32 }).notNull(),
    refType: varchar('ref_type', { length: 32 }).notNull(),
    refId: integer('ref_id').notNull(),
    note: text('note'),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    resolution: text('resolution'),
    resolvedByUserId: integer('resolved_by_user_id').references(() => users.id),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [index('moderation_items_status_idx').on(t.status, t.createdAt)],
);

export const complaints = pgTable('complaints', {
  id: serial('id').primaryKey(),
  authorUserId: integer('author_user_id')
    .notNull()
    .references(() => users.id),
  targetType: varchar('target_type', { length: 16 }).notNull(),
  targetId: integer('target_id').notNull(),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
});

export const blacklist = pgTable(
  'blacklist',
  {
    id: serial('id').primaryKey(),
    kind: varchar('kind', { length: 16 }).notNull(),
    value: varchar('value', { length: 100 }).notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('blacklist_kind_value_uq').on(t.kind, t.value)],
);

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  staffUserId: integer('staff_user_id').references(() => users.id),
  action: varchar('action', { length: 64 }).notNull(),
  refType: varchar('ref_type', { length: 32 }),
  refId: integer('ref_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id'),
    name: varchar('name', { length: 64 }).notNull(),
    props: jsonb('props').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_name_idx').on(t.name, t.createdAt)],
);

/** Расход ИИ: токены и стоимость на каждую операцию. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: serial('id').primaryKey(),
    requestId: integer('request_id'),
    kind: varchar('kind', { length: 16 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    ok: boolean('ok').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);
