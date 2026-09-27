import { COMMON_FIELDS, missingRequired, REGIONS, type FieldDef, type I18nText, type ParseResult } from '@dominify/shared';
import { detectLang } from './text';

export interface CatalogEntry {
  id: number;
  slug: string;
  parentId: number | null;
  name: I18nText;
  keywords: string;
  fields: FieldDef[];
}

const DISTRICT_ROOTS: Record<string, string[]> = {
  'tashkent.chilonzor': ['чиланзар', 'chilonzor', 'чилонзор'],
  'tashkent.yunusobod': ['юнусабад', 'yunusobod', 'юнусобод'],
  'tashkent.mirzo_ulugbek': ['улугбек', 'ulug', 'улуғбек'],
  'tashkent.yakkasaroy': ['яккасарай', 'yakkasaroy', 'яккасарой'],
  'tashkent.shayxontohur': ['шайхантахур', 'shayxontohur', 'шайхонтоҳур'],
  'tashkent.olmazor': ['алмазар', 'olmazor', 'олмазор'],
  'tashkent.mirobod': ['мирабад', 'mirobod', 'миробод'],
  'tashkent.sergeli': ['сергел', 'sergeli'],
  'tashkent.uchtepa': ['учтеп', 'uchtepa'],
  'tashkent.yashnobod': ['яшнабад', 'yashnobod', 'яшнобод'],
  'tashkent.bektemir': ['бектемир', 'bektemir'],
  'tashkent.yangihayot': ['янгихаёт', 'yangihayot'],
};

