import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import IORedis from 'ioredis';
import type { Config } from '../config';
import { CONFIG } from './tokens';

/**
 * Отправка событий в сокеты из любого процесса (api, воркер, бот).
 * Сокеты живут в api с Redis-адаптером; эмиттер публикует в тот же канал Redis.
 */
@Injectable()
export class RealtimeEmitter implements OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly emitter: Emitter;

  constructor(@Inject(CONFIG) cfg: Config) {
    this.redis = new IORedis(cfg.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.emitter = new Emitter(this.redis);
  }

  toUser(userId: number, event: string, data: unknown) {
    this.emitter.to(`user:${userId}`).emit(event, data);
  }

  toRequest(requestId: number, event: string, data: unknown) {
    this.emitter.to(`request:${requestId}`).emit(event, data);
  }

  toChat(chatId: number, event: string, data: unknown) {
    this.emitter.to(`chat:${chatId}`).emit(event, data);
  }

  toCompany(companyId: number, event: string, data: unknown) {
    this.emitter.to(`company:${companyId}`).emit(event, data);
  }

  /** Сокеты пользователя подписываются на события компании сразу, без переподключения. */
  joinCompany(userId: number, companyId: number) {
    this.emitter.in(`user:${userId}`).socketsJoin(`company:${companyId}`);
  }

  /** Убранный из команды сотрудник перестаёт получать события компании сразу, а не после переподключения. */
  leaveCompany(userId: number, companyId: number) {
    this.emitter.in(`user:${userId}`).socketsLeave(`company:${companyId}`);
  }

  disconnectUser(userId: number) {
    this.emitter.in(`user:${userId}`).disconnectSockets(true);
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
