import { Body, Controller, Get, Inject, Injectable, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import {
  companies,
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
import { and, desc, eq } from 'drizzle-orm';
import type { Config } from '../config';
import { encrypt, lookupHash } from '../common/crypto';
import { AppError, conflict, notFound, ZodPipe } from '../common/http';
import { CurrentUser, type AuthUser } from '../auth/guards';
import { CatalogService } from '../catalog/catalog';
import { Analytics } from '../infra/infra.module';
import { CONFIG, DB } from '../infra/tokens';
import { UsersService } from '../users/users.service';

@Injectable()
export class CompaniesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly users: UsersService,
    private readonly catalog: CatalogService,
    private readonly analytics: Analytics,
  ) {}

  async create(userId: number, dto: CreateCompanyDto) {
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
    await this.users.assertMember(userId, companyId);
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
        patch.innHash = innHash;
        patch.innEnc = encrypt(dto.inn, this.cfg.ENCRYPTION_KEY);
        patch.innVerifiedAt = null;
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

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const own = await this.users.assertMember(u.id, id).then(() => true).catch(() => false);
    return this.companies.profile(id, own);
  }
}
