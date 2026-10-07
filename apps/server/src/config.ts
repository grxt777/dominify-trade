import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3000'),
  MINIAPP_URL: z.string().url().default('http://localhost:5173'),
  ADMIN_URL: z.string().url().default('http://localhost:5174'),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Telegram
  BOT_TOKEN: z.string().min(10),
  BOT_USERNAME: z.string().default('dominifytradebot'),
  /** Короткое имя Mini App в BotFather: ссылка t.me/<бот>/<имя>?startapp=... */
  MINIAPP_SHORT_NAME: z.string().default('app'),
  BOT_WEBHOOK_SECRET: z.string().default(''),
  /** Публичный адрес сервиса bot для вебхука Telegram, например https://bot.dominify.app. */
  BOT_PUBLIC_URL: z.string().default(''),
  /** polling — для локальной разработки, webhook — для Railway. */
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  /** telegram — отправлять через Bot API, log — только писать в лог (тесты, staging без бота). */
  NOTIFY_DRIVER: z.enum(['telegram', 'log']).default('telegram'),
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().default(86_400),

  // Безопасность
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SEC: z.coerce.number().default(3600),
  /** 32 байта в base64 для AES-256-GCM (телефоны, ИНН). */
  ENCRYPTION_KEY: z.string().min(40),
  /** Ключ HMAC для хешей поиска дублей телефонов и ИНН. */
  HASH_KEY: z.string().min(16),
  ADMIN_TELEGRAM_IDS: z.string().default(''),
  /** Вход без Telegram (?dev=<id>). Разрешён только при NODE_ENV=development или test. */
  DEV_AUTH: bool.default(false),

  // Защита от злоупотреблений
  /** Сколькими компаниями может владеть один человек: иначе бесплатный лимит откликов обходится новыми компаниями. */
  MAX_COMPANIES_PER_USER: z.coerce.number().int().min(1).default(3),
  /** Срок жизни приглашения в команду, часов. */
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).default(72),
  /** Сообщений боту в минуту и в сутки от одного человека. */
  BOT_MSG_PER_MIN: z.coerce.number().int().min(1).default(12),
  BOT_MSG_PER_DAY: z.coerce.number().int().min(1).default(300),
  /** Повторный отзыв той же пары «покупатель — поставщик» влияет на рейтинг не чаще раза в N дней. */
  REVIEW_PAIR_COOLDOWN_DAYS: z.coerce.number().int().min(0).default(90),
  /** Через сколько дней после срока исполнения напомнить сторонам закрыть сделку. */
  DEAL_REMIND_AFTER_DAYS: z.coerce.number().int().min(0).default(2),
  /** Одна сторона подтвердила, другая молчит столько дней — сделка закрывается автоматически. */
  DEAL_AUTOCOMPLETE_DAYS: z.coerce.number().int().min(1).default(14),

  // ИИ
  LLM_PROVIDER: z.enum(['anthropic', 'gemini', 'rules']).default('rules'),
  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_MODEL_FAST: z.string().default('claude-haiku-4-5'),
  LLM_MODEL_SMART: z.string().default('claude-sonnet-5'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL_FAST: z.string().default('gemini-3.8-flash'),
  // Для экономии и фото, и сложные заявки тоже идут в Flash. Pro включается переменной, если качества не хватит.
  GEMINI_MODEL_SMART: z.string().default('gemini-3.8-flash'),
  LLM_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.7),
  AI_DAILY_PARSE_LIMIT_PER_USER: z.coerce.number().default(40),
  STT_API_URL: z.string().default(''),
  STT_API_KEY: z.string().default(''),
  STT_MODEL: z.string().default('whisper-1'),

  // Файлы
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./uploads'),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  /** Новые бакеты Railway работают с virtual-hosted адресами; path-style нужен только старым. */
  S3_FORCE_PATH_STYLE: bool.default(false),

  // Платежи (веб-страница оплаты счёта, не Mini App)
  PAYME_MERCHANT_ID: z.string().default(''),
  PAYME_KEY: z.string().default(''),
  PAYME_CHECKOUT_URL: z.string().default('https://checkout.paycom.uz'),
  /** Коды для фискального чека Payme: ИКПУ услуги и код упаковки из tasnif.soliq.uz. */
  PAYME_IKPU_CODE: z.string().default(''),
  PAYME_PACKAGE_CODE: z.string().default(''),
  /** Реквизиты для оплаты переводом, показываются на странице счёта. */
  BANK_REQUISITES: z.string().default(''),
  CLICK_SERVICE_ID: z.string().default(''),
  CLICK_MERCHANT_ID: z.string().default(''),
  CLICK_SECRET_KEY: z.string().default(''),

  // Правила маркетплейса
  QUIET_HOURS_START: z.coerce.number().default(22),
  QUIET_HOURS_END: z.coerce.number().default(8),
  TIMEZONE_OFFSET_MIN: z.coerce.number().default(300),
  REQUEST_TTL_DAYS: z.coerce.number().default(7),
  WAVE1_WAIT_MIN: z.coerce.number().default(30),
  OFFER_DIGEST_MIN: z.coerce.number().default(10),
  SUPPLIER_REMIND_MIN: z.coerce.number().default(60),
  /** Во сколько минут Mini App считается «в сети» после последнего пинга сокета. */
  ONLINE_TTL_SEC: z.coerce.number().default(60),

  // Безопасная сделка и рост
  /** Комиссия платформы с оплаченного заказа, процентов. Удерживается из выплаты исполнителю. */
  ESCROW_FEE_PERCENT: z.coerce.number().min(0).max(50).default(5),
  /** Скидка на первый заказ с безопасной оплатой: процент и потолок в сумах. Платит платформа. */
  FIRST_ORDER_DISCOUNT_PERCENT: z.coerce.number().min(0).max(100).default(10),
  FIRST_ORDER_DISCOUNT_MAX_UZS: z.coerce.number().int().min(0).default(100_000),
  /** Бонус пригласившему после первого оплаченного и закрытого заказа друга. */
  REFERRAL_BONUS_UZS: z.coerce.number().int().min(0).default(50_000),
  /** Какую долю заказа можно оплатить бонусами, процентов. */
  BONUS_MAX_SHARE_PERCENT: z.coerce.number().int().min(0).max(100).default(50),

  SENTRY_DSN: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Неверные переменные окружения:\n${issues}`);
  }
  if (parsed.data.DEV_AUTH && !devAuthAllowed(parsed.data)) {
    throw new Error('DEV_AUTH разрешён только при NODE_ENV=development или test');
  }
  cached = parsed.data;
  return cached;
}

/** Dev-вход открывает любой аккаунт, включая админский: на staging и в production он недопустим. */
export function devAuthAllowed(cfg: Pick<Config, 'NODE_ENV' | 'DEV_AUTH'>): boolean {
  return cfg.DEV_AUTH && (cfg.NODE_ENV === 'development' || cfg.NODE_ENV === 'test');
}

/** Только для тестов. */
export function resetConfig(): void {
  cached = null;
}

export function adminTelegramIds(cfg: Config): Set<number> {
  return new Set(
    cfg.ADMIN_TELEGRAM_IDS.split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
}
