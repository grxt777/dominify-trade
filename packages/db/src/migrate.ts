import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** Применить миграции. На Railway вызывается pre-deploy командой сервиса api. */
export async function runMigrations(url: string): Promise<void> {
  const { db, pool } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL не задан');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => {
      console.log('Миграции применены');
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
