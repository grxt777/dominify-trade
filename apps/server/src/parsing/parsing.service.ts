import { Inject, Injectable, Logger } from '@nestjs/common';
import { aiUsage, files, gigs, requestFiles, requests, type Db } from '@dominify/db';
import { maskPII } from './text';
import { CatalogService } from '../catalog/catalog';
import { rulesParse, questionNoCategory, type CatalogEntry } from './rules-parser';
import { anthropicParse, type LlmCallResult, type LlmImage } from './anthropic';
import { geminiParseChain } from './gemini';
import { transcribe } from './stt';
import { missingRequired, REGIONS, type ParseResult } from '@dominify/shared';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { StorageService } from '../infra/storage';
import { CONFIG, DB } from '../infra/tokens';
import { MAX_QUESTIONS } from '../requests/clarify';

type LlmArgs = {
  text: string;
  answers: { q: string; a: string }[];
  catalog: CatalogEntry[];
  regions: string[];
  images: LlmImage[];
  today: string;
};

export interface ParseOutcome {
  status: 'draft' | 'needs_info';
  result: ParseResult;
  duplicateOf: number | null;
}

/** ИИ-разбор заявок. Вызывается воркером из очереди parse. */
@Injectable()
export class ParsingService {
  private readonly log = new Logger('Parsing');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly catalog: CatalogService,
    private readonly storage: StorageService,
  ) {}

  private async entries(): Promise<CatalogEntry[]> {
    return (await this.catalog.all()).map((c) => ({
      id: c.id,
      slug: c.slug,
      parentId: c.parentId,
      name: c.name,
      keywords: c.keywords,
      fields: c.fields,
    }));
  }

  /** Разобрать заявку и сохранить результат. */
  async parseRequest(requestId: number): Promise<ParseOutcome | null> {
    const [req] = await this.db.select().from(requests).where(eq(requests.id, requestId));
    if (!req || !['draft', 'needs_info'].includes(req.status)) return null;

    const catalog = await this.entries();
    const fullText = [req.rawText, ...req.answers.map((x) => x.a)].filter(Boolean).join('\n');
    let result: ParseResult;

    const llm = this.llm();
    if (llm) {
      const images = await this.images(requestId);
      const args = {
        text: maskPII(req.rawText),
        answers: req.answers.map((x) => ({ q: x.q, a: maskPII(x.a) })),
        catalog,
        regions: REGIONS.map((r) => r.code),
        images,
        today: new Date().toISOString().slice(0, 10),
      };
      try {
        // Фото и макеты — сразу сильной модели; текст — быстрой, а при низкой уверенности повторяем сильной.
        const useSmart = images.length > 0;
        let call = await llm.call(args, useSmart ? llm.smart : llm.fast);
        await this.usage(requestId, call.model, call.inputTokens, call.outputTokens, true);
        if (!useSmart && call.result.confidence < this.cfg.LLM_CONFIDENCE_THRESHOLD) {
          call = await llm.call(args, llm.smart);
          await this.usage(requestId, call.model, call.inputTokens, call.outputTokens, true);
        }
        result = call.result;
      } catch (e) {
        this.log.warn(`ИИ недоступен для заявки ${requestId}, разбираю правилами: ${(e as Error).message}`);
        await this.usage(requestId, llm.fast, 0, 0, false);
        result = rulesParse(fullText, catalog);
      }
    } else {
      result = rulesParse(fullText, catalog);
    }

    // Заказ с витрины: категория и цена уже выбраны покупателем, модель лишь достаёт поля.
    if (req.gigId) {
      const [g] = await this.db.select({ categoryId: gigs.categoryId, packages: gigs.packages }).from(gigs).where(eq(gigs.id, req.gigId));
      const gc = g?.categoryId ? catalog.find((c) => c.id === g.categoryId) : undefined;
      if (gc) {
        result.categorySlug = gc.slug;
        result.confidence = Math.max(result.confidence, 0.95);
      }
      const pkg = g?.packages.find((p) => p.code === req.gigPackage);
      if (pkg && !result.budgetUzs) result.budgetUzs = pkg.priceUzs;
    }

    // Не доверяем модели на слово: категория должна существовать и быть листовой.
    const cat = result.categorySlug ? catalog.find((c) => c.slug === result.categorySlug) : undefined;
    const isLeaf = cat && !catalog.some((c) => c.parentId === cat.id);
    if (!cat || !isLeaf) {
      result.categorySlug = null;
      result.confidence = Math.min(result.confidence, 0.3);
    }
    const fields = { ...(req.fields ?? {}), ...Object.fromEntries(Object.entries(result.fields).filter(([, v]) => v !== null && v !== '')) };
    if (result.quantity && fields.quantity === undefined) fields.quantity = result.quantity;

    let missing: string[] = [];
    let question = result.question;
    let askKey: string | null = null;
    const canAsk = req.answers.length < MAX_QUESTIONS;
    if (cat && isLeaf) {
      const template = await this.catalog.fieldsFor(cat.id);
      const miss = missingRequired(template, fields);
      missing = miss.map((m) => m.key);
      const first = miss[0];
      if (!first || !canAsk) question = null;
      else {
        askKey = first.key;
        // У поля с вариантами вопрос берём из шаблона: кнопки быстрых ответов должны совпадать с вопросом.
        const choice = first.type === 'boolean' || !!first.options?.length;
        const templated = first.ask?.[result.lang] ?? `${first.label[result.lang]}?`;
        question = choice ? templated : question || templated;
      }
    } else {
      question = canAsk ? (question ?? questionNoCategory(result.lang)) : null;
    }
    result.missingFields = missing;
    result.question = question;
    delete fields._ask;
    if (askKey) fields._ask = askKey;

    const duplicateOf = await this.findDuplicate(req.authorUserId, requestId, req.rawText);
    const status: ParseOutcome['status'] = !cat || missing.length ? 'needs_info' : 'draft';

    await this.db
      .update(requests)
      .set({
        categoryId: cat?.id ?? null,
        title: result.title?.slice(0, 200) || req.rawText.slice(0, 80),
        fields: duplicateOf ? { ...fields, _duplicateOf: duplicateOf } : fields,
        regionCode: result.regionCode ?? req.regionCode,
        deadline: result.deadline ?? req.deadline,
        budgetUzs: result.budgetUzs ?? req.budgetUzs,
        deliveryNeeded: result.delivery ?? req.deliveryNeeded,
        deliveryAddress: req.deliveryAddress ?? result.deliveryAddress?.slice(0, 300) ?? null,
        quantity: typeof fields.quantity === 'number' ? fields.quantity : req.quantity,
        confidence: result.confidence,
        missingFields: missing,
        question,
        lang: result.lang,
        status,
        updatedAt: new Date(),
      })
      .where(eq(requests.id, requestId));

    return { status, result, duplicateOf };
  }

  /** Настроенный провайдер ИИ: Claude, Gemini или null (разбор правилами). */
  private llm(): { fast: string; smart: string; call: (a: LlmArgs, model: string) => Promise<LlmCallResult> } | null {
    if (this.cfg.LLM_PROVIDER === 'anthropic' && this.cfg.ANTHROPIC_API_KEY) {
      return {
        fast: this.cfg.LLM_MODEL_FAST,
        smart: this.cfg.LLM_MODEL_SMART,
        call: (a, model) => anthropicParse({ ...a, apiKey: this.cfg.ANTHROPIC_API_KEY, model }),
      };
    }
    if (this.cfg.LLM_PROVIDER === 'gemini' && this.cfg.GEMINI_API_KEY) {
      return {
        fast: this.cfg.GEMINI_MODEL_FAST,
        smart: this.cfg.GEMINI_MODEL_SMART,
        call: (a, model) =>
          geminiParseChain({ ...a, apiKey: this.cfg.GEMINI_API_KEY, model }, [model, ...this.cfg.GEMINI_MODEL_FALLBACKS.split(',').map((m) => m.trim())]),
      };
    }
    return null;
  }

  /** Похожая заявка того же автора за сутки: сходство триграмм выше 0.8. */
  private async findDuplicate(authorId: number, selfId: number, text: string): Promise<number | null> {
    if (text.trim().length < 12) return null;
    const rows = await this.db
      .select({ id: requests.id })
      .from(requests)
      .where(
        and(
          eq(requests.authorUserId, authorId),
          ne(requests.id, selfId),
          gt(requests.createdAt, sql`now() - interval '24 hours'`),
          sql`similarity(${requests.rawText}, ${text}) > 0.8`,
          sql`${requests.status} not in ('cancelled','rejected')`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private async images(requestId: number): Promise<LlmImage[]> {
    const rows = await this.db
      .select({ key: files.key, mime: files.mime })
      .from(requestFiles)
      .innerJoin(files, eq(files.id, requestFiles.fileId))
      .where(and(eq(requestFiles.requestId, requestId), eq(files.status, 'ready')));
    const out: LlmImage[] = [];
    for (const f of rows.filter((r) => /^image\/(jpeg|png|webp)$/.test(r.mime)).slice(0, 3)) {
      try {
        const buf = await this.storage.get(f.key);
        if (buf.length <= 4 * 1024 * 1024) out.push({ mime: f.mime as LlmImage['mime'], base64: buf.toString('base64') });
      } catch (e) {
        this.log.warn(`Не удалось прочитать файл ${f.key}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  private async usage(requestId: number, model: string, inputTokens: number, outputTokens: number, ok: boolean) {
    await this.db.insert(aiUsage).values({ requestId, kind: 'parse', model, inputTokens, outputTokens, ok });
  }

  /** Сколько разборов пользователь сделал сегодня: для дневного лимита. */
  async todayCount(userId: number): Promise<number> {
    const [r] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(requests)
      .where(and(eq(requests.authorUserId, userId), gt(requests.createdAt, sql`now() - interval '24 hours'`)));
    return r?.c ?? 0;
  }

  /** Голос в текст. Без настроенного провайдера возвращает null. */
  async speechToText(audio: Buffer, fileName: string, mime: string): Promise<string | null> {
    if (!this.cfg.STT_API_URL || !this.cfg.STT_API_KEY) return null;
    try {
      const text = await transcribe({ url: this.cfg.STT_API_URL, apiKey: this.cfg.STT_API_KEY, model: this.cfg.STT_MODEL, audio, fileName, mime });
      await this.db.insert(aiUsage).values({ kind: 'stt', model: this.cfg.STT_MODEL, ok: true });
      return text || null;
    } catch (e) {
      this.log.warn(`Распознавание речи не удалось: ${(e as Error).message}`);
      await this.db.insert(aiUsage).values({ kind: 'stt', model: this.cfg.STT_MODEL, ok: false });
      return null;
    }
  }
}
