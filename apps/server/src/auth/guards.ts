import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { staff, users, type Db } from '@dominify/db';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import IORedis from 'ioredis';
import type { Config } from '../config';
import { AppError } from '../common/http';
import { verifyJwt } from '../common/jwt';
import { CONFIG, DB, REDIS } from '../infra/tokens';

export interface AuthUser {
  id: number;
  telegramId: number;
  lang: string;
  activeRole: string;
  activeCompanyId: number | null;
  staffRole: string | null;
}

export const PUBLIC = 'isPublic';
export const Public = () => SetMetadata(PUBLIC, true);

export const STAFF_ROLES_KEY = 'staffRoles';
/** Ручка только для команды платформы. */
export const Staff = (...roles: string[]) => SetMetadata(STAFF_ROLES_KEY, roles.length ? roles : ['admin', 'moderator', 'support']);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  return req.user!;
});

/** Глобальный guard: Bearer JWT, выданный после проверки initData. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? verifyJwt(token, this.cfg.JWT_SECRET) : null;
    if (!claims) throw new AppError('unauthorized', 'Нужно войти заново', HttpStatus.UNAUTHORIZED);

    const [row] = await this.db
      .select({
        id: users.id,
        telegramId: users.telegramId,
        lang: users.lang,
        activeRole: users.activeRole,
        activeCompanyId: users.activeCompanyId,
        staffRole: staff.role,
      })
      .from(users)
      .leftJoin(staff, eq(staff.userId, users.id))
      .where(eq(users.id, claims.sub));
    if (!row) throw new AppError('unauthorized', 'Пользователь не найден', HttpStatus.UNAUTHORIZED);

    const roles = this.reflector.getAllAndOverride<string[] | undefined>(STAFF_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles) {
      if (claims.scope !== 'admin' || !row.staffRole || !roles.includes(row.staffRole)) {
        throw new AppError('forbidden', 'Только для команды платформы', HttpStatus.FORBIDDEN);
      }
    }
    req.user = { ...row, staffRole: row.staffRole ?? null };
    return true;
  }
}

export const RATE_LIMIT = 'rateLimit';
/** Лимит запросов на пользователя: limit штук за windowSec секунд. */
export const RateLimit = (key: string, limit: number, windowSec: number) => SetMetadata(RATE_LIMIT, { key, limit, windowSec });

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: IORedis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const rule = this.reflector.get<{ key: string; limit: number; windowSec: number } | undefined>(RATE_LIMIT, ctx.getHandler());
    if (!rule) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const who = req.user?.id ?? req.ip;
    const bucket = Math.floor(Date.now() / 1000 / rule.windowSec);
    const k = `rl:${rule.key}:${who}:${bucket}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, rule.windowSec + 5);
    if (n > rule.limit) throw new AppError('rate_limited', 'Слишком много запросов, попробуйте позже', HttpStatus.TOO_MANY_REQUESTS);
    return true;
  }
}
