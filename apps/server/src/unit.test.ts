import { describe, expect, it } from 'vitest';
import { InitDataError, signInitData, validateInitData, validateLoginWidget } from './auth/init-data';
import { signJwt, verifyJwt } from './common/jwt';
import { decrypt, encrypt, lookupHash, normalizePhone } from './common/crypto';
import { clickSign, type ClickParams } from './billing/click';
import { nextAllowedTime, render } from './notifications/templates';
import { detectLang, maskPII } from './parsing/text';
import { rulesParse, type CatalogEntry } from './parsing/rules-parser';
import { CATALOG } from '@dominify/db';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const BOT = '123456:TEST-token-for-unit-tests';

describe('initData', () => {
  const now = Date.UTC(2026, 9, 1, 10, 0, 0);
  const fields = {
    auth_date: String(Math.floor(now / 1000) - 60),
    query_id: 'AAE',
    user: JSON.stringify({ id: 42, first_name: 'Umid', language_code: 'uz' }),
    start_param: 'req_10',
  };

  it('принимает подпись Telegram', () => {
    const raw = signInitData(fields, BOT);
    const v = validateInitData(raw, BOT, 86_400, now);
    expect(v.user.id).toBe(42);
    expect(v.startParam).toBe('req_10');
  });

  it('принимает initData новых клиентов с полем signature', () => {
    const raw = signInitData({ ...fields, signature: 'Ed25519SignatureFromTelegram' }, BOT);
    expect(validateInitData(raw, BOT, 86_400, now).user.id).toBe(42);
  });

  it('отклоняет подделку', () => {
    const raw = signInitData(fields, BOT).replace('Umid', 'Hacker');
    expect(() => validateInitData(raw, BOT, 86_400, now)).toThrow(InitDataError);
  });

  it('отклоняет чужой токен бота', () => {
    const raw = signInitData(fields, BOT);
    expect(() => validateInitData(raw, '999:other', 86_400, now)).toThrow(InitDataError);
  });

  it('отклоняет устаревшие данные', () => {
    const raw = signInitData({ ...fields, auth_date: String(Math.floor(now / 1000) - 90_000) }, BOT);
    expect(() => validateInitData(raw, BOT, 86_400, now)).toThrow(/устарела/);
  });
});

describe('Telegram Login Widget', () => {
  it('проверяет подпись виджета', () => {
    const now = Date.now();
    const data: Record<string, string | number> = { id: 7, first_name: 'Admin', auth_date: Math.floor(now / 1000) };
    const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
    const hash = createHmac('sha256', createHash('sha256').update(BOT).digest()).update(dcs).digest('hex');
    expect(validateLoginWidget({ ...data, hash }, BOT, 3600, now).id).toBe(7);
    expect(() => validateLoginWidget({ ...data, id: 8, hash }, BOT, 3600, now)).toThrow();
  });
});

describe('JWT', () => {
  const secret = 'x'.repeat(40);
  it('подписывает и проверяет', () => {
    const t = signJwt({ sub: 1, tg: 42, scope: 'user' }, secret, 60);
    expect(verifyJwt(t, secret)?.sub).toBe(1);
    expect(verifyJwt(t, 'y'.repeat(40))).toBeNull();
    expect(verifyJwt(t.slice(0, -2) + 'aa', secret)).toBeNull();
  });
  it('истекает', () => {
    const t = signJwt({ sub: 1, tg: 42, scope: 'user' }, secret, 60, Date.now() - 120_000);
    expect(verifyJwt(t, secret)).toBeNull();
  });
});

describe('шифрование', () => {
  const key = randomBytes(32).toString('base64');
  it('AES-GCM туда и обратно', () => {
    expect(decrypt(encrypt('998901234567', key), key)).toBe('998901234567');
  });
  it('хеш для поиска стабилен и нормализует телефон', () => {
    expect(normalizePhone('+998 (90) 123-45-67')).toBe('998901234567');
    expect(normalizePhone('901234567')).toBe('998901234567');
    expect(lookupHash('998901234567', 'k')).toBe(lookupHash(' 998901234567 ', 'k'));
  });
});

describe('Click', () => {
  it('подпись prepare и complete по документации', () => {
    const p: ClickParams = {
      click_trans_id: '100',
      service_id: '5',
      merchant_trans_id: '12',
      amount: '149000',
      action: '0',
      error: '0',
      sign_time: '2026-10-01 10:00:00',
      sign_string: '',
    };
    const expected = createHash('md5').update('1005SECRET12149000' + '0' + '2026-10-01 10:00:00').digest('hex');
    expect(clickSign(p, 'SECRET')).toBe(expected);
    const c = { ...p, action: '1', merchant_prepare_id: '77' };
    const expected2 = createHash('md5').update('1005SECRET1277149000' + '1' + '2026-10-01 10:00:00').digest('hex');
    expect(clickSign(c, 'SECRET')).toBe(expected2);
  });
});

