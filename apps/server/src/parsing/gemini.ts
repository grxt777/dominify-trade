import { parseResultSchema, type ParseResult } from '@dominify/shared';
import type { LlmCallResult, LlmImage } from './anthropic';
import { buildSystemPrompt, buildUserText } from './anthropic';
import type { CatalogEntry } from './rules-parser';

/**
 * JSON-схема ответа для Gemini. Поля шаблона — массив пар key/value, а не объект со свободными ключами:
 * так схема остаётся в поддерживаемом Gemini подмножестве JSON Schema.
 */
export const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    categorySlug: { type: ['string', 'null'], description: 'slug листовой категории из каталога или null' },
    title: { type: 'string', description: 'Короткий заголовок заявки на языке пользователя, до 80 символов' },
    fields: {
      type: 'array',
      description: 'Значения полей шаблона категории. Для select — value варианта.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: ['string', 'number', 'boolean', 'null'] },
        },
        required: ['key', 'value'],
      },
    },
    regionCode: { type: ['string', 'null'], description: 'Код региона или района из списка, если назван' },
    deadline: { type: ['string', 'null'], description: 'Срок в формате YYYY-MM-DD, если назван' },
    budgetUzs: { type: ['number', 'null'], description: 'Бюджет в сумах, если назван' },
    quantity: { type: ['number', 'null'], description: 'Количество или тираж' },
    delivery: { type: ['boolean', 'null'], description: 'true — нужна доставка/монтаж на месте, false — заберёт сам, null — не сказано' },
    deliveryAddress: { type: ['string', 'null'], description: 'Адрес или ориентир доставки, как написал покупатель' },
    missingFields: { type: 'array', items: { type: 'string' }, description: 'key обязательных полей, которых нет в тексте' },
    question: { type: ['string', 'null'], description: 'Один уточняющий вопрос о самом важном недостающем поле, на языке пользователя' },
    confidence: { type: 'number', description: 'Уверенность от 0 до 1' },
    lang: { type: 'string', enum: ['ru', 'uz', 'uzc'], description: 'Язык пользователя: ru, uz (латиница), uzc (кириллица)' },
  },
  required: ['categorySlug', 'title', 'fields', 'regionCode', 'deadline', 'budgetUzs', 'quantity', 'delivery', 'deliveryAddress', 'missingFields', 'question', 'confidence', 'lang'],
};

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

/** Превратить ответ Gemini в ParseResult: массив полей → объект, проверка zod. */
export function geminiToResult(raw: unknown): ParseResult {
  const obj = { ...(raw as Record<string, unknown>) };
  const list = Array.isArray(obj.fields) ? (obj.fields as { key?: unknown; value?: unknown }[]) : [];
  obj.fields = Object.fromEntries(
    list.filter((f) => typeof f?.key === 'string' && f.key).map((f) => [f.key as string, (f.value ?? null) as string | number | boolean | null]),
  );
  if (typeof obj.confidence === 'number') obj.confidence = Math.min(1, Math.max(0, obj.confidence));
  return parseResultSchema.parse(obj);
}

/** Разбор через Gemini API (generateContent) со строгой JSON-схемой ответа. */
export async function geminiParse(opts: {
  apiKey: string;
  model: string;
  text: string;
  answers: { q: string; a: string }[];
  catalog: CatalogEntry[];
  regions: string[];
  images: LlmImage[];
  today: string;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
}): Promise<LlmCallResult> {
  const parts: unknown[] = opts.images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.base64 } }));
  parts.push({ text: buildUserText(opts.text, opts.answers) });

  // При всплесках нагрузки Gemini отвечает 503/429 или зависает: одна повторная попытка с паузой
  // дешевле, чем откат на разбор правилами, а короткий таймаут не держит покупателя дольше ~30 с.
  const delays = opts.retryDelaysMs ?? [1000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await geminiOnce(opts, parts);
    } catch (e) {
      if (!isTransient(e) || attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/** Перегрузка, лимит или зависание — повод попробовать ещё раз или другую модель. */
function isTransient(e: unknown): boolean {
  const name = (e as Error)?.name;
  return name === 'AbortError' || name === 'TimeoutError' || (e instanceof GeminiHttpError && [429, 500, 503].includes(e.status));
}

/**
 * Разбор с запасными моделями: при перегрузке или лимите основной модели (на бесплатном тарифе
 * квоты у моделей раздельные) сразу пробуем следующую. Любая ошибка модели — повод взять следующую:
 * запасная может, например, не поддерживать какой-то параметр. Наружу уходят все причины.
 */
export async function geminiParseChain(opts: Parameters<typeof geminiParse>[0], models: string[]): Promise<LlmCallResult> {
  const list = [...new Set(models.filter(Boolean))];
  const errors: string[] = [];
  for (const model of list) {
    try {
      return await geminiParse({ ...opts, model, retryDelaysMs: [] });
    } catch (e) {
      errors.push(`${model}: ${(e as Error).name === 'AbortError' ? 'таймаут' : (e as Error).message.slice(0, 120)}`);
    }
  }
  throw new Error(errors.join(' | ') || 'Нет моделей Gemini');
}

class GeminiHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Gemini API ${status}: ${body.slice(0, 300)}`);
  }
}

async function geminiOnce(opts: Parameters<typeof geminiParse>[0], parts: unknown[]): Promise<LlmCallResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(opts.catalog, opts.regions, opts.today) }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: GEMINI_SCHEMA,
            temperature: 0.1,
            maxOutputTokens: 2048,
            // Извлечение полей не требует долгих рассуждений: низкий уровень заметно быстрее.
            thinkingConfig: { thinkingLevel: 'low' },
          },
        }),
      },
    );
    if (!res.ok) throw new GeminiHttpError(res.status, await res.text());
    const data = (await res.json()) as GeminiResponse;
    if (data.promptFeedback?.blockReason) throw new Error(`Gemini заблокировал запрос: ${data.promptFeedback.blockReason}`);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Gemini вернул пустой ответ (${data.candidates?.[0]?.finishReason ?? 'нет кандидатов'})`);
    // На случай, если модель всё же обернёт JSON в блок кода.
    const json = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return {
      result: geminiToResult(JSON.parse(json)),
      model: data.modelVersion ?? opts.model,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
