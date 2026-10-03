import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { companies, deals, favorites, files, gigs, gigViews, memberships, requests, reviews, supplierCategories, users, type Db } from '@dominify/db';
import { GIG_LIMITS, GIG_PACKAGE_CODES, gigUpsertSchema, type GigPackage, type GigPackageCode, type GigUpsertDto } from '@dominify/shared';
import { and, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { z } from 'zod';
import { maskContacts } from '../common/contacts';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, Public, RateLimit, type AuthUser } from '../auth/guards';
import { CatalogService } from '../catalog/catalog';
import { ChatService } from '../chat/chat';
import { FilesService } from '../files/files';
import { StorageService } from '../infra/storage';
import { DB } from '../infra/tokens';

const fileIdOf = (img: string) => (img.startsWith('f:') ? Number(img.slice(2)) : null);

const SORTS = ['recommended', 'rating', 'price'] as const;
type Sort = (typeof SORTS)[number];

const minPrice = (p: GigPackage[]) => (p.length ? Math.min(...p.map((x) => x.priceUzs)) : null);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Витрина исполнителей: каталог услуг и страница услуги. */
@Injectable()
export class GigsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly catalog: CatalogService,
    private readonly files: FilesService,
    private readonly storage: StorageService,
  ) {}

  async list(opts: { userId?: number; category?: string; q?: string; sort?: string; verified?: boolean; ids?: number[]; limit?: number }) {
    let catIds: number[] | null = null;
    if (opts.category) {
      const cat = await this.catalog.bySlug(opts.category);
      if (!cat) return [];
      catIds = await this.catalog.withDescendants(cat.id);
    }
    if (opts.ids && !opts.ids.length) return [];
    const q = opts.q?.trim().slice(0, 80);
    const sort: Sort = (SORTS as readonly string[]).includes(opts.sort ?? '') ? (opts.sort as Sort) : 'recommended';

    const rows = await this.db
      .select({
        id: gigs.id,
        title: gigs.title,
        cover: gigs.cover,
        packages: gigs.packages,
        ordersCount: gigs.ordersCount,
        categoryId: gigs.categoryId,
        favorite: opts.userId
          ? sql<boolean>`exists (select 1 from favorites f where f.user_id = ${opts.userId} and f.gig_id = ${gigs.id})`
          : sql<boolean>`false`,
        company: {
          id: companies.id,
          name: companies.name,
          trustLevel: companies.trustLevel,
          innVerified: sql<boolean>`${companies.innVerifiedAt} is not null`,
          ratingAvg: companies.ratingAvg,
          ratingCount: companies.ratingCount,
          dealsClosed: companies.dealsClosed,
          medianResponseMin: companies.medianResponseMin,
        },
      })
      .from(gigs)
      .innerJoin(companies, eq(companies.id, gigs.companyId))
      .where(
        and(
          eq(gigs.active, true),
          eq(companies.blocked, false),
          catIds ? inArray(gigs.categoryId, catIds) : undefined,
          opts.ids ? inArray(gigs.id, opts.ids) : undefined,
          opts.verified ? sql`${companies.innVerifiedAt} is not null` : undefined,
          q ? or(ilike(gigs.title, `%${escapeLike(q)}%`), ilike(companies.name, `%${escapeLike(q)}%`), sql`${gigs.tags}::text ilike ${`%${escapeLike(q)}%`}`) : undefined,
        ),
      )
      .limit(Math.min(opts.limit ?? 60, 100));

    const out = rows.map(({ packages, ...g }) => ({ ...g, fromPriceUzs: minPrice(packages), fastestDays: packages.length ? Math.min(...packages.map((p) => p.days)) : null }));
    if (opts.ids) {
      const order = new Map(opts.ids.map((id, i) => [id, i]));
      return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    }
    // «Рекомендуемые»: рейтинг с поправкой на число отзывов и закрытые сделки, чтобы 5.0 с одним отзывом не был первым.
    const score = (g: (typeof out)[number]) => ((g.company.ratingAvg ?? 0) * g.company.ratingCount + 4 * 10) / (g.company.ratingCount + 10) + Math.log10(1 + g.company.dealsClosed) * 0.1;
    if (sort === 'price') out.sort((a, b) => (a.fromPriceUzs ?? Infinity) - (b.fromPriceUzs ?? Infinity));
    else if (sort === 'rating') out.sort((a, b) => (b.company.ratingAvg ?? 0) - (a.company.ratingAvg ?? 0) || b.company.ratingCount - a.company.ratingCount);
    else out.sort((a, b) => score(b) - score(a));
    return out;
  }

  async setFavorite(userId: number, gigId: number, on: boolean) {
    if (on) {
      const [g] = await this.db.select({ id: gigs.id }).from(gigs).where(and(eq(gigs.id, gigId), eq(gigs.active, true)));
      if (!g) throw notFound('Услуга');
      const [{ c }] = await this.db.select({ c: sql<number>`count(*)::int` }).from(favorites).where(eq(favorites.userId, userId));
      if (c >= 200) throw new AppError('favorites_limit', 'В избранном уже 200 услуг');
      await this.db.insert(favorites).values({ userId, gigId }).onConflictDoNothing();
    } else {
      await this.db.delete(favorites).where(and(eq(favorites.userId, userId), eq(favorites.gigId, gigId)));
    }
    return { gigId, favorite: on };
  }

  async favoritesOf(userId: number) {
    const rows = await this.db.select({ id: favorites.gigId }).from(favorites).where(eq(favorites.userId, userId)).orderBy(desc(favorites.createdAt)).limit(100);
    return this.list({ userId, ids: rows.map((r) => r.id) });
  }

  async recentOf(userId: number) {
    const rows = await this.db.select({ id: gigViews.gigId }).from(gigViews).where(eq(gigViews.userId, userId)).orderBy(desc(gigViews.viewedAt)).limit(12);
    return this.list({ userId, ids: rows.map((r) => r.id) });
  }

  private statsCache: { at: number; data: { dealsCompleted: number; suppliers: number; ordersToday: number; avgRating: number | null } } | null = null;

  /** Живые цифры для главной: сколько сделок закрыто, сколько исполнителей, сколько заказов за сутки. */
  async stats() {
    if (this.statsCache && Date.now() - this.statsCache.at < 5 * 60_000) return this.statsCache.data;
    const r = await this.db.execute<{ deals: number; suppliers: number; today: number; rating: number | null }>(sql`
      select
        (select coalesce(sum(deals_closed), 0)::int from companies where is_supplier and not blocked) as deals,
        (select count(*)::int from companies c where is_supplier and not blocked and exists (select 1 from gigs g where g.company_id = c.id and g.active)) as suppliers,
        (select count(*)::int from requests where submitted_at > now() - interval '24 hours') as today,
        (select round(avg(rating_avg)::numeric, 1)::float from companies where is_supplier and not blocked and rating_count > 0) as rating`);
    const row = r.rows[0];
    const data = { dealsCompleted: Number(row?.deals ?? 0), suppliers: Number(row?.suppliers ?? 0), ordersToday: Number(row?.today ?? 0), avgRating: row?.rating ?? null };
    this.statsCache = { at: Date.now(), data };
    return data;
  }

  async view(id: number, userId?: number) {
    const [g] = await this.db
      .select()
      .from(gigs)
      .innerJoin(companies, eq(companies.id, gigs.companyId))
      .where(and(eq(gigs.id, id), eq(gigs.active, true), eq(companies.blocked, false)));
    if (!g) throw notFound('Услуга');
    const c = g.companies;
    const cat = g.gigs.categoryId ? await this.catalog.byId(g.gigs.categoryId) : undefined;
    const [owner] = await this.db
      .select({ firstName: users.firstName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, c.id), eq(memberships.role, 'owner')))
      .limit(1);
    const lastReviews = await this.db
      .select({ id: reviews.id, stars: reviews.stars, text: reviews.text, createdAt: reviews.createdAt, author: users.firstName, amountUzs: deals.amountUzs })
      .from(reviews)
      .innerJoin(users, eq(users.id, reviews.authorUserId))
      .innerJoin(deals, eq(deals.id, reviews.dealId))
      .where(and(eq(reviews.targetCompanyId, c.id), eq(reviews.hidden, false), eq(reviews.counted, true)))
      .orderBy(desc(reviews.createdAt))
      .limit(10);
    const more = await this.db
      .select({ id: gigs.id, title: gigs.title, cover: gigs.cover, packages: gigs.packages })
      .from(gigs)
      .where(and(eq(gigs.companyId, c.id), eq(gigs.active, true), ne(gigs.id, id)))
      .limit(6);
    const [last] = await this.db
      .select({ at: sql<string | null>`max(${requests.submittedAt})` })
      .from(requests)
      .where(eq(requests.gigId, id));
    let favorite = false;
    let mine = false;
    if (userId) {
      const [m] = await this.db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.companyId, c.id)));
      mine = !!m;
      if (!mine) {
        await this.db
          .insert(gigViews)
          .values({ userId, gigId: id })
          .onConflictDoUpdate({ target: [gigViews.userId, gigViews.gigId], set: { viewedAt: new Date() } });
      }
      const [f] = await this.db.select({ id: favorites.gigId }).from(favorites).where(and(eq(favorites.userId, userId), eq(favorites.gigId, id)));
      favorite = !!f;
    }

    return {
      favorite,
      mine,
      lastOrderAt: last?.at ? new Date(last.at) : null,
      id: g.gigs.id,
      title: g.gigs.title,
      description: g.gigs.description,
      cover: g.gigs.cover,
      gallery: g.gigs.gallery.length ? g.gigs.gallery : g.gigs.cover ? [g.gigs.cover] : [],
      packages: g.gigs.packages,
      tags: g.gigs.tags,
      ordersCount: g.gigs.ordersCount,
      category: cat ? { id: cat.id, slug: cat.slug, name: cat.name } : null,
      company: {
        id: c.id,
        name: c.name,
        about: c.about,
        owner: owner?.firstName ?? null,
        regionCode: c.regionCode,
        trustLevel: c.trustLevel,
        innVerified: !!c.innVerifiedAt,
        ratingAvg: c.ratingAvg,
        ratingCount: c.ratingCount,
        dealsClosed: c.dealsClosed,
        medianResponseMin: c.medianResponseMin,
        createdAt: c.createdAt,
      },
      reviews: lastReviews,
      more: more.map(({ packages, ...m }) => ({ ...m, fromPriceUzs: minPrice(packages) })),
    };
  }

  /** Пакет для заказа: услуга активна и пакет существует. */
  async packageFor(gigId: number, code: GigPackageCode | undefined) {
    const [g] = await this.db
      .select({ id: gigs.id, companyId: gigs.companyId, categoryId: gigs.categoryId, title: gigs.title, packages: gigs.packages })
      .from(gigs)
      .innerJoin(companies, eq(companies.id, gigs.companyId))
      .where(and(eq(gigs.id, gigId), eq(gigs.active, true), eq(companies.blocked, false), eq(companies.isSupplier, true)));
    if (!g) throw notFound('Услуга');
    const pkg = g.packages.find((p) => p.code === code) ?? g.packages[0] ?? null;
    return { gig: g, pkg };
  }

  /* ───────── Кабинет продавца ───────── */

  private async assertMember(userId: number, companyId: number) {
    const [m] = await this.db
      .select({ isSupplier: companies.isSupplier, blocked: companies.blocked })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)));
    if (!m) throw forbidden('Вы не состоите в этой компании');
    if (!m.isSupplier) throw new AppError('not_supplier', 'Сначала включите в профиле компании роль исполнителя', HttpStatus.FORBIDDEN);
    if (m.blocked) throw forbidden('Компания заблокирована');
  }

  private async ownGig(userId: number, id: number) {
    const [g] = await this.db.select().from(gigs).where(eq(gigs.id, id));
    if (!g) throw notFound('Услуга');
    await this.assertMember(userId, g.companyId);
    return g;
  }

  async mine(userId: number, companyId: number) {
    await this.assertMember(userId, companyId);
    const rows = await this.db.select().from(gigs).where(eq(gigs.companyId, companyId)).orderBy(desc(gigs.updatedAt));
    return rows.map((g) => ({
      id: g.id,
      title: g.title,
      cover: g.cover,
      active: g.active,
      ordersCount: g.ordersCount,
      categoryId: g.categoryId,
      fromPriceUzs: minPrice(g.packages),
      packagesCount: g.packages.length,
      updatedAt: g.updatedAt,
    }));
  }

  async editable(userId: number, id: number) {
    const g = await this.ownGig(userId, id);
    return {
      id: g.id,
      companyId: g.companyId,
      categoryId: g.categoryId,
      title: g.title,
      description: g.description,
      gallery: g.gallery,
      packages: g.packages,
      tags: g.tags,
      active: g.active,
    };
  }

  /**
   * Проверки, которых нет в схеме: категория из профиля компании, свои картинки,
   * и никаких телефонов и ссылок — иначе сделка уходит мимо площадки и отзывов.
   */
  private async validate(userId: number, dto: GigUpsertDto, prevGallery: string[] = []) {
    const cat = await this.catalog.byId(dto.categoryId);
    const all = await this.catalog.all();
    if (!cat || all.some((c) => c.parentId === cat.id)) throw new AppError('bad_category', 'Выберите конкретную категорию услуги');
    const root = await this.catalog.rootOf(cat.id);
    const [inProfile] = await this.db
      .select({ id: supplierCategories.categoryId })
      .from(supplierCategories)
      .where(and(eq(supplierCategories.companyId, dto.companyId), inArray(supplierCategories.categoryId, [cat.id, root])))
      .limit(1);
    if (!inProfile) throw new AppError('category_not_in_profile', 'Эта категория не указана в профиле компании. Добавьте её в профиле.');

    const texts = [dto.title, dto.description, ...dto.tags, ...dto.packages.flatMap((p) => [p.name, p.summary, ...p.features])];
    if (texts.some((s) => maskContacts(s).masked)) {
      throw new AppError('contacts_in_gig', 'Уберите телефоны, ссылки и @username: контакты откроются покупателю после выбора исполнителя');
    }

    const fresh = dto.gallery
      .filter((img) => !prevGallery.includes(img))
      .map(fileIdOf)
      .filter((x): x is number => x !== null);
    await this.files.assertOwnReady(userId, fresh);
    if (fresh.length) {
      const rows = await this.db.select({ mime: files.mime }).from(files).where(inArray(files.id, fresh));
      if (rows.some((r) => !r.mime.startsWith('image/'))) throw new AppError('not_image', 'В галерею можно добавить только картинки');
    }
  }

  private normalize(dto: GigUpsertDto) {
    const packages = [...dto.packages]
      .sort((a, b) => GIG_PACKAGE_CODES.indexOf(a.code) - GIG_PACKAGE_CODES.indexOf(b.code))
      .map((p) => ({ ...p, summary: p.summary ?? '', features: p.features ?? [] }));
    return {
      categoryId: dto.categoryId,
      title: dto.title,
      description: dto.description,
      cover: dto.gallery[0],
      gallery: dto.gallery,
      packages,
      tags: [...new Set(dto.tags.map((t) => t.toLowerCase()))],
      active: dto.active,
    };
  }

  async create(userId: number, dto: GigUpsertDto) {
    await this.assertMember(userId, dto.companyId);
    const [{ c }] = await this.db.select({ c: sql<number>`count(*)::int` }).from(gigs).where(eq(gigs.companyId, dto.companyId));
    if (c >= GIG_LIMITS.perCompany) throw new AppError('gig_limit', `У компании уже ${GIG_LIMITS.perCompany} услуг — удалите или объедините старые`, HttpStatus.CONFLICT);
    await this.validate(userId, dto);
    const [row] = await this.db
      .insert(gigs)
      .values({ companyId: dto.companyId, ...this.normalize(dto) })
      .returning({ id: gigs.id });
    return this.editable(userId, row.id);
  }

  async update(userId: number, id: number, dto: GigUpsertDto) {
    const g = await this.ownGig(userId, id);
    if (dto.companyId !== g.companyId) throw new AppError('bad_company', 'Услугу нельзя перенести в другую компанию');
    await this.validate(userId, dto, g.gallery);
    await this.db
      .update(gigs)
      .set({ ...this.normalize(dto), updatedAt: new Date() })
      .where(eq(gigs.id, id));
    return this.editable(userId, id);
  }

  async setActive(userId: number, id: number, active: boolean) {
    await this.ownGig(userId, id);
    await this.db.update(gigs).set({ active, updatedAt: new Date() }).where(eq(gigs.id, id));
    return { id, active };
  }

  async remove(userId: number, id: number) {
    await this.ownGig(userId, id);
    await this.db.delete(gigs).where(eq(gigs.id, id));
  }

  /** Картинки услуг публичны, но только те, что стоят в галерее какой-нибудь услуги. */
  async imageUrl(fileId: number): Promise<string | null> {
    const [used] = await this.db
      .select({ id: gigs.id })
      .from(gigs)
      .where(sql`${gigs.gallery} @> ${JSON.stringify([`f:${fileId}`])}::jsonb`)
      .limit(1);
    if (!used) return null;
    const [f] = await this.db.select({ key: files.key, mime: files.mime, status: files.status }).from(files).where(eq(files.id, fileId));
    if (!f || f.status !== 'ready' || !f.mime.startsWith('image/')) return null;
    return this.storage.downloadUrl(f.key, 3600);
  }
}

