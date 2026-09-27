/**
 * Скоринг поставщиков для рассылки заявки. Чистые функции без базы: легко тестировать и настраивать.
 *
 * score = 0.35 · совпадение категории
 *       + 0.20 · зона доставки
 *       + 0.20 · рейтинг и доля закрытых сделок
 *       + 0.15 · скорость ответа за 30 дней
 *       + 0.10 · приоритет тарифа
 *       + буст новичкам первые 14 дней
 */

export interface ScoreWeights {
  category: number;
  geo: number;
  rating: number;
  speed: number;
  plan: number;
  newbieBoost: number;
  newbieDays: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  category: 0.35,
  geo: 0.2,
  rating: 0.2,
  speed: 0.15,
  plan: 0.1,
  newbieBoost: 0.08,
  newbieDays: 14,
};

export interface Candidate {
  companyId: number;
  /** Поставщик работает ровно в этой подкатегории (true) или только в родительской вертикали (false). */
  exactCategory: boolean;
  /** Обслуживает район/регион заявки напрямую. */
  servesRegion: boolean;
  /** Возит по всей стране. */
  deliversNationwide: boolean;
  ratingAvg: number | null;
  ratingCount: number;
  dealsClosed: number;
  offersSent: number;
  /** Медиана минут от рассылки до отклика за последние 30 дней. */
  medianResponseMin: number | null;
  planPriority: number;
  createdAt: Date;
  /** Сколько заявок ему уже разослано сегодня. */
  deliveriesToday: number;
}

export function scoreCandidate(c: Candidate, now: Date, w: ScoreWeights = DEFAULT_WEIGHTS): number {
  const category = c.exactCategory ? 1 : 0.6;
  const geo = c.servesRegion ? 1 : c.deliversNationwide ? 0.5 : 0;

  // Рейтинг: без отзывов нейтральные 0.6, чтобы новичок не проигрывал всем.
  const ratingPart = c.ratingCount > 0 && c.ratingAvg !== null ? c.ratingAvg / 5 : 0.6;
  const closeRatio = c.offersSent >= 5 ? Math.min(1, c.dealsClosed / c.offersSent) : 0.5;
  const rating = 0.7 * ratingPart + 0.3 * closeRatio;

  // Скорость: до 15 минут — максимум, к 4 часам падает до нуля.
  let speed = 0.5;
  if (c.medianResponseMin !== null) {
    speed = c.medianResponseMin <= 15 ? 1 : Math.max(0, 1 - (c.medianResponseMin - 15) / 225);
  }

  const ageDays = (now.getTime() - c.createdAt.getTime()) / 86_400_000;
  const boost = ageDays <= w.newbieDays ? w.newbieBoost : 0;

  const s = w.category * category + w.geo * geo + w.rating * rating + w.speed * speed + w.plan * c.planPriority + boost;
  return Math.round(s * 10_000) / 10_000;
}

export interface WaveConfig {
  wave1Size: number;
  wave2Size: number;
  /** Сколько откликов достаточно, чтобы не запускать вторую волну. */
  minOffersAfterWave1: number;
  /** Через сколько минут проверять отклики после первой волны. */
  wave1WaitMin: number;
  /** Лимит заявок на поставщика в день. */
  dailyLimit: number;
}

export const DEFAULT_WAVES: WaveConfig = {
  wave1Size: 5,
  wave2Size: 10,
  minOffersAfterWave1: 2,
  wave1WaitMin: 30,
  dailyLimit: 20,
};

/**
 * Выбрать поставщиков для волны. Исключает тех, кому уже разослано, кто вне зоны и кто исчерпал дневной лимит.
 * Возвращает отсортированный по убыванию score список размером не больше size.
 */
export function pickWave(
  candidates: Candidate[],
  alreadySent: Set<number>,
  size: number,
  now: Date,
  cfg: WaveConfig = DEFAULT_WAVES,
  w: ScoreWeights = DEFAULT_WEIGHTS,
): { companyId: number; score: number }[] {
  return candidates
    .filter((c) => !alreadySent.has(c.companyId))
    .filter((c) => c.servesRegion || c.deliversNationwide)
    .filter((c) => c.deliveriesToday < cfg.dailyLimit)
    .map((c) => ({ companyId: c.companyId, score: scoreCandidate(c, now, w) }))
    .sort((a, b) => b.score - a.score || a.companyId - b.companyId)
    .slice(0, size);
}

/** Нужна ли вторая волна: откликов меньше порога. */
export function needsSecondWave(offersCount: number, cfg: WaveConfig = DEFAULT_WAVES): boolean {
  return offersCount < cfg.minOffersAfterWave1;
}
