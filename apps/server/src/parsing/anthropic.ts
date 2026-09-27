import { parseResultSchema, type ParseResult } from '@dominify/shared';
import type { CatalogEntry } from './rules-parser';

export interface LlmImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export interface LlmCallResult {
  result: ParseResult;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** JSON-схема инструмента: модель обязана вызвать его ровно с такими полями. */
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    categorySlug: { type: ['string', 'null'], description: 'slug листовой категории из списка или null' },
    title: { type: 'string', description: 'Короткий заголовок заявки на языке пользователя, до 80 символов' },
    fields: {
      type: 'object',
      description: 'Значения полей шаблона категории по их key. Для select — value варианта.',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
    regionCode: { type: ['string', 'null'], description: 'Код региона или района из списка, если назван' },
    deadline: { type: ['string', 'null'], description: 'Срок в формате YYYY-MM-DD, если назван' },
    budgetUzs: { type: ['number', 'null'], description: 'Бюджет в сумах, если назван' },
    quantity: { type: ['number', 'null'], description: 'Количество или тираж' },
    missingFields: { type: 'array', items: { type: 'string' }, description: 'key обязательных полей, которых нет в тексте' },
    question: { type: ['string', 'null'], description: 'Один уточняющий вопрос о самом важном недостающем поле, на языке пользователя' },
    confidence: { type: 'number', description: 'Уверенность в категории и полях от 0 до 1' },
    lang: { type: 'string', enum: ['ru', 'uz', 'uzc'], description: 'Язык пользователя: ru, uz (латиница), uzc (кириллица)' },
  },
  required: ['categorySlug', 'title', 'fields', 'regionCode', 'deadline', 'budgetUzs', 'quantity', 'missingFields', 'question', 'confidence', 'lang'],
};

function catalogPrompt(catalog: CatalogEntry[]): string {
  const lines: string[] = [];
  for (const root of catalog.filter((c) => !c.parentId)) {
    lines.push(`# ${root.name.ru} (${root.slug})`);
    for (const c of catalog.filter((x) => x.parentId === root.id)) {
      const fields = c.fields
        .map((f) => {
          const opts = f.options ? ` [${f.options.map((o) => o.value).join('|')}]` : '';
          return `${f.key}${f.required ? '*' : ''}:${f.type}${opts}`;
        })
        .join(', ');
      lines.push(`- ${c.slug}: ${c.name.ru} / ${c.name.uz}. Поля: ${fields}`);
    }
  }
  return lines.join('\n');
}

/**
 * Разбор через Claude Messages API с принудительным вызовом инструмента.
 * Текст уже очищен от телефонов и ИНН (maskPII).
 */
export async function anthropicParse(opts: {
  apiKey: string;
  model: string;
  text: string;
  answers: { q: string; a: string }[];
  catalog: CatalogEntry[];
  regions: string[];
  images: LlmImage[];
  today: string;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const system = [
    'Ты разбираешь B2B-заявки на полиграфию и наружную рекламу в Узбекистане.',
    'Пишут на русском, узбекском (латиница или кириллица) или смеси, часто коротко и с ошибками.',
    'Выбери одну листовую категорию из каталога, заполни поля шаблона по key, остальное оставь null.',
    'Поля со звёздочкой обязательны: если их нет в тексте, перечисли их в missingFields и задай один короткий вопрос о самом важном.',
    'Ничего не выдумывай. Если заявка не про наши категории, верни categorySlug null и низкую уверенность.',
    `Сегодня ${opts.today}. Часовой пояс Ташкента.`,
    '',
    'Каталог:',
    catalogPrompt(opts.catalog),
    '',
    `Регионы: ${opts.regions.join(', ')}`,
  ].join('\n');

  const userText = [
    `Заявка: ${opts.text || '(только вложения)'}`,
    ...opts.answers.map((x) => `Уточнение. Вопрос: ${x.q}\nОтвет: ${x.a}`),
  ].join('\n\n');

  const content: unknown[] = opts.images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mime, data: img.base64 },
  }));
  content.push({ type: 'text', text: userText });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 1024,
        system,
        tools: [{ name: 'save_request', description: 'Сохранить разобранную заявку', input_schema: TOOL_SCHEMA }],
        tool_choice: { type: 'tool', name: 'save_request' },
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      content: { type: string; name?: string; input?: unknown }[];
      usage?: { input_tokens: number; output_tokens: number };
      model: string;
    };
    const tool = data.content.find((c) => c.type === 'tool_use' && c.name === 'save_request');
    if (!tool) throw new Error('Модель не вернула результат разбора');
    const parsed = parseResultSchema.parse(tool.input);
    return {
      result: parsed,
      model: data.model ?? opts.model,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
