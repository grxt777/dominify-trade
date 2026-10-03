import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { blacklist, companies, deals, memberships, requests, staff, subscriptions, users, type Db } from '@dominify/db';
import { OPEN_REQUEST_STATUSES, pickLang, PLANS, type PlanCode, type UpdateMeDto } from '@dominify/shared';
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Config } from '../config';
import { decrypt, encrypt, lookupHash, maskPhone, normalizePhone } from '../common/crypto';
import { AppError, forbidden, notFound } from '../common/http';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { CONFIG, DB } from '../infra/tokens';
import type { TelegramUser } from '../auth/init-data';

/** Код приглашения в ссылке t.me/...?startapp=ref_xxx. */
export const referralCode = (userId: number) => `ref_${userId.toString(36)}`;
export function parseReferralCode(code: string): number | null {
  const m = /^ref_([0-9a-z]{1,10})$/.exec(code.trim());
  if (!m) return null;
  const id = parseInt(m[1], 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: Config,
    private readonly realtime: RealtimeEmitter,
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

  /** Заблокирован ли человек по Telegram ID или по подтверждённому номеру. */
  async isUserBlocked(u: { telegramId: number; phoneHash: string | null }): Promise<boolean> {
    const [r] = await this.db
      .select({ id: blacklist.id })
      .from(blacklist)
      .where(
        or(
          and(eq(blacklist.kind, 'telegram_id'), eq(blacklist.value, String(u.telegramId))),
          u.phoneHash ? and(eq(blacklist.kind, 'phone_hash'), eq(blacklist.value, u.phoneHash)) : sql`false`,
        ),
      )
      .limit(1);
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
    const ref = await this.db.execute<{ invited: number; rewarded: number }>(sql`
      select count(*)::int as invited, count(referral_rewarded_at)::int as rewarded
      from users where referred_by_user_id = ${userId}`);
    const usedFirst = await this.db.execute(sql`
      select 1 from invoices i
      join deals d on d.id = i.deal_id
      join users bu on bu.id = d.buyer_user_id
      where i.kind = 'deal' and i.status <> 'cancelled'
        and (d.buyer_user_id = ${userId} ${u.phoneHash ? sql`or bu.phone_hash = ${u.phoneHash}` : sql``})
      limit 1`);
    const code = referralCode(u.id);
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
      bonusUzs: u.bonusUzs,
      referral: {
        code,
        link: `https://t.me/${this.cfg.BOT_USERNAME}/${this.cfg.MINIAPP_SHORT_NAME}?startapp=${code}`,
        bonusUzs: this.cfg.REFERRAL_BONUS_UZS,
        invited: Number(ref.rows[0]?.invited ?? 0),
        rewarded: Number(ref.rows[0]?.rewarded ?? 0),
      },
      firstOrder:
        this.cfg.FIRST_ORDER_DISCOUNT_PERCENT > 0 && usedFirst.rows.length === 0
          ? { percent: this.cfg.FIRST_ORDER_DISCOUNT_PERCENT, maxUzs: this.cfg.FIRST_ORDER_DISCOUNT_MAX_UZS }
          : null,
      companies: comps.map((c) => {
        const planCode = (c.planStatus === 'expired' || !c.planCode ? 'free' : c.planCode) as PlanCode;
        return { ...c, planCode, planName: PLANS[planCode].name };
      }),
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

  /**
   * Пригласительная ссылка друга. Засчитывается только новому аккаунту (до первой сделки, не старше недели),
   * не себе и не человеку с тем же номером телефона, что у пригласившего.
   */
  async attributeReferral(userId: number, rawCode: string): Promise<boolean> {
    const referrerId = parseReferralCode(rawCode);
    if (!referrerId || referrerId === userId) return false;
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    const [ref] = await this.db.select().from(users).where(eq(users.id, referrerId));
    if (!u || !ref || ref.deletedAt || u.referredByUserId) return false;
    if (Date.now() - u.createdAt.getTime() > 7 * 86_400_000) return false;
    if (u.phoneHash && ref.phoneHash && u.phoneHash === ref.phoneHash) return false;
    const [hasDeal] = await this.db.select({ id: deals.id }).from(deals).where(eq(deals.buyerUserId, userId)).limit(1);
    if (hasDeal) return false;
    const r = await this.db
      .update(users)
      .set({ referredByUserId: referrerId })
      .where(and(eq(users.id, userId), isNull(users.referredByUserId)))
      .returning({ id: users.id });
    return r.length > 0;
  }

  /** Начислить бонус пригласившему за первый оплаченный заказ друга. Один раз на приглашённого. */
  async rewardReferrer(userId: number, bonusUzs: number) {
    if (bonusUzs <= 0) return null;
    return this.db.transaction(async (tx) => {
      const [u] = await tx
        .update(users)
        .set({ referralRewardedAt: new Date() })
        .where(and(eq(users.id, userId), isNotNull(users.referredByUserId), isNull(users.referralRewardedAt)))
        .returning();
      if (!u?.referredByUserId) return null;
      const [ref] = await tx.select({ phoneHash: users.phoneHash }).from(users).where(eq(users.id, u.referredByUserId));
      if (u.phoneHash && ref?.phoneHash === u.phoneHash) return null;
      await tx.update(users).set({ bonusUzs: sql`${users.bonusUzs} + ${bonusUzs}` }).where(eq(users.id, u.referredByUserId));
      return { referrerUserId: u.referredByUserId, friendName: u.firstName };
    });
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

  async assertOwner(userId: number, companyId: number) {
    const m = await this.assertMember(userId, companyId);
    if (m.role !== 'owner') throw forbidden('Это может сделать только владелец компании');
    return m;
  }

  /** ID всех пользователей компании, которым шлём уведомления. */
  async companyUserIds(companyId: number): Promise<number[]> {
    const rows = await this.db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.companyId, companyId));
    return rows.map((r) => r.userId);
  }

  /**
   * Удаление аккаунта по просьбе пользователя (право на удаление персональных данных).
   * Имя, username и телефон стираются, telegram_id освобождается: при следующем входе это новый аккаунт.
   * Заявки и сделки остаются обезличенными — без них рушатся рейтинги и отчётность других компаний.
   */
  async deleteAccount(userId: number) {
    const myCompanies = (await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, userId))).map((m) => m.id);
    const [active] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          // Пока платформа держит деньги по сделке, получатель выплаты или возврата должен оставаться на связи.
          or(inArray(deals.status, ['active', 'disputed']), inArray(deals.paymentStatus, ['held', 'payout_due', 'refund_due'])),
          or(eq(deals.buyerUserId, userId), myCompanies.length ? inArray(deals.supplierCompanyId, myCompanies) : sql`false`),
        ),
      )
      .limit(1);
    if (active) {
      throw new AppError('active_deals', 'Сначала завершите или отмените активные сделки', HttpStatus.CONFLICT);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(requests)
        .set({ status: 'cancelled', closedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(requests.authorUserId, userId), inArray(requests.status, [...OPEN_REQUEST_STATUSES, 'draft', 'needs_info', 'moderation'])));

      for (const companyId of myCompanies) {
        const [mine] = await tx.select().from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)));
        await tx.delete(memberships).where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)));
        const rest = await tx.select().from(memberships).where(eq(memberships.companyId, companyId)).orderBy(memberships.createdAt);
        if (!rest.length) {
          // Компания без людей не должна получать заявки.
          await tx.update(companies).set({ isSupplier: false }).where(eq(companies.id, companyId));
        } else if (mine?.role === 'owner' && !rest.some((m) => m.role === 'owner')) {
          await tx
            .update(memberships)
            .set({ role: 'owner' })
            .where(and(eq(memberships.userId, rest[0].userId), eq(memberships.companyId, companyId)));
        }
      }

      await tx.delete(staff).where(eq(staff.userId, userId));
      await tx
        .update(users)
        .set({
          telegramId: -userId,
          firstName: null,
          lastName: null,
          username: null,
          phoneEnc: null,
          phoneHash: null,
          phoneVerifiedAt: null,
          activeCompanyId: null,
          activeRole: 'buyer',
          botStarted: false,
          deletedAt: new Date(),
        })
        .where(and(eq(users.id, userId), ne(users.telegramId, -userId)));
    });
    this.realtime.disconnectUser(userId);
  }
}
