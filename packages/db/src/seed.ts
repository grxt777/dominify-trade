import { sql } from 'drizzle-orm';
import { CATALOG, type SeedCategory } from './catalog';
import { createDb, type Db } from './client';
import { categories } from './schema';

/** Идемпотентно залить каталог: существующие slug обновляются, новые добавляются. */
export async function seedCatalog(db: Db): Promise<number> {
  let count = 0;
  const upsert = async (c: SeedCategory, parentId: number | null, sort: number) => {
    const [row] = await db
      .insert(categories)
      .values({ slug: c.slug, name: c.name, fields: c.fields, keywords: c.keywords, parentId, sort })
      .onConflictDoUpdate({
        target: categories.slug,
        set: { name: c.name, fields: c.fields, keywords: c.keywords, parentId, sort, active: true },
      })
      .returning({ id: categories.id });
    count += 1;
    let i = 0;
    for (const child of c.children ?? []) {
      await upsert(child, row.id, i++);
    }
  };
  let i = 0;
  for (const root of CATALOG) await upsert(root, null, i++);
  return count;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL не задан');
    process.exit(1);
  }
  const { db, pool } = createDb(url, { max: 1 });
  seedCatalog(db)
    .then(async (n) => {
      const [{ c }] = (await db.execute(sql`select count(*)::int as c from categories`)).rows as { c: number }[];
      console.log(`Каталог: обработано ${n}, всего категорий ${c}`);
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
