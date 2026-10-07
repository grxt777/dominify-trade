import { describe, expect, it } from 'vitest';
import type { FieldDef } from '@dominify/shared';
import { nextAsk, type AskState } from './requests/clarify';

const defs: FieldDef[] = [
  { key: 'sides', label: { ru: 'Стороны', uz: 'Tomonlar', uzc: 'Томонлар' }, type: 'select', required: true, options: [{ value: '1', label: { ru: 'Одна', uz: 'Bir', uzc: 'Бир' } }, { value: '2', label: { ru: 'Две', uz: 'Ikki', uzc: 'Икки' } }] },
  { key: 'quantity', label: { ru: 'Тираж', uz: 'Tiraj', uzc: 'Тираж' }, type: 'number', unit: 'шт' },
];

const base: AskState = {
  lang: 'ru',
  categoryKnown: true,
  freeQuestion: null,
  defs,
  fields: {},
  quantity: null,
  deadline: null,
  budgetUzs: null,
  deliveryNeeded: null,
  hasDeliveryPoint: false,
  asked: [],
  answers: 0,
  llmQuestion: null,
  today: new Date('2026-10-07T10:00:00Z'),
};

describe('Уточняющие вопросы', () => {
  it('идут по порядку: обязательное → тираж → срок → доставка → точка на карте → бюджет', () => {
    const order: string[] = [];
    let s = { ...base };
    for (let i = 0; i < 8; i++) {
      const a = nextAsk(s);
      if (!a) break;
      order.push(a.key);
      if (a.key === 'sides') s = { ...s, fields: { ...s.fields, sides: '2' } };
      else if (a.key === 'quantity') s = { ...s, quantity: 300 };
      else if (a.key === 'deadline') s = { ...s, deadline: '2026-10-10' };
      else if (a.key === 'delivery') s = { ...s, deliveryNeeded: true };
      else if (a.key === 'location') s = { ...s, hasDeliveryPoint: true };
      else if (a.key === 'budget') s = { ...s, budgetUzs: 500_000 };
    }
    expect(order).toEqual(['sides', 'quantity', 'deadline', 'delivery', 'location', 'budget']);
  });

  it('обязательный вопрос с вариантами — с кнопками и без «Пропустить»', () => {
    const a = nextAsk(base)!;
    expect(a.options.map((o) => o.value)).toEqual(['1', '2']);
    expect(a.optional).toBe(false);
  });

  it('пропущенное не спрашивает снова; без доставки карту не предлагает', () => {
    const s = { ...base, fields: { sides: '1' }, quantity: 100, asked: ['deadline'], deliveryNeeded: false };
    expect(nextAsk(s)?.key).toBe('budget');
    expect(nextAsk({ ...s, asked: ['deadline', 'budget'] })).toBeNull();
  });

  it('варианты срока — реальные даты по Ташкенту', () => {
    const a = nextAsk({ ...base, fields: { sides: '1' }, quantity: 1 })!;
    expect(a.key).toBe('deadline');
    expect(a.options[0].value).toBe('2026-10-08');
    expect(a.input).toBe('date');
  });

  it('категория не ясна — свободный вопрос модели', () => {
    expect(nextAsk({ ...base, categoryKnown: false, freeQuestion: 'Что нужно?' })?.kind).toBe('free');
  });
});
