import { describe, expect, it } from 'vitest';
import { DEFAULT_WAVES, needsSecondWave, pickWave, scoreCandidate, type Candidate } from './scoring';

const now = new Date('2026-10-01T10:00:00Z');
const base: Candidate = {
  companyId: 1,
  exactCategory: true,
  servesRegion: true,
  deliversNationwide: false,
  ratingAvg: 4.8,
  ratingCount: 10,
  dealsClosed: 6,
  offersSent: 10,
  medianResponseMin: 10,
  planPriority: 1,
  createdAt: new Date('2026-01-01'),
  deliveriesToday: 0,
};

describe('scoreCandidate', () => {
  it('лучший поставщик получает почти максимум', () => {
    expect(scoreCandidate(base, now)).toBeGreaterThan(0.9);
  });

  it('вне категории и зоны балл ниже', () => {
    const weak = { ...base, exactCategory: false, servesRegion: false, deliversNationwide: true };
    expect(scoreCandidate(weak, now)).toBeLessThan(scoreCandidate(base, now));
  });

  it('новичок без отзывов получает буст и нейтральный рейтинг', () => {
    const newbie = { ...base, ratingAvg: null, ratingCount: 0, offersSent: 0, dealsClosed: 0, medianResponseMin: null, planPriority: 0, createdAt: new Date('2026-09-28') };
    const oldNoRating = { ...newbie, createdAt: new Date('2026-01-01') };
    expect(scoreCandidate(newbie, now)).toBeGreaterThan(scoreCandidate(oldNoRating, now));
  });

  it('медленный ответ снижает балл', () => {
    expect(scoreCandidate({ ...base, medianResponseMin: 240 }, now)).toBeLessThan(scoreCandidate(base, now));
  });
});

describe('pickWave', () => {
  const many: Candidate[] = Array.from({ length: 20 }, (_, i) => ({
    ...base,
    companyId: i + 1,
    medianResponseMin: 10 + i * 10,
  }));

  it('берёт 5 лучших в первой волне', () => {
    const w = pickWave(many, new Set(), DEFAULT_WAVES.wave1Size, now);
    expect(w).toHaveLength(5);
    expect(w.map((x) => x.companyId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('не шлёт повторно и не шлёт вне зоны и сверх лимита', () => {
    const list = [
      ...many.slice(0, 3),
      { ...base, companyId: 50, servesRegion: false, deliversNationwide: false },
      { ...base, companyId: 51, deliveriesToday: 99 },
    ];
    const w = pickWave(list, new Set([1]), 10, now);
    expect(w.map((x) => x.companyId)).toEqual([2, 3]);
  });

  it('вторая волна нужна при менее чем двух откликах', () => {
    expect(needsSecondWave(0)).toBe(true);
    expect(needsSecondWave(1)).toBe(true);
    expect(needsSecondWave(2)).toBe(false);
  });
});
