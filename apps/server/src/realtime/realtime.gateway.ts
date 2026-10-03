import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { memberships, users, type Db } from '@dominify/db';
import { createAdapter } from '@socket.io/redis-adapter';
import { eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import type { Config } from '../config';
import { verifyJwt } from '../common/jwt';
import { CONFIG, DB } from '../infra/tokens';
import { ChatService } from '../chat/chat';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestAccess } from '../requests/access';
import { UsersService } from '../users/users.service';

/**
 * WebSocket для Mini App. Авторизация тем же JWT. Комнаты user:<id> и company:<id> подключаются автоматически,
 * request:<id> и chat:<id> — по запросу клиента после проверки прав.
 * Redis-адаптер нужен, чтобы события из воркера и других реплик api доходили до сокета.
 */
@WebSocketGateway({ path: '/ws' })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private readonly log = new Logger('Realtime');
  private pub?: IORedis;
  private sub?: IORedis;

  constructor(
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DB) private readonly db: Db,
    private readonly access: RequestAccess,
    private readonly chat: ChatService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  afterInit(server: Server) {
    this.pub = new IORedis(this.cfg.REDIS_URL);
    this.sub = this.pub.duplicate();
    server.adapter(createAdapter(this.pub, this.sub));
    server.use((socket, next) => {
      const token = (socket.handshake.auth?.token as string | undefined) ?? '';
      const claims = verifyJwt(token, this.cfg.JWT_SECRET);
      if (!claims || claims.scope !== 'user') return next(new Error('unauthorized'));
      socket.data.userId = claims.sub;
      socket.data.exp = claims.exp;
      next();
    });
  }

  async handleConnection(socket: Socket) {
    const userId = socket.data.userId as number;
    const [u] = await this.db
      .select({ telegramId: users.telegramId, phoneHash: users.phoneHash, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!u || u.deletedAt || (await this.users.isUserBlocked(u))) {
      socket.disconnect(true);
      return;
    }
    // Сокет живёт не дольше токена: клиент получает 'unauthorized', обновляет токен и переподключается.
    const ttlMs = (socket.data.exp as number) * 1000 - Date.now();
    const timer = setTimeout(() => {
      socket.emit('unauthorized');
      socket.disconnect(true);
    }, Math.max(0, Math.min(ttlMs, 2_147_000_000)));
    socket.once('disconnect', () => clearTimeout(timer));
    await socket.join(`user:${userId}`);
    const comps = await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, userId));
    for (const c of comps) await socket.join(`company:${c.id}`);
    await this.notifications.markOnline(userId);
  }

  /** Клиент пингует раз в 30 секунд: пока он в сети, уведомления в бот не дублируются. */
  @SubscribeMessage('ping')
  async ping(@ConnectedSocket() socket: Socket) {
    await this.notifications.markOnline(socket.data.userId as number);
    return { ok: true };
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { room?: string }) {
    const userId = socket.data.userId as number;
    const m = /^(request|chat):(\d+)$/.exec(body?.room ?? '');
    if (!m) return { ok: false };
    const id = Number(m[2]);
    const allowed = m[1] === 'request' ? !!(await this.access.roleOf(userId, id)) : !!(await this.chat.sideOf(userId, id));
    if (!allowed) return { ok: false };
    await socket.join(body.room!);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: { room?: string }) {
    if (body?.room) await socket.leave(body.room);
    return { ok: true };
  }

  async onModuleDestroy() {
    await this.pub?.quit().catch(() => undefined);
    await this.sub?.quit().catch(() => undefined);
    this.log.log('Realtime остановлен');
  }
}
