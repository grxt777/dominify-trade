import { describe, expect, it } from 'vitest';
import { geminiParse, geminiToResult } from './parsing/gemini';

const catalog = [
  { id: 1, slug: 'print', parentId: null, name: { ru: 'Полиграфия', uz: 'Poligrafiya', uzc: 'Полиграфия' }, keywords: '', fields: [] },
  {
    id: 2,
    slug: 'print.business-cards',
    parentId: 1,
    name: { ru: 'Визитки', uz: 'Vizitkalar', uzc: 'Визиткалар' },
    keywords: 'визитк',
    fields: [{ key: 'quantity', label: { ru: 'Тираж', uz: 'Tiraj', uzc: 'Тираж' }, type: 'number' as const, required: true }],
  },
];

const answer = {
  categorySlug: 'print.business-cards',
  title: 'Визитки, 1000',
  fields: [
    { key: 'quantity', value: 1000 },
    { key: 'lamination', value: true },
  ],
  regionCode: 'tashkent.chilonzor',
  deadline: null,
  budgetUzs: null,
  quantity: 1000,
  missingFields: [],
  question: null,
  confidence: 0.92,
  lang: 'ru',
};

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = { apiKey: 'KEY', model: 'gemini-3.8-flash', text: 'Нужны визитки 1000 шт', answers: [], catalog, regions: ['tashkent'], images: [], today: '2026-10-01' };

describe('Gemini', () => {
  it('шлёт generateContent со схемой и ключом в заголовке', async () => {
    const f = fakeFetch({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 }, modelVersion: 'gemini-3.8-flash-001' });
    const r = await geminiParse({ ...base, images: [{ mime: 'image/png', base64: 'AAA' }], fetchImpl: f.impl });
    expect(f.calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect((f.calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY');
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema.required).toContain('categorySlug');
    expect(body.systemInstruction.parts[0].text).toContain('print.business-cards');
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: 'AAA' });
    expect(r.result.categorySlug).toBe('print.business-cards');
    expect(r.result.fields).toEqual({ quantity: 1000, lamination: true });
    expect(r.inputTokens).toBe(900);
    expect(r.model).toBe('gemini-3.8-flash-001');
  });

  it('понимает JSON в блоке кода', async () => {
    const f = fakeFetch({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(answer) + '\n```' }] } }] });
    const r = await geminiParse({ ...base, fetchImpl: f.impl });
    expect(r.result.confidence).toBe(0.92);
  });

  it('ошибка HTTP и пустой ответ — исключение, чтобы сработал разбор правилами', async () => {
    await expect(geminiParse({ ...base, fetchImpl: fakeFetch({ error: { message: 'API key not valid' } }, 400).impl })).rejects.toThrow(/Gemini API 400/);
    await expect(geminiParse({ ...base, fetchImpl: fakeFetch({ candidates: [{ finishReason: 'SAFETY' }] }).impl })).rejects.toThrow(/SAFETY/);
  });

  it('при 503 повторяет запрос, а 400 не повторяет', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] };
    let n = 0;
    const flaky = (async () => {
      n++;
      return n === 1
        ? new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 })
        : new Response(JSON.stringify(ok), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await geminiParse({ ...base, fetchImpl: flaky, retryDelaysMs: [0, 0] });
    expect(n).toBe(2);
    expect(r.result.categorySlug).toBe('print.business-cards');

    const bad = fakeFetch({ error: { message: 'bad' } }, 400);
    await expect(geminiParse({ ...base, fetchImpl: bad.impl, retryDelaysMs: [0, 0] })).rejects.toThrow(/400/);
    expect(bad.calls).toHaveLength(1);
  });

  it('невалидная структура отклоняется', () => {
    expect(() => geminiToResult({ ...answer, lang: 'en' })).toThrow();
    expect(geminiToResult({ ...answer, confidence: 1.4 }).confidence).toBe(1);
  });
});
