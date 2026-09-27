import { Inject, Injectable } from '@nestjs/common';
import { blacklist, companies, memberships, staff, subscriptions, users, type Db } from '@dominify/db';
import { pickLang, PLANS, type PlanCode, type UpdateMeDto } from '@dominify/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { decrypt, encrypt, lookupHash, maskPhone, normalizePhone } from '../common/crypto';
import { forbidden, notFound } from '../common/http';
import { CONFIG, DB } from '../infra/tokens';
import type { TelegramUser } from '../auth/init-data';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  /** Найти или создать пользователя по Telegram ID; имя и username обновляются при каждом входе. */
  async upsertFromTelegram(tg: TelegramUser, opts: { botStarted?: boolean } = {}) {
    // Разрешение писать в личку из initData равносильно нажатому «Старт»: бот сможет присылать уведомления.
    if (tg.allows_write_to_pm) opts = { ...opts, botStarted: true };
    const [row] = await this.db
      .insert(users)
      .values({
        telegramId: tg.id,
        firstName: tg.first_name ?? null,
        lastName: tg.last_name ?? null,
        username: tg.username ?? null,
        lang: pickLang(tg.language_code),
        botStarted: opts.botStarted ?? false,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.telegramId,
        set: {
          firstName: tg.first_name ?? null,
          lastName: tg.last_name ?? null,
          username: tg.username ?? null,
          lastSeenAt: new Date(),
          ...(opts.botStarted ? { botStarted: true, botBlocked: false } : {}),
        },
      })
      .returning();
    return row;
  }

  async byId(id: number) {
    const [u] = await this.db.select().from(users).where(eq(users.id, id));
    if (!u) throw notFound('Пользователь');
    return u;
  }

  async byTelegramId(tgId: number) {
    const [u] = await this.db.select().from(users).where(eq(users.telegramId, tgId));
    return u ?? null;
  }

  async isBlacklisted(kind: 'telegram_id' | 'phone_hash' | 'inn_hash', value: string): Promise<boolean> {
    const [r] = await this.db
      .select({ id: blacklist.id })
      .from(blacklist)
      .where(and(eq(blacklist.kind, kind), eq(blacklist.value, value)));
    return !!r;
  }

  /** Профиль для Mini App: пользователь, его компании с тарифами и роль в команде платформы. */
  async me(userId: number) {
    const u = await this.byId(userId);
    const comps = await this.db
      .select({
        id: companies.id,
        name: companies.name,
        type: companies.type,
        isSupplier: companies.isSupplier,
        isBuyer: companies.isBuyer,
        regionCode: companies.regionCode,
        trustLevel: companies.trustLevel,
        ratingAvg: companies.ratingAvg,
        ratingCount: companies.ratingCount,
        dealsClosed: companies.dealsClosed,
        role: memberships.role,
        planCode: subscriptions.planCode,
        planStatus: subscriptions.status,
        periodEnd: subscriptions.periodEnd,
      })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .leftJoin(subscriptions, eq(subscriptions.companyId, companies.id))
      .where(eq(memberships.userId, userId));
    const [st] = await this.db.select().from(staff).where(eq(staff.userId, userId));
    return {
      id: u.id,
      telegramId: u.telegramId,
      firstName: u.firstName,
      lastName: u.lastName,
      username: u.username,
      lang: u.lang,
      activeRole: u.activeRole,
      activeCompanyId: u.activeCompanyId,
      phone: u.phoneEnc ? maskPhone(decrypt(u.phoneEnc, this.cfg.ENCRYPTION_KEY)) : null,
      phoneVerified: !!u.phoneVerifiedAt,
      consent: !!u.consentAt,
      botStarted: u.botStarted,
      staffRole: st?.role ?? null,
      companies: comps.map((c) => ({
        ...c,
        planCode: (c.planCode ?? 'free') as PlanCode,
        planName: PLANS[(c.planCode ?? 'free') as PlanCode].name,
      })),
    };
  }

  async update(userId: number, dto: UpdateMeDto) {
    if (dto.activeCompanyId) await this.assertMember(userId, dto.activeCompanyId);
    await this.db
      .update(users)
      .set({
        ...(dto.lang ? { lang: dto.lang } : {}),
        ...(dto.activeRole ? { activeRole: dto.activeRole } : {}),
        ...(dto.activeCompanyId !== undefined ? { activeCompanyId: dto.activeCompanyId } : {}),
      })
      .where(eq(users.id, userId));
    return this.me(userId);
  }

  /** Mini App получил разрешение писать пользователю (WebApp.requestWriteAccess). */
  async writeAccessGranted(userId: number) {
    await this.db.update(users).set({ botStarted: true, botBlocked: false }).where(eq(users.id, userId));
  }

  async consent(userId: number) {
    await this.db.update(users).set({ consentAt: sql`coalesce(${users.consentAt}, now())` }).where(eq(users.id, userId));
  }

  /**
   * Телефон из системного запроса контакта. Бот вызывает это, только если contact.user_id совпал с отправителем,
   * то есть человек поделился своим номером. Это уровень доверия L0.
   */
  async setVerifiedPhone(userId: number, rawPhone: string) {
    const phone = normalizePhone(rawPhone);
    const hash = lookupHash(phone, this.cfg.HASH_KEY);
    if (await this.isBlacklisted('phone_hash', hash)) throw forbidden('Номер заблокирован');
    await this.db
      .update(users)
      .set({ phoneEnc: encrypt(phone, this.cfg.ENCRYPTION_KEY), phoneHash: hash, phoneVerifiedAt: new Date() })
      .where(eq(users.id, userId));
  }

  phoneOf(u: { phoneEnc: string | null }): string | null {
    return u.phoneEnc ? decrypt(u.phoneEnc, this.cfg.ENCRYPTION_KEY) : null;
  }

  async assertMember(userId: number, companyId: number) {
    const [m] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)));
    if (!m) throw forbidden('Вы не состоите в этой компании');
    return m;
  }

  /** ID всех пользователей компании, которым шлём уведомления. */
  async companyUserIds(companyId: number): Promise<number[]> {
    const rows = await this.db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.companyId, companyId));
    return rows.map((r) => r.userId);
  }
}
