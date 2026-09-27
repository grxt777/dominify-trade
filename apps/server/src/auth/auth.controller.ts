import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Patch, Post, Req } from '@nestjs/common';
import { staff, users, type Db } from '@dominify/db';
import { updateMeSchema, type UpdateMeDto } from '@dominify/shared';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { adminTelegramIds, type Config } from '../config';
import { AppError, ZodPipe } from '../common/http';
import { signJwt } from '../common/jwt';
import { Analytics } from '../infra/infra.module';
import { CONFIG, DB } from '../infra/tokens';
import { UsersService } from '../users/users.service';
import { CurrentUser, Public, RateLimit, type AuthUser } from './guards';
import { InitDataError, validateInitData, validateLoginWidget } from './init-data';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly analytics: Analytics,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Обмен initData (заголовок Authorization: tma <initData>) на JWT. */
  @Public()
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth', 60, 60)
  async telegram(@Req() req: Request) {
    const header = req.headers.authorization ?? '';
    const raw = header.startsWith('tma ') ? header.slice(4) : ((req.body as { initData?: string })?.initData ?? '');
    let valid;
    try {
      valid = validateInitData(raw, this.cfg.BOT_TOKEN, this.cfg.INIT_DATA_MAX_AGE_SEC);
    } catch (e) {
      throw new AppError('bad_init_data', e instanceof InitDataError ? e.message : 'Неверные данные Telegram', HttpStatus.UNAUTHORIZED);
    }
    if (await this.users.isBlacklisted('telegram_id', String(valid.user.id))) {
      throw new AppError('blocked', 'Доступ ограничен', HttpStatus.FORBIDDEN);
    }
    const user = await this.users.upsertFromTelegram(valid.user);
    this.analytics.track('auth.miniapp', user.id, { startParam: valid.startParam });
    return {
      token: signJwt({ sub: user.id, tg: user.telegramId, scope: 'user' }, this.cfg.JWT_SECRET, this.cfg.JWT_TTL_SEC),
      expiresIn: this.cfg.JWT_TTL_SEC,
      startParam: valid.startParam ?? null,
      me: await this.users.me(user.id),
    };
  }

  /** Вход в админку через Telegram Login Widget. Доступ только у пользователей из таблицы staff или ADMIN_TELEGRAM_IDS. */
  @Public()
  @Post('admin')
  @HttpCode(HttpStatus.OK)
  @RateLimit('auth-admin', 20, 60)
  async admin(@Body() body: Record<string, string | number>) {
    let tg;
    try {
      tg = validateLoginWidget(body, this.cfg.BOT_TOKEN, 86_400);
    } catch (e) {
      throw new AppError('bad_login', e instanceof InitDataError ? e.message : 'Неверные данные входа', HttpStatus.UNAUTHORIZED);
    }
    return this.issueAdmin(tg.id, tg);
  }

  /** Вход без Telegram для локальной разработки. Работает только при DEV_AUTH=1 и не в production. */
  @Public()
  @Post('dev')
  @HttpCode(HttpStatus.OK)
  async dev(@Body(new ZodPipe(z.object({ telegramId: z.number().int().positive(), firstName: z.string().optional(), admin: z.boolean().optional() }))) body: { telegramId: number; firstName?: string; admin?: boolean }) {
    if (!this.cfg.DEV_AUTH || this.cfg.NODE_ENV === 'production') throw new AppError('not_found', 'Не найдено', HttpStatus.NOT_FOUND);
    if (body.admin) return this.issueAdmin(body.telegramId, { id: body.telegramId, first_name: body.firstName ?? 'Admin' });
    const user = await this.users.upsertFromTelegram({ id: body.telegramId, first_name: body.firstName ?? 'Dev', language_code: 'ru' }, { botStarted: true });
    return {
      token: signJwt({ sub: user.id, tg: user.telegramId, scope: 'user' }, this.cfg.JWT_SECRET, this.cfg.JWT_TTL_SEC),
      expiresIn: this.cfg.JWT_TTL_SEC,
      startParam: null,
      me: await this.users.me(user.id),
    };
  }

  private async issueAdmin(telegramId: number, tg: { id: number; first_name?: string; last_name?: string; username?: string }) {
    const user = await this.users.upsertFromTelegram({ ...tg, id: telegramId });
    const [st] = await this.db.select().from(staff).where(eq(staff.userId, user.id));
    if (!st) {
      if (!adminTelegramIds(this.cfg).has(telegramId)) throw new AppError('forbidden', 'Нет доступа к админке', HttpStatus.FORBIDDEN);
      await this.db.insert(staff).values({ userId: user.id, role: 'admin' }).onConflictDoNothing();
    }
    await this.db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
    return {
      token: signJwt({ sub: user.id, tg: telegramId, scope: 'admin' }, this.cfg.JWT_SECRET, 12 * 3600),
      expiresIn: 12 * 3600,
      user: { id: user.id, firstName: user.firstName, role: st?.role ?? 'admin' },
    };
  }
}

@Controller('v1/me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  me(@CurrentUser() u: AuthUser) {
    return this.users.me(u.id);
  }

  @Patch()
  update(@CurrentUser() u: AuthUser, @Body(new ZodPipe(updateMeSchema)) dto: UpdateMeDto) {
    return this.users.update(u.id, dto);
  }

  /** Пользователь разрешил боту писать ему: теперь уведомления дойдут. */
  @Post('write-access')
  @HttpCode(HttpStatus.NO_CONTENT)
  async writeAccess(@CurrentUser() u: AuthUser) {
    await this.users.writeAccessGranted(u.id);
  }

  /** Согласие на обработку персональных данных при первом входе. */
  @Post('consent')
  @HttpCode(HttpStatus.NO_CONTENT)
  async consent(@CurrentUser() u: AuthUser) {
    await this.users.consent(u.id);
  }
}
