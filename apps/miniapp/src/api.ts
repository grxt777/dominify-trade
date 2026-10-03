import type { CategoryNode, FieldDef, GigPackage, I18nText, Lang, PlanCode } from '@dominify/shared';
import { initData, inTelegram } from './tg';

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:3000';
// В режиме разработки можно войти под любым тестовым пользователем: ?dev=<telegram id>.
const DEV_TG_ID =
  (import.meta.env.DEV ? new URLSearchParams(window.location.search).get('dev') : null) ??
  (import.meta.env.VITE_DEV_TELEGRAM_ID as string | undefined);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let token: string | null = null;
let authPromise: Promise<AuthResult> | null = null;

export interface Company {
  id: number;
  name: string;
  type: string;
  isSupplier: boolean;
  isBuyer: boolean;
  regionCode: string;
  trustLevel: number;
  ratingAvg: number | null;
  ratingCount: number;
  dealsClosed: number;
  role: string;
  planCode: PlanCode;
  planName: I18nText;
  planStatus: string | null;
  periodEnd: string | null;
}

export interface Me {
  id: number;
  telegramId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  lang: Lang;
  activeRole: 'buyer' | 'supplier';
  activeCompanyId: number | null;
  phone: string | null;
  phoneVerified: boolean;
  consent: boolean;
  botStarted: boolean;
  staffRole: string | null;
  companies: Company[];
  bonusUzs: number;
  referral: { code: string; link: string; bonusUzs: number; invited: number; rewarded: number };
  /** Скидка на первый заказ с безопасной оплатой, если ещё не использована. */
  firstOrder: { percent: number; maxUzs: number } | null;
}

export interface Stats {
  dealsCompleted: number;
  suppliers: number;
  ordersToday: number;
  avgRating: number | null;
}

export interface AuthResult {
  token: string;
  expiresIn: number;
  startParam: string | null;
  me: Me;
}

export interface SupplierBrief {
  id: number;
  name: string;
  trustLevel: number;
  ratingAvg: number | null;
  ratingCount: number;
  dealsClosed: number;
  medianResponseMin: number | null;
}

export interface Offer {
  id: number;
  priceUzs: number;
  leadTimeDays: number;
  comment: string | null;
  status: string;
  fileIds: number[];
  createdAt: string;
  supplier: SupplierBrief;
}

export interface RequestView {
  id: number;
  title: string | null;
  status: string;
  source: string;
  rawText?: string;
  lang: string;
  category: { id: number; slug: string; name: I18nText } | null;
  fieldDefs: FieldDef[];
  fields: Record<string, unknown>;
  duplicateOf: number | null;
  regionCode: string | null;
  deadline: string | null;
  budgetUzs: number | null;
  quantity: number | null;
  files: { id: number; mime: string; fileName: string | null }[];
  createdAt: string;
  submittedAt: string | null;
  expiresAt: string | null;
  wave: number;
  order: RequestOrder | null;
  role: 'author' | 'supplier' | 'staff';
  // автор
  confidence?: number | null;
  missingFields?: string[];
  question?: string | null;
  answers?: { q: string; a: string }[];
  offers?: Offer[];
  dealId: number | null;
  // поставщик
  companyId?: number;
  buyer?: { name: string; trustLevel: number };
  myOffer?: { id: number; priceUzs: number; leadTimeDays: number; comment: string | null; status: string } | null;
  isOpen?: boolean;
}

/** Заказ с витрины внутри заявки. */
export interface RequestOrder {
  gigId: number;
  title: string;
  cover: string | null;
  companyId: number;
  companyName: string;
  package: Pick<GigPackage, 'code' | 'name' | 'priceUzs' | 'days' | 'revisions' | 'features'> | null;
}

export interface GigCard {
  id: number;
  title: string;
  cover: string | null;
  ordersCount: number;
  categoryId: number | null;
  fromPriceUzs: number | null;
  fastestDays: number | null;
  favorite: boolean;
  company: SupplierBrief & { innVerified: boolean };
}

export interface GigView {
  favorite: boolean;
  /** Услуга своей компании: заказать и спросить нельзя. */
  mine: boolean;
  lastOrderAt: string | null;
  id: number;
  title: string;
  description: string;
  cover: string | null;
  gallery: string[];
  packages: GigPackage[];
  tags: string[];
  ordersCount: number;
  category: { id: number; slug: string; name: I18nText } | null;
  company: SupplierBrief & {
    about: string | null;
    owner: string | null;
    regionCode: string;
    innVerified: boolean;
    createdAt: string;
  };
  reviews: { id: number; stars: number; text: string | null; createdAt: string; author: string | null; amountUzs: number }[];
  more: { id: number; title: string; cover: string | null; fromPriceUzs: number | null }[];
}

/** Картинка услуги: «f:<id>» — загруженная продавцом (отдаёт api), иначе путь к статике Mini App. */
export function imgSrc(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith('f:') ? `${API_URL}/v1/gigs/image/${ref.slice(2)}` : ref;
}

export interface MyGig {
  id: number;
  title: string;
  cover: string | null;
  active: boolean;
  ordersCount: number;
  categoryId: number | null;
  fromPriceUzs: number | null;
  packagesCount: number;
  updatedAt: string;
}

export interface GigEditable {
  id: number;
  companyId: number;
  categoryId: number | null;
  title: string;
  description: string;
  gallery: string[];
  packages: GigPackage[];
  tags: string[];
  active: boolean;
}