describe('тихие часы', () => {
  it('ночью переносит на 8:00 по Ташкенту', () => {
    const at = nextAllowedTime(new Date('2026-10-01T18:30:00Z'), 300, 22, 8); // 23:30 в Ташкенте
    expect(at.toISOString()).toBe('2026-10-02T03:00:00.000Z');
    const early = nextAllowedTime(new Date('2026-10-01T00:30:00Z'), 300, 22, 8); // 05:30
    expect(early.toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });
  it('днём не трогает', () => {
    const d = new Date('2026-10-01T07:00:00Z');
    expect(nextAllowedTime(d, 300, 22, 8)).toBe(d);
  });
});

describe('шаблоны уведомлений', () => {
  it('есть на трёх языках и с кнопками', () => {
    for (const lang of ['ru', 'uz', 'uzc'] as const) {
      const r = render('new_request', { requestId: 5, title: 'Визитки', summary: 'Тираж: 1000' }, lang);
      expect(r.text).toContain('Визитки');
      expect(r.buttons[0].route).toBe('req_5');
    }
  });
});

describe('тексты', () => {
  it('маскирует телефоны, карты и ИНН', () => {
    const s = maskPII('звоните +998 90 123 45 67, карта 8600 1234 5678 9012, ИНН 123456789, @umid_dad');
    expect(s).not.toMatch(/123 45 67|8600|123456789|umid_dad/);
  });
  it('определяет язык', () => {
    expect(detectLang('Нужны визитки 1000 штук')).toBe('ru');
    expect(detectLang("1000 ta vizitka kerak")).toBe('uz');
    expect(detectLang('1000 та визитка керак, қанча турaди')).toBe('uzc');
  });
});

describe('разбор правилами', () => {
  let id = 0;
  const flat: CatalogEntry[] = [];
  const walk = (list: typeof CATALOG, parentId: number | null) => {
    for (const c of list) {
      const me = ++id;
      flat.push({ id: me, slug: c.slug, parentId, name: c.name, keywords: c.keywords, fields: c.fields });
      walk(c.children ?? [], me);
    }
  };
  walk(CATALOG, null);
  const now = new Date('2026-10-01T10:00:00Z');

  it('визитки с тиражом, размером и районом', () => {
    const r = rulesParse('Нужны визитки 1000 шт 90х50, двусторонние, ламинация, Чиланзар, до 05.10', flat, now);
    expect(r.categorySlug).toBe('print.business-cards');
    expect(r.fields.quantity).toBe(1000);
    expect(r.fields.size).toContain('90×50');
    expect(r.fields.lamination).toBe(true);
    expect(r.regionCode).toBe('tashkent.chilonzor');
    expect(r.deadline).toBe('2026-10-05');
    expect(r.missingFields).toEqual([]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('пример из группы: резина для лаковой секции — расходники, спрашиваем модель машины', () => {
    const r = rulesParse('Всем здравствуйте у кого есть резина для вд лаковой секции, напишите в лс.', flat, now);
    expect(r.categorySlug).toBe('print.consumables');
    expect(r.missingFields).toContain('item');
    expect(r.question).toBeTruthy();
  });

  it('узбекский: баннер', () => {
    const r = rulesParse('Banner kerak 3x2 m, Yunusobod, ertaga', flat, now);
    expect(r.categorySlug).toBe('ads.banners');
    expect(r.lang).toBe('uz');
    expect(r.regionCode).toBe('tashkent.yunusobod');
    expect(r.deadline).toBe('2026-10-02');
    expect(r.question).toBeNull();
  });

  it('непонятная заявка — вопрос и низкая уверенность', () => {
    const r = rulesParse('помогите пожалуйста', flat, now);
    expect(r.categorySlug).toBeNull();
    expect(r.confidence).toBeLessThan(0.5);
    expect(r.question).toBeTruthy();
  });

  it('листовки без формата — спрашиваем формат', () => {
    const r = rulesParse('листовки 5000 штук', flat, now);
    expect(r.categorySlug).toBe('print.flyers');
    expect(r.missingFields).toEqual(['format']);
  });

  it('варианты select по корню слова', () => {
    const r = rulesParse('листовки А5 2000 шт двусторонние', flat, now);
    expect(r.fields.sides).toBe('4+4');
    expect(r.fields.format).toBe('A5');
  });
});
