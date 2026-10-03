/* Для e2e: сдвигает время просмотра услуги и закрытия сделки в прошлое и прогоняет напоминания.
 * Запуск: node dist/e2e/growth.js <telegramId зрителя> <id сделки>. Печатает JSON с итогом. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Db } from '@dominify/db';
import { sql } from 'drizzle-orm';
import { GrowthService } from '../growth/growth';
import { DB } from '../infra/tokens';
import { WorkerModule } from '../modules';

async function main() {
  const [viewerTg, dealId] = process.argv.slice(2).map(Number);
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  const db = app.get<Db>(DB);
  const viewer = sql`(select id from users where telegram_id = ${viewerTg})`;
  await db.execute(sql`update gig_views set viewed_at = now() - interval '25 hours', reminded_at = null where user_id = ${viewer}`);
  await db.execute(sql`update deals set completed_at = now() - interval '31 days' where id = ${dealId}`);
  const first = await app.get(GrowthService).sweep();
  const second = await app.get(GrowthService).sweep();
  const sent = await db.execute<{ type: string; payload: Record<string, unknown> }>(sql`
    select n.type, n.payload from notifications n
    where n.type in ('gig_reminder', 'reorder_nudge')
      and (n.user_id = ${viewer} or n.user_id = (select buyer_user_id from deals where id = ${dealId}))`);
  console.log(JSON.stringify({ first, second, sent: sent.rows }));
  await app.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