export interface MyRequest {
  id: number;
  title: string | null;
  status: string;
  categoryId: number | null;
  createdAt: string;
  offersCount: number;
  bestPrice: number | null;
}

export interface FeedItem {
  id: number;
  title: string | null;
  status: string;
  categoryId: number | null;
  regionCode: string | null;
  deadline: string | null;
  budgetUzs: number | null;
  quantity: number | null;
  createdAt: string;
  wave: number;
  isNew: boolean;
  isOpen: boolean;
  myOfferStatus: string | null;
  myOfferPrice: number | null;
}

export interface Deal {
  id: number;
  side: 'buyer' | 'supplier';
  status: string;
  amountUzs: number;
  leadTimeDays?: number;
  comment?: string | null;
  request: { id: number; title: string | null; status: string; gigId: number | null };
  supplier: { id: number; name: string; ratingAvg: number | null; trustLevel: number; innVerified: boolean };
  buyer: { name: string | null; username: string | null; phone: string | null } | null;
  payment: DealPayment;
  buyerConfirmed: boolean;
  supplierConfirmed: boolean;
  myReview: { stars: number; text: string | null } | null;
  closedBy: string | null;
  closeReason: string | null;
  cancelledAt: string | null;
  disputedAt: string | null;
  canCancel: boolean;
  canDispute: boolean;
  createdAt: string;
  completedAt: string | null;
}

export type PaymentStatus = 'none' | 'awaiting' | 'held' | 'payout_due' | 'paid_out' | 'refund_due' | 'refunded';

export interface DealPayment {
  status: PaymentStatus;
  feePercent: number;
  feeUzs: number;
  paidAt: string | null;
  settledAt: string | null;
  // исполнитель
  payoutUzs?: number;
  // покупатель
  quote?: { firstOrder: boolean; phoneNeeded: boolean; discountUzs: number; bonusUzs: number; payUzs: number } | null;
  paidUzs?: number | null;
  discountUzs?: number;
  bonusUzs?: number;
  payUrl?: string | null;
}

export interface TeamMember {
  userId: number;
  firstName: string | null;
  username: string | null;
  role: 'owner' | 'manager';
  joinedAt: string;
}

export interface ChatItem {
  id: number;
  /** null — вопрос по услуге до заказа. */
  requestId: number | null;
  gigId: number | null;
  title: string | null;
  supplierCompanyId: number;
  supplierName: string;
  buyerName: string | null;
  buyerUserId: number;
  lastMessageAt: string | null;
  unread: number;
}

export interface Message {
  id: number;
  chatId: number;
  senderUserId: number;
  text: string | null;
  fileId: number | null;
  createdAt: string;
  readAt: string | null;
}

export interface PlanInfo {
  planCode: PlanCode;
  planName: I18nText;
  status: string;
  periodEnd: string | null;
  offersPerMonth: number | null;
  offersUsed: number;
  notifyDelayMin: number;
  seats: number;
  maxCategories: number;
}

export interface CompanyProfile {
  id: number;
  name: string;
  type: string;
  regionCode: string;
  about: string | null;
  isSupplier: boolean;
  isBuyer: boolean;
  deliversNationwide: boolean;
  trustLevel: number;
  innVerified: boolean;
  ratingAvg: number | null;
  ratingCount: number;
  dealsClosed: number;
  medianResponseMin: number | null;
  createdAt: string;
  categoryIds: number[];
  areas: string[];
  reviews: { stars: number; text: string | null; createdAt: string }[];
  planCode?: PlanCode;
  hasInn?: boolean;
}

async function authenticate(): Promise<AuthResult> {
  if (inTelegram) {
    const res = await fetch(`${API_URL}/v1/auth/telegram`, { method: 'POST', headers: { authorization: `tma ${initData()}` } });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'auth', data?.error?.message ?? 'Не удалось войти');
    token = data.token;
    return data;
  }
  // Браузер без Telegram: вход для разработки (работает только при DEV_AUTH=1 на сервере).
  if (DEV_TG_ID) {
    const res = await fetch(`${API_URL}/v1/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telegramId: Number(DEV_TG_ID), firstName: 'Dev' }),
    });
    const data = await res.json();
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'auth', data?.error?.message ?? 'Dev-вход недоступен');
    token = data.token;
    return data;
  }
  throw new ApiError(401, 'no_telegram', 'Откройте приложение из Telegram');
}

export function login(): Promise<AuthResult> {
  if (!authPromise) authPromise = authenticate().finally(() => (authPromise = null));
  return authPromise;
}

export function currentToken() {
  return token;
}

export async function api<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  if (!token) await login();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && retry) {
    token = null;
    await login();
    return api<T>(method, path, body, false);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Ошибка');
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

/** Загрузка файла: подписанная ссылка → PUT прямо в хранилище → подтверждение. */
export async function uploadFile(file: File): Promise<number> {
  const mime = file.type || 'application/octet-stream';
  const { id, uploadUrl } = await post<{ id: number; uploadUrl: string }>('/v1/files', { fileName: file.name.slice(0, 200), mime, size: file.size });
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': mime }, body: file });
  if (!put.ok) throw new ApiError(put.status, 'upload', 'Не удалось загрузить файл');
  await post(`/v1/files/${id}/complete`);
  return id;
}

export type { CategoryNode };
