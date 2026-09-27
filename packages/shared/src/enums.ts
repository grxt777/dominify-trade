/** Языки интерфейса и уведомлений. */
export const LANGS = ['ru', 'uz', 'uzc'] as const;
export type Lang = (typeof LANGS)[number];

/** Текст на трёх языках: русский, узбекский (латиница), узбекский (кириллица). */
export type I18nText = { ru: string; uz: string; uzc: string };

export function pickLang(code?: string | null): Lang {
  if (!code) return 'ru';
  const c = code.toLowerCase();
  if (c === 'uzc' || c === 'uz-cyrl') return 'uzc';
  if (c.startsWith('uz')) return 'uz';
  return 'ru';
}

export const REQUEST_STATUSES = [
  'draft',
  'needs_info',
  'moderation',
  'submitted',
  'wave_1',
  'wave_2',
  'has_offers',
  'supplier_chosen',
  'completed',
  'reviewed',
  'cancelled',
  'expired',
  'rejected',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Статусы, в которых поставщики ещё могут откликаться. */
export const OPEN_REQUEST_STATUSES: RequestStatus[] = ['submitted', 'wave_1', 'wave_2', 'has_offers'];

export const OFFER_STATUSES = ['sent', 'withdrawn', 'chosen', 'rejected'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const DEAL_STATUSES = ['active', 'completed', 'disputed', 'cancelled'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const MEMBER_ROLES = ['owner', 'manager'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const STAFF_ROLES = ['admin', 'moderator', 'support'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ACTIVE_ROLES = ['buyer', 'supplier'] as const;
export type ActiveRole = (typeof ACTIVE_ROLES)[number];

export const COMPANY_TYPES = ['llc', 'ip', 'other'] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'grace', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const INVOICE_STATUSES = ['issued', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_PROVIDERS = ['bank_transfer', 'payme', 'click', 'manual'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** Уровни доверия: L0 телефон, L1 ИНН, L2 сделки и рейтинг, L3 оборот подтверждён банком. */
export const TRUST_LEVELS = [0, 1, 2, 3] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Регионы Узбекистана и районы Ташкента (коды стабильны, названия на трёх языках). */
export const REGIONS: { code: string; parent?: string; name: I18nText }[] = [
  { code: 'tashkent', name: { ru: 'Ташкент', uz: 'Toshkent', uzc: 'Тошкент' } },
  { code: 'tashkent.chilonzor', parent: 'tashkent', name: { ru: 'Чиланзарский р-н', uz: 'Chilonzor tumani', uzc: 'Чилонзор тумани' } },
  { code: 'tashkent.yunusobod', parent: 'tashkent', name: { ru: 'Юнусабадский р-н', uz: 'Yunusobod tumani', uzc: 'Юнусобод тумани' } },
  { code: 'tashkent.mirzo_ulugbek', parent: 'tashkent', name: { ru: 'Мирзо-Улугбекский р-н', uz: "Mirzo Ulug'bek tumani", uzc: 'Мирзо Улуғбек тумани' } },
  { code: 'tashkent.yakkasaroy', parent: 'tashkent', name: { ru: 'Яккасарайский р-н', uz: 'Yakkasaroy tumani', uzc: 'Яккасарой тумани' } },
  { code: 'tashkent.shayxontohur', parent: 'tashkent', name: { ru: 'Шайхантахурский р-н', uz: 'Shayxontohur tumani', uzc: 'Шайхонтоҳур тумани' } },
  { code: 'tashkent.olmazor', parent: 'tashkent', name: { ru: 'Алмазарский р-н', uz: 'Olmazor tumani', uzc: 'Олмазор тумани' } },
  { code: 'tashkent.mirobod', parent: 'tashkent', name: { ru: 'Мирабадский р-н', uz: 'Mirobod tumani', uzc: 'Миробод тумани' } },
  { code: 'tashkent.sergeli', parent: 'tashkent', name: { ru: 'Сергелийский р-н', uz: 'Sergeli tumani', uzc: 'Сергели тумани' } },
  { code: 'tashkent.uchtepa', parent: 'tashkent', name: { ru: 'Учтепинский р-н', uz: 'Uchtepa tumani', uzc: 'Учтепа тумани' } },
  { code: 'tashkent.yashnobod', parent: 'tashkent', name: { ru: 'Яшнабадский р-н', uz: 'Yashnobod tumani', uzc: 'Яшнобод тумани' } },
  { code: 'tashkent.bektemir', parent: 'tashkent', name: { ru: 'Бектемирский р-н', uz: 'Bektemir tumani', uzc: 'Бектемир тумани' } },
  { code: 'tashkent.yangihayot', parent: 'tashkent', name: { ru: 'Янгихаётский р-н', uz: 'Yangihayot tumani', uzc: 'Янгиҳаёт тумани' } },
  { code: 'tashkent_region', name: { ru: 'Ташкентская обл.', uz: 'Toshkent viloyati', uzc: 'Тошкент вилояти' } },
  { code: 'samarkand', name: { ru: 'Самарканд', uz: 'Samarqand', uzc: 'Самарқанд' } },
  { code: 'bukhara', name: { ru: 'Бухара', uz: 'Buxoro', uzc: 'Бухоро' } },
  { code: 'fergana', name: { ru: 'Фергана', uz: "Farg'ona", uzc: 'Фарғона' } },
  { code: 'andijan', name: { ru: 'Андижан', uz: 'Andijon', uzc: 'Андижон' } },
  { code: 'namangan', name: { ru: 'Наманган', uz: 'Namangan', uzc: 'Наманган' } },
  { code: 'kashkadarya', name: { ru: 'Кашкадарья', uz: 'Qashqadaryo', uzc: 'Қашқадарё' } },
  { code: 'surkhandarya', name: { ru: 'Сурхандарья', uz: 'Surxondaryo', uzc: 'Сурхондарё' } },
  { code: 'navoi', name: { ru: 'Навои', uz: 'Navoiy', uzc: 'Навоий' } },
  { code: 'jizzakh', name: { ru: 'Джизак', uz: 'Jizzax', uzc: 'Жиззах' } },
  { code: 'syrdarya', name: { ru: 'Сырдарья', uz: 'Sirdaryo', uzc: 'Сирдарё' } },
  { code: 'khorezm', name: { ru: 'Хорезм', uz: 'Xorazm', uzc: 'Хоразм' } },
  { code: 'karakalpakstan', name: { ru: 'Каракалпакстан', uz: "Qoraqalpog'iston", uzc: 'Қорақалпоғистон' } },
];

/** Верхний регион для кода района: 'tashkent.chilonzor' → 'tashkent'. */
export function rootRegion(code: string): string {
  return code.split('.')[0];
}