function num(s: string): number {
  return Number(s.replace(/[\s ]/g, '').replace(',', '.'));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Разбор заявки без ИИ: ключевые слова категорий и регулярные выражения.
 * Нужен для локальной разработки, тестов и как запасной путь, если провайдер ИИ недоступен.
 */
export function rulesParse(text: string, catalog: CatalogEntry[], now = new Date()): ParseResult {
  const t = ` ${text.toLowerCase().replace(/ё/g, 'е')} `;
  const lang = detectLang(text);

  // Категория: больше всего совпавших корней среди листовых категорий.
  const leaves = catalog.filter((c) => !catalog.some((x) => x.parentId === c.id));
  let best: { c: CatalogEntry; hits: number } | null = null;
  for (const c of leaves) {
    const roots = c.keywords.split(/\s+/).filter((k) => k.length >= 3);
    const hits = roots.filter((r) => t.includes(r.toLowerCase().replace(/ё/g, 'е'))).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { c, hits };
  }
  const cat = best?.c ?? null;
  const parent = cat?.parentId ? catalog.find((c) => c.id === cat.parentId) : undefined;
  const fields: FieldDef[] = [...(cat?.fields ?? []), ...(parent?.fields ?? [])];

  const values: Record<string, string | number | boolean | null> = {};

  // Количество: «1000 шт», «тираж 500», «500 dona».
  let quantity: number | null = null;
  const q1 = t.match(/(\d[\d\s]{0,9})\s*(шт|штук|экз|dona|ta\b|pcs)/);
  const q2 = t.match(/(тираж|tiraj|количеств\w*|miqdor\w*)\s*:?\s*(\d[\d\s]{0,9})/);
  if (q1) quantity = num(q1[1]);
  else if (q2) quantity = num(q2[2]);
  if (quantity !== null && Number.isFinite(quantity) && quantity > 0) values.quantity = quantity;
  else quantity = null;

  // Размер: «3х2 м», «90*50 мм».
  const size = t.match(/(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)\s*(мм|см|м|mm|sm|cm|m)?\b/);
  if (size) values.size = `${size[1]}×${size[2]}${size[3] ? ` ${size[3]}` : ''}`;

  // Формат A3–A6 (латинская и кириллическая «А»).
  const fmt = t.match(/[\s(]([aа])\s?([3-6])[\s,.)]/);
  if (fmt) values.format = `A${fmt[2]}`;

  // Значения select-полей по подписям вариантов.
  for (const fd of fields) {
    if (fd.type !== 'select' || values[fd.key] !== undefined || !fd.options) continue;
    const hit = fd.options.find((o) => [o.label.ru, o.label.uz].some((l) => l.length >= 3 && t.includes(l.toLowerCase().slice(0, Math.max(4, l.length - 2)))));
    if (hit) values[fd.key] = hit.value;
  }
  if (/ламинац|laminats/.test(t)) values.lamination = true;
  if (/монтаж|установк|o'rnat|ornat|montaj/.test(t)) values.installation = true;
  if (/подсветк|светящ|yoritish/.test(t)) values.lighting = true;

  // Бюджет: «до 2 млн», «бюджет 500 тыс».
  let budgetUzs: number | null = null;
  const b = t.match(/(\d+(?:[.,]\d+)?)\s*(млн|mln|million|миллион)/);
  const b2 = t.match(/(\d[\d\s]*)\s*(тыс|ming|k\b)/);
  const b3 = t.match(/(\d[\d\s]{3,})\s*(сум|so'm|som|sum)/);
  if (b) budgetUzs = Math.round(num(b[1]) * 1_000_000);
  else if (b2 && /(бюджет|до |gacha|byudjet)/.test(t)) budgetUzs = Math.round(num(b2[1]) * 1_000);
  else if (b3) budgetUzs = num(b3[1]);

  // Срок.
  let deadline: string | null = null;
  const d = new Date(now);
  if (/завтра|ertaga|эртага/.test(t)) deadline = isoDate(new Date(d.getTime() + 86_400_000));
  else if (/сегодня|bugun|бугун|срочно|shoshilinch/.test(t)) deadline = isoDate(d);
  const dm = t.match(/(?:до|к|gacha)\s*(\d{1,2})[./](\d{1,2})/) ?? t.match(/(\d{1,2})[./](\d{1,2})\s*(?:gacha|гача)/);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let y = now.getUTCFullYear();
      if (month - 1 < now.getUTCMonth()) y += 1;
      deadline = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Район.
  let regionCode: string | null = null;
  for (const [code, roots] of Object.entries(DISTRICT_ROOTS)) {
    if (roots.some((r) => t.includes(r))) {
      regionCode = code;
      break;
    }
  }
  if (!regionCode) {
    const reg = REGIONS.filter((r) => !r.parent).find((r) =>
      [r.name.ru, r.name.uz].some((n) => t.includes(n.toLowerCase().slice(0, Math.max(5, n.length - 2)))),
    );
    if (reg) regionCode = reg.code;
  }

  const required = fields.filter((f) => f.required);
  const missing = missingRequired(required, values);
  const firstAsk = missing.find((m) => m.ask)?.ask;
  // Категория найдена и все обязательные поля на месте — заявку можно отправлять без модератора.
  const confidence = cat ? Math.min(0.9, 0.6 + 0.1 * Math.min(best!.hits, 2) + (missing.length === 0 ? 0.1 : 0)) : 0.2;

  const oneLine = text.replace(/\s+/g, ' ').trim();
  return {
    categorySlug: cat?.slug ?? null,
    title: cat ? `${cat.name[lang]}${quantity ? `, ${quantity}` : ''}` : oneLine.slice(0, 80),
    fields: values,
    regionCode,
    deadline,
    budgetUzs,
    quantity,
    missingFields: missing.map((m) => m.key),
    question: firstAsk ? firstAsk[lang] : cat ? null : questionNoCategory(lang),
    confidence,
    lang,
  };
}

export function questionNoCategory(lang: 'ru' | 'uz' | 'uzc'): string {
  return {
    ru: 'Уточните, пожалуйста, что именно нужно: печать, вывеска, баннер или что-то другое?',
    uz: "Iltimos, aniq nima kerakligini yozing: bosma, peshlavha, banner yoki boshqa narsami?",
    uzc: 'Илтимос, аниқ нима кераклигини ёзинг: босма, пешлавҳа, баннер ёки бошқа нарсами?',
  }[lang];
}

export { COMMON_FIELDS };
