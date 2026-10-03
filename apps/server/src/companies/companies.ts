import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import {
  companies,
  companyInvites,
  memberships,
  reviews,
  serviceAreas,
  subscriptions,
  supplierCategories,
  users,
  type Db,
} from '@dominify/db';
import {
  createCompanySchema,
  PLANS,
  updateCompanySchema,
  type CreateCompanyDto,
  type PlanCode,
  type UpdateCompanyDto,
} from '@dominify/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import { encrypt, lookupHash, randomToken } from '../common/crypto';
import { AppError, conflict, notFound, ZodPipe } from '../common/http';
import { CurrentUser, RateLimit, type AuthUser } from '../auth/guards';
import { CatalogService } from '../catalog/catalog';
import { Analytics } from '../infra/infra.module';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { CONFIG, DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly users: UsersService,
    private readonly catalog: CatalogService,
    private readonly analytics: Analytics,
    private readonly realtime: RealtimeEmitter,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: number, dto: CreateCompanyDto) {
    const [owned] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.role, 'owner')));
    if ((owned?.c ?? 0) >= this.cfg.MAX_COMPANIES_PER_USER) {
      throw new AppError('company_limit', `Можно владеть не более чем ${this.cfg.MAX_COMPANIES_PER_USER} компаниями. Если нужно больше, напишите в поддержку.`, HttpStatus.CONFLICT);
    }
    let innEnc: string | null = null;
    let innHash: string | null = null;
    if (dto.inn) {
      innHash = lookupHash(dto.inn, this.cfg.HASH_KEY);
      if (await this.users.isBlacklisted('inn_hash', innHash)) throw new AppError('blocked', 'ИНН заблокирован');
      const [dup] = await this.db.select({ id: companies.id }).from(companies).where(eq(companies.innHash, innHash));
      if (dup) throw conflict('inn_taken', 'Компания с таким ИНН уже есть. Попросите владельца добавить вас в команду.');
      innEnc = encrypt(dto.inn, this.cfg.ENCRYPTION_KEY);
    }
    await this.assertCategoryLimit(dto.categoryIds, 'free');

    const company = await this.db.transaction(async (tx) => {
      const [c] = await tx
        .insert(companies)
        .values({
          name: dto.name,
          type: dto.type,
          innEnc,
          innHash,
          regionCode: dto.regionCode,
          about: dto.about ?? null,
          isSupplier: dto.isSupplier,
          isBuyer: dto.isBuyer,
          deliversNationwide: dto.deliversNationwide,
        })
        .returning();
      await tx.insert(memberships).values({ userId, companyId: c.id, role: 'owner' });
      await tx.insert(subscriptions).values({ companyId: c.id, planCode: 'free', status: 'active' });
      if (dto.categoryIds.length) {
        await tx.insert(supplierCategories).values(dto.categoryIds.map((categoryId) => ({ companyId: c.id, categoryId }))).onConflictDoNothing();
      }
      const areas = dto.areas.length ? dto.areas : [{ regionCode: dto.regionCode }];
      await tx.insert(serviceAreas).values(areas.map((a) => ({ companyId: c.id, regionCode: a.regionCode }))).onConflictDoNothing();
      await tx
        .update(users)
        .set({ activeCompanyId: c.id, activeRole: dto.isSupplier ? 'supplier' : 'buyer' })
        .where(eq(users.id, userId));
      return c;
    });
    this.analytics.track('company.created', userId, { companyId: company.id, supplier: dto.isSupplier });
    return this.profile(company.id, true);
  }

  async update(userId: number, companyId: number, dto: UpdateCompanyDto) {
    // Реквизиты меняет только владелец; сотрудник может настраивать категории, районы и описание.
    if (dto.inn !== undefined || dto.name !== undefined || dto.type !== undefined) await this.users.assertOwner(userId, companyId);
    else await this.users.assertMember(userId, companyId);
    const plan = await this.planOf(companyId);
    if (dto.categoryIds) await this.assertCategoryLimit(dto.categoryIds, plan);
    await this.db.transaction(async (tx) => {
      const patch: Partial<typeof companies.$inferInsert> = {};
      if (dto.name !== undefined) patch.name = dto.name;
      if (dto.type !== undefined) patch.type = dto.type;
      if (dto.regionCode !== undefined) patch.regionCode = dto.regionCode;
      if (dto.about !== undefined) patch.about = dto.about;
      if (dto.isSupplier !== undefined) patch.isSupplier = dto.isSupplier;
      if (dto.isBuyer !== undefined) patch.isBuyer = dto.isBuyer;
      if (dto.deliversNationwide !== undefined) patch.deliversNationwide = dto.deliversNationwide;
      if (dto.inn) {
        const innHash = lookupHash(dto.inn, this.cfg.HASH_KEY);
        const [dup] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.innHash, innHash));
        if (dup && dup.id !== companyId) throw conflict('inn_taken', 'Компания с таким ИНН уже есть');
        if (!dup) {
          if (await this.users.isBlacklisted('inn_hash', innHash)) throw new AppError('blocked', 'ИНН заблокирован');
          patch.innHash = innHash;
          patch.innEnc = encrypt(dto.inn, this.cfg.ENCRYPTION_KEY);
          patch.innVerifiedAt = null;
          // Смена ИНН снимает проверку: значок доверия L1/L2 не должен переезжать на непроверенный ИНН.
          patch.trustLevel = sql`case when ${companies.trustLevel} >= 3 then ${companies.trustLevel} else 0 end` as unknown as number;
        }
      }
      if (Object.keys(patch).length) await tx.update(companies).set(patch).where(eq(companies.id, companyId));
      if (dto.categoryIds) {
        await tx.delete(supplierCategories).where(eq(supplierCategories.companyId, companyId));
        if (dto.categoryIds.length)
          await tx.insert(supplierCategories).values(dto.categoryIds.map((categoryId) => ({ companyId, categoryId })));
      }
      if (dto.areas) {
        await tx.delete(serviceAreas).where(eq(serviceAreas.companyId, companyId));
        if (dto.areas.length) await tx.insert(serviceAreas).values(dto.areas.map((a) => ({ companyId, regionCode: a.regionCode })));
      }
    });
    return this.profile(companyId, true);
  }

  // ── Команда ──

  async members(userId: number, companyId: number) {
    await this.users.assertMember(userId, companyId);
    const rows = await this.db
      .select({ userId: users.id, firstName: users.firstName, username: users.username, role: memberships.role, joinedAt: memberships.createdAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.companyId, companyId))
      .orderBy(memberships.createdAt);
    const plan = await this.planOf(companyId);
    return { seats: PLANS[plan].seats, members: rows };
  }

  /** Ссылка-приглашение: открывает Mini App с параметром join_<token>. Свободное место проверяется сразу и при входе. */
  async createInvite(userId: number, companyId: number) {
    await this.users.assertOwner(userId, companyId);
    await this.assertFreeSeat(companyId);
    const token = randomToken(18);
    const expiresAt = new Date(Date.now() + this.cfg.INVITE_TTL_HOURS * 3600_000);
    await this.db.insert(companyInvites).values({ companyId, token, createdByUserId: userId, expiresAt });
    return { token, expiresAt, url: `https://t.me/${this.cfg.BOT_USERNAME}/${this.cfg.MINIAPP_SHORT_NAME}?startapp=join_${token}` };
  }

  async joinByInvite(userId: number, token: string) {
    const companyId = await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(companyInvites).where(eq(companyInvites.token, token)).for('update');
      if (!inv || inv.usedAt || inv.expiresAt.getTime() < Date.now()) {
        throw new AppError('invite_invalid', 'Приглашение недействительно или уже использовано', HttpStatus.GONE);
      }
      const [already] = await tx.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.companyId, inv.companyId)));
      if (already) return inv.companyId;
      // Блокировка строки компании: два одновременных входа не займут одно последнее место.
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, inv.companyId)).for('update');
      await this.assertFreeSeat(inv.companyId, tx);
      await tx.insert(memberships).values({ userId, companyId: inv.companyId, role: inv.role });
      await tx.update(companyInvites).set({ usedAt: new Date(), usedByUserId: userId }).where(eq(companyInvites.id, inv.id));
      await tx.update(users).set({ activeCompanyId: inv.companyId, activeRole: 'supplier' }).where(eq(users.id, userId));
      return inv.companyId;
    });
    this.realtime.joinCompany(userId, companyId);
    const [joined] = await this.db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId));
    const owners = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner')));
    for (const o of owners) await this.notifications.notify(o.userId, 'team_joined', { name: joined?.firstName ?? '' });
    this.analytics.track('company.member_joined', userId, { companyId });
    return this.profile(companyId, true);
  }

  /** Владелец убирает сотрудника; сотрудник может уйти сам. Последнего владельца убрать нельзя. */
  async removeMember(userId: number, companyId: number, targetUserId: number) {
    const me = await this.users.assertMember(userId, companyId);
    if (targetUserId !== userId && me.role !== 'owner') throw new AppError('forbidden', 'Это может сделать только владелец компании', HttpStatus.FORBIDDEN);
    const [target] = await this.db.select().from(memberships).where(and(eq(memberships.userId, targetUserId), eq(memberships.companyId, companyId)));
    if (!target) throw notFound('Сотрудник');
    if (target.role === 'owner') {
      const [owners] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(memberships)
        .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner')));
      if ((owners?.c ?? 0) <= 1) throw new AppError('last_owner', 'Нельзя убрать единственного владельца компании');
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(memberships).where(and(eq(memberships.userId, targetUserId), eq(memberships.companyId, companyId)));
      await tx.update(users).set({ activeCompanyId: null, activeRole: 'buyer' }).where(and(eq(users.id, targetUserId), eq(users.activeCompanyId, companyId)));
    });
    this.realtime.leaveCompany(targetUserId, companyId);
    return { ok: true };
  }

  private async assertFreeSeat(companyId: number, tx: Pick<Db, 'select'> = this.db) {
    const plan = await this.planOf(companyId);
    const [m] = await tx.select({ c: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.companyId, companyId));
    if ((m?.c ?? 0) >= PLANS[plan].seats) {
      throw new AppError(
        'seat_limit',
        `На тарифе «${PLANS[plan].name.ru}» мест в команде: ${PLANS[plan].seats}. Чтобы добавить сотрудника, смените тариф.`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }

  async planOf(companyId: number): Promise<PlanCode> {
    const [s] = await this.db.select().from(subscriptions).where(eq(subscriptions.companyId, companyId));
    if (!s || s.status === 'expired') return 'free';
    return s.planCode as PlanCode;
  }

  private async assertCategoryLimit(ids: number[], plan: PlanCode) {
    const max = PLANS[plan].maxCategories;
    if (ids.length > max) throw new AppError('plan_limit', `На тарифе можно выбрать до ${max} категорий`);
    for (const id of ids) if (!(await this.catalog.byId(id))) throw new AppError('bad_category', `Категория ${id} не найдена`);
  }

  /** Публичный профиль: то, что видит покупатель при выборе исполнителя. own=true добавляет настройки. */
  async profile(companyId: number, own = false) {
    const [c] = await this.db.select().from(companies).where(eq(companies.id, companyId));
    if (!c) throw notFound('Компания');
    const cats = await this.db.select({ id: supplierCategories.categoryId }).from(supplierCategories).where(eq(supplierCategories.companyId, companyId));
    const areas = await this.db.select({ regionCode: serviceAreas.regionCode }).from(serviceAreas).where(eq(serviceAreas.companyId, companyId));
    const lastReviews = await this.db
      .select({ stars: reviews.stars, text: reviews.text, createdAt: reviews.createdAt })
      .from(reviews)
      .where(and(eq(reviews.targetCompanyId, companyId), eq(reviews.hidden, false)))
      .orderBy(desc(reviews.createdAt))
      .limit(20);
    const plan = await this.planOf(companyId);
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      regionCode: c.regionCode,
      about: c.about,
      isSupplier: c.isSupplier,
      isBuyer: c.isBuyer,
      deliversNationwide: c.deliversNationwide,
      trustLevel: c.trustLevel,
      innVerified: !!c.innVerifiedAt,
      ratingAvg: c.ratingAvg,
      ratingCount: c.ratingCount,
      dealsClosed: c.dealsClosed,
      medianResponseMin: c.medianResponseMin,
      createdAt: c.createdAt,
      categoryIds: cats.map((x) => x.id),
      areas: areas.map((a) => a.regionCode),
      reviews: lastReviews,
      ...(own ? { planCode: plan, hasInn: !!c.innHash } : {}),
    };
  }
}

@Controller('v1/companies')
export class CompaniesController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly users: UsersService,
  ) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(createCompanySchema)) dto: CreateCompanyDto) {
    return this.companies.create(u.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(updateCompanySchema)) dto: UpdateCompanyDto) {
    return this.companies.update(u.id, id, dto);
  }

  /** Вход в команду по ссылке-приглашению. Объявлен до ':id', чтобы 'join' не разбирался как ID. */
  @Post('join')
  @HttpCode(HttpStatus.OK)
  @RateLimit('join', 10, 3600)
  join(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ token: z.string().min(10).max(64) }))) b: { token: string }) {
    return this.companies.joinByInvite(u.id, b.token);
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const own = await this.users.assertMember(u.id, id).then(() => true).catch(() => false);
    return this.companies.profile(id, own);
  }

  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.companies.members(u.id, id);
  }

  @Post(':id/invites')
  @RateLimit('invite', 20, 3600)
  invite(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.companies.createInvite(u.id, id);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.OK)
  removeMember(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('userId', ParseIntPipe) userId: number) {
    return this.companies.removeMember(u.id, id, userId);
  }
}
