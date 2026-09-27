import { Controller, Get, Inject } from '@nestjs/common';
import IORedis from 'ioredis';
import type { Pool } from 'pg';
import { Public } from './auth/guards';
import { DB_POOL, REDIS } from './infra/tokens';

/** Healthcheck для Railway: база и Redis отвечают. */
@Controller()
export class HealthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    await this.pool.query('select 1');
    await this.redis.ping();
    return { ok: true, ms: Date.now() - started, version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev' };
  }
}