const activeSchema = z.object({ active: z.boolean() });

@Controller('v1/gigs')
export class GigsController {
  constructor(
    private readonly gigs: GigsService,
    private readonly chat: ChatService,
  ) {}

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('verified') verified?: string,
  ) {
    return this.gigs.list({ userId: u.id, category, q, sort, verified: verified === '1' });
  }

  @Get('stats')
  stats() {
    return this.gigs.stats();
  }

  @Get('favorites')
  favorites(@CurrentUser() u: AuthUser) {
    return this.gigs.favoritesOf(u.id);
  }

  @Get('recent')
  recent(@CurrentUser() u: AuthUser) {
    return this.gigs.recentOf(u.id);
  }

  @Post(':id/favorite')
  @HttpCode(HttpStatus.OK)
  @RateLimit('gig_fav', 300, 3600)
  favorite(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(z.object({ on: z.boolean() }))) b: { on: boolean }) {
    return this.gigs.setFavorite(u.id, id, b.on);
  }

  /** Вопрос исполнителю до заказа: чат без заявки, контакты в нём скрыты. */
  @Post(':id/ask')
  @HttpCode(HttpStatus.OK)
  @RateLimit('gig_ask', 30, 3600)
  ask(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.chat.askAboutGig(u.id, id);
  }

  @Public()
  @Get('image/:fileId')
  async image(@Param('fileId', ParseIntPipe) fileId: number, @Res() res: Response) {
    const url = await this.gigs.imageUrl(fileId);
    if (!url) throw notFound('Картинка');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.redirect(302, url);
  }

  @Get('mine')
  mine(@CurrentUser() u: AuthUser, @Query('companyId', ParseIntPipe) companyId: number) {
    return this.gigs.mine(u.id, companyId);
  }

  @Post()
  @RateLimit('gig_write', 60, 3600)
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(gigUpsertSchema)) dto: GigUpsertDto) {
    return this.gigs.create(u.id, dto);
  }

  @Get(':id/edit')
  editable(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.gigs.editable(u.id, id);
  }

  @Patch(':id')
  @RateLimit('gig_write', 60, 3600)
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(gigUpsertSchema)) dto: GigUpsertDto) {
    return this.gigs.update(u.id, id, dto);
  }

  @Post(':id/active')
  @HttpCode(HttpStatus.OK)
  setActive(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(activeSchema)) dto: { active: boolean }) {
    return this.gigs.setActive(u.id, id, dto.active);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.gigs.remove(u.id, id);
  }

  @Get(':id')
  view(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.gigs.view(id, u.id);
  }
}
