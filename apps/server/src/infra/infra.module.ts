import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { createDb, events, type Db } from '@dominify/db';
import IORedis from 'ioredis';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config';
import { QueueService } from './queues';
import { RealtimeEmitter } from './realtime-emitter';
import { StorageService } from './storage';
import { CONFIG, DB, DB_POOL, REDIS } from './tokens';

/** Продуктовые события для аналитики: пишем в Postgres, позже можно дублировать в PostHog. */
@Injectable()
export class Analytics {
  constructor(@Inject(DB) private readonly db: Db) {}

  track(name: string, userId: number | null, props: Record<string, unknown> = {}): void {
    this.db
      .insert(events)
      .values({ name, userId, props })
      .catch(() => undefined);
  }
}

@Injectable()
class Shutdown implements OnModuleDestroy {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  async onModuleDestroy() {
    await this.pool.end().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }
}

const dbHandle = {
  provide: 'DB_HANDLE',
  inject: [CONFIG],
  useFactory: (cfg: Config) => createDb(cfg.DATABASE_URL),
};

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    dbHandle,
    { provide: DB, inject: ['DB_HANDLE'], useFactory: (h: ReturnType<typeof createDb>) => h.db },
    { provide: DB_POOL, inject: ['DB_HANDLE'], useFactory: (h: ReturnType<typeof createDb>) => h.pool },
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (cfg: Config) => new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: 3 }),
    },
    QueueService,
    StorageService,
    RealtimeEmitter,
    Analytics,
    Shutdown,
  ],
  exports: [CONFIG, DB, DB_POOL, REDIS, QueueService, StorageService, RealtimeEmitter, Analytics],
})
export class InfraModule {}
