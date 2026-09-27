import type { I18nText } from './enums';

export const PLAN_CODES = ['free', 'start', 'pro', 'business'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface PlanDef {
  code: PlanCode;
  name: I18nText;
  /** Цена в сумах за 30 дней. */
  priceUzs: number;
  /** Лимит откликов за календарный месяц; null — без лимита. */
  offersPerMonth: number | null;
  /** Задержка уведомления о новой заявке, минут. */
  notifyDelayMin: number;
  /** Вес тарифа в скоринге, 0..1. */
  priority: number;
  /** Сколько сотрудников компании могут работать в аккаунте. */
  seats: number;
  /** Сколько категорий можно выбрать. */
  maxCategories: number;
}

/**
 * Стартовые тарифы из питча. Это гипотезы: меняются здесь, без миграций.
 * Платные тарифы продаются вне Mini App (счёт на юрлицо, веб-страница оплаты),
 * потому что Telegram требует Stars для цифровых услуг внутри Mini App.
 */
export const PLANS: Record<PlanCode, PlanDef> = {
  free: {
    code: 'free',
    name: { ru: 'Бесплатный', uz: 'Bepul', uzc: 'Бепул' },
    priceUzs: 0,
    offersPerMonth: 5,
    notifyDelayMin: 15,
    priority: 0,
    seats: 1,
    maxCategories: 3,
  },
  start: {
    code: 'start',
    name: { ru: 'Старт', uz: 'Start', uzc: 'Старт' },
    priceUzs: 149_000,
    offersPerMonth: 40,
    notifyDelayMin: 0,
    priority: 0.4,
    seats: 1,
    maxCategories: 5,
  },
  pro: {
    code: 'pro',
    name: { ru: 'Про', uz: 'Pro', uzc: 'Про' },
    priceUzs: 349_000,
    offersPerMonth: null,
    notifyDelayMin: 0,
    priority: 1,
    seats: 2,
    maxCategories: 10,
  },
  business: {
    code: 'business',
    name: { ru: 'Бизнес', uz: 'Biznes', uzc: 'Бизнес' },
    priceUzs: 890_000,
    offersPerMonth: null,
    notifyDelayMin: 0,
    priority: 1,
    seats: 5,
    maxCategories: 30,
  },
};

/** Сколько дней подписка работает после окончания оплаченного периода. */
export const GRACE_DAYS = 3;
/** Длина оплаченного периода, дней. */
export const PERIOD_DAYS = 30;
