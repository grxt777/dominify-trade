import { formatUzs, missingRequired, t3, type FieldDef, type Lang } from '@dominify/shared';

/**
 * Уточняющие вопросы ИИ к заявке. Порядок — как у опытного менеджера типографии:
 * сначала то, без чего работу не оценить (обязательные поля шаблона), затем тираж, срок,
 * доставка (и куда — точкой на карте), бюджет. Необязательное можно пропустить, и второй раз
 * пропущенное не спрашиваем. Ответ кнопкой пишется в заявку сразу, без вызова модели.
 */

/** Потолок вопросов на заявку: защита от зацикливания, а не ограничение для покупателя. */
export const MAX_QUESTIONS = 10;

export type AskKind = 'free' | 'field' | 'quantity' | 'deadline' | 'delivery' | 'location' | 'budget';
/** Ключи параметров заявки, которые уточняются не полями шаблона. */
export const SLOT_KEYS = ['quantity', 'deadline', 'delivery', 'location', 'budget'] as const;

export interface AskOption {
  value: string | number | boolean;
  label: string;
}

export interface Ask {
  key: string;
  kind: AskKind;
  text: string;
  options: AskOption[];
  input: 'text' | 'number' | 'date' | 'map' | null;
  unit: string | null;
  optional: boolean;
}

export interface AskState {
  lang: Lang;
  categoryKnown: boolean;
  /** Вопрос модели, когда категория не ясна: свободный ответ уйдёт на повторный разбор. */
  freeQuestion: string | null;
  defs: FieldDef[];
  fields: Record<string, unknown>;
  quantity: number | null;
  deadline: string | null;
  budgetUzs: number | null;
  deliveryNeeded: boolean | null;
  hasDeliveryPoint: boolean;
  /** Что уже спрашивали (в том числе пропущенное). */
  asked: string[];
  answers: number;
  /** Вопрос модели к первому обязательному полю — звучит естественнее шаблонного. */
  llmQuestion: string | null;
  today: Date;
}

const T = {
  quantity: t3('Сколько штук нужно?', 'Nechta dona kerak?'),
  deadline: t3('К какому сроку нужно?', 'Qachongacha kerak?'),
  delivery: t3('Нужна доставка или заберёте сами?', "Yetkazib berish kerakmi yoki o'zingiz olib ketasizmi?"),
  location: t3('Куда доставить? Отметьте точку на карте', 'Qayerga yetkazish kerak? Xaritada belgilang'),
  budget: t3('Есть ориентир по бюджету? Так предложения будут точнее', "Byudjet bo'yicha mo'ljal bormi? Takliflar aniqroq bo'ladi"),
  pcs: t3('шт', 'dona'),
  sum: t3('сум', "so'm"),
  tomorrow: t3('Завтра', 'Ertaga'),
  in3: t3('За 3 дня', '3 kunda'),
  week: t3('За неделю', 'Bir haftada'),
  twoWeeks: t3('За 2 недели', '2 haftada'),
  needDelivery: t3('Нужна доставка', 'Yetkazib berish kerak'),
  pickup: t3('Заберу сам', "O'zim olib ketaman"),
  upTo: t3('до', 'gacha'),
  yes: t3('Да', 'Ha'),
  no: t3('Нет', "Yo'q"),
};

const tr = (x: { ru: string; uz: string; uzc: string }, lang: Lang) => x[lang];

/** Дата через n дней по Ташкенту, YYYY-MM-DD. */
export function tashkentDate(today: Date, plusDays: number): string {
  return new Date(today.getTime() + 5 * 3600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
}

function fieldAsk(d: FieldDef, s: AskState, first: boolean): Ask {
  const lang = s.lang;
  const choice = d.type === 'boolean' || !!d.options?.length;
  const templated = d.ask?.[lang] ?? `${d.label[lang]}?`;
  // Для вопроса с вариантами текст — из шаблона, чтобы кнопки совпадали с вопросом.
  const text = !choice && first && s.llmQuestion ? s.llmQuestion : templated;
  const options: AskOption[] =
    d.type === 'boolean'
      ? [
          { value: true, label: tr(T.yes, lang) },
          { value: false, label: tr(T.no, lang) },
        ]
      : (d.options ?? []).slice(0, 10).map((o) => ({ value: o.value, label: o.label[lang] }));
  return {
    key: d.key,
    kind: d.key === 'quantity' ? 'quantity' : 'field',
    text,
    options,
    input: choice ? null : d.type === 'number' ? 'number' : 'text',
    unit: d.unit ?? (d.key === 'quantity' ? tr(T.pcs, lang) : null),
    optional: false,
  };
}

/** Следующий вопрос или null, если спрашивать больше нечего. */
export function nextAsk(s: AskState): Ask | null {
  if (s.answers >= MAX_QUESTIONS) return null;
  const lang = s.lang;
  const was = (k: string) => s.asked.includes(k);

  if (!s.categoryKnown) {
    return s.freeQuestion ? { key: '_free', kind: 'free', text: s.freeQuestion, options: [], input: 'text', unit: null, optional: false } : null;
  }

  const miss = missingRequired(s.defs, s.fields);
  if (miss[0]) return fieldAsk(miss[0], s, true);

  const qtyDef = s.defs.find((d) => d.key === 'quantity');
  if (qtyDef && s.quantity == null && s.fields.quantity == null && !was('quantity')) {
    return {
      key: 'quantity',
      kind: 'quantity',
      text: tr(T.quantity, lang),
      options: [100, 500, 1000, 5000].map((n) => ({ value: n, label: `${formatUzs(n)} ${tr(T.pcs, lang)}` })),
      input: 'number',
      unit: qtyDef.unit ?? tr(T.pcs, lang),
      optional: true,
    };
  }

  if (!s.deadline && !was('deadline')) {
    return {
      key: 'deadline',
      kind: 'deadline',
      text: tr(T.deadline, lang),
      options: [
        { value: tashkentDate(s.today, 1), label: tr(T.tomorrow, lang) },
        { value: tashkentDate(s.today, 3), label: tr(T.in3, lang) },
        { value: tashkentDate(s.today, 7), label: tr(T.week, lang) },
        { value: tashkentDate(s.today, 14), label: tr(T.twoWeeks, lang) },
      ],
      input: 'date',
      unit: null,
      optional: true,
    };
  }

  if (s.deliveryNeeded == null && !was('delivery')) {
    return {
      key: 'delivery',
      kind: 'delivery',
      text: tr(T.delivery, lang),
      options: [
        { value: true, label: tr(T.needDelivery, lang) },
        { value: false, label: tr(T.pickup, lang) },
      ],
      input: null,
      unit: null,
      optional: true,
    };
  }

  if (s.deliveryNeeded === true && !s.hasDeliveryPoint && !was('location')) {
    return { key: 'location', kind: 'location', text: tr(T.location, lang), options: [], input: 'map', unit: null, optional: true };
  }

  if (!s.budgetUzs && !was('budget')) {
    return {
      key: 'budget',
      kind: 'budget',
      text: tr(T.budget, lang),
      options: [500_000, 1_000_000, 3_000_000, 10_000_000].map((n) => ({ value: n, label: lang === 'ru' ? `до ${formatUzs(n)}` : `${formatUzs(n)} ${tr(T.upTo, lang)}` })),
      input: 'number',
      unit: tr(T.sum, lang),
      optional: true,
    };
  }
  return null;
}
