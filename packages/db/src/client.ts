import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';


export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
}

/** Создать пул соединений и клиент Drizzle. В Railway DATABASE_URL указывает на приватный адрес Postgres. */
export function createDb(url: string, opts: PoolConfig = {}): DbHandle {
  const needsSsl = /sslmode=require/.test(url);
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    ...opts,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
