import { Controller, Get, Inject, Injectable } from '@nestjs/common';
import { categories, type Db } from '@dominify/db';
import { REGIONS, type CategoryNode, type FieldDef } from '@dominify/shared';
import { eq } from 'drizzle-orm';
import { Public } from '../auth/guards';
import { DB } from '../infra/tokens';

type Row = typeof categories.$inferSelect;

/** Каталог категорий с кэшем в памяти: меняется редко, читается на каждой заявке. */
@Injectable()
export class CatalogService {
  private cache: { at: number; rows: Row[] } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async all(): Promise<Row[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.rows;
    const rows = await this.db.select().from(categories).where(eq(categories.active, true)).orderBy(categories.sort, categories.id);
    this.cache = { at: Date.now(), rows };
    return rows;
  }

  invalidate() {
    this.cache = null;
  }

  async tree(): Promise<CategoryNode[]> {
    const rows = await this.all();
    const map = new Map<number, CategoryNode>();
    rows.forEach((r) => map.set(r.id, { id: r.id, slug: r.slug, parentId: r.parentId, name: r.name, fields: r.fields, children: [] }));
    const roots: CategoryNode[] = [];
    map.forEach((n) => {
      if (n.parentId && map.has(n.parentId)) map.get(n.parentId)!.children!.push(n);
      else roots.push(n);
    });
    return roots;
  }

  async byId(id: number): Promise<Row | undefined> {
    return (await this.all()).find((r) => r.id === id);
  }

  async bySlug(slug: string): Promise<Row | undefined> {
    return (await this.all()).find((r) => r.slug === slug);
  }

  /** Поля шаблона заявки: свои поля категории плюс поля родителя. */
  async fieldsFor(categoryId: number): Promise<FieldDef[]> {
    const c = await this.byId(categoryId);
    if (!c) return [];
    const parent = c.parentId ? await this.byId(c.parentId) : undefined;
    const seen = new Set<string>();
    return [...c.fields, ...(parent?.fields ?? [])].filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
  }

  /** ID категории и всех её потомков (поставщик вертикали получает заявки подкатегорий). */
  async withDescendants(categoryId: number): Promise<number[]> {
    const rows = await this.all();
    const out = [categoryId];
    for (let i = 0; i < out.length; i++) rows.filter((r) => r.parentId === out[i]).forEach((r) => out.push(r.id));
    return out;
  }

  /** Родитель категории (вертикаль). */
  async rootOf(categoryId: number): Promise<number> {
    let c = await this.byId(categoryId);
    while (c?.parentId) {
      const p = await this.byId(c.parentId);
      if (!p) break;
      c = p;
    }
    return c?.id ?? categoryId;
  }
}

@Controller('v1')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Get('categories')
  categories() {
    return this.catalog.tree();
  }

  @Public()
  @Get('regions')
  regions() {
    return REGIONS;
  }
}
