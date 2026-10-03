import { Body, Controller, Get, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { chats, companies, deals, gigs, memberships, messages, requests, users, type Db } from '@dominify/db';
import { sendMessageSchema, type SendMessageDto } from '@dominify/shared';
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { maskContacts } from '../common/contacts';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, RateLimit, type AuthUser } from '../auth/guards';
import { FilesService } from '../files/files';
import { RealtimeEmitter } from '../infra/realtime-emitter';
import { DB } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';

/** Переписка по паре «заявка × поставщик». Появляется после первого отклика. */
@Injectable()
export class ChatService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtime: RealtimeEmitter,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
  ) {}

  /** Сторона пользователя в чате или null, если доступа нет. */
  async sideOf(userId: number, chatId: number): Promise<{ side: 'buyer' | 'supplier'; chat: typeof chats.$inferSelect } | null> {
    const [c] = await this.db.select().from(chats).where(eq(chats.id, chatId));
    if (!c) return null;
    if (c.buyerUserId === userId) return { side: 'buyer', chat: c };
    const [m] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, c.supplierCompanyId)));
    return m ? { side: 'supplier', chat: c } : null;
  }

  /** Контакты открыты, только когда этого поставщика выбрали исполнителем по заявке. В вопросах по услуге — никогда. */
  private async contactsOpen(chat: typeof chats.$inferSelect): Promise<boolean> {
    if (!chat.requestId) return false;
    const [d] = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.requestId, chat.requestId), eq(deals.supplierCompanyId, chat.supplierCompanyId), ne(deals.status, 'cancelled')));
    return !!d;
  }

  /** Чат «вопрос по услуге» до заказа: один на пару покупатель × услуга. */
  async askAboutGig(userId: number, gigId: number) {
    const [g] = await this.db
      .select({ id: gigs.id, companyId: gigs.companyId })
      .from(gigs)
      .innerJoin(companies, eq(companies.id, gigs.companyId))
      .where(and(eq(gigs.id, gigId), eq(gigs.active, true), eq(companies.blocked, false)));
    if (!g) throw notFound('Услуга');
    const [self] = await this.db
      .select({ id: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, g.companyId)));
    if (self) throw new AppError('self_chat', 'Это услуга вашей компании', HttpStatus.FORBIDDEN);
    await this.db
      .insert(chats)
      .values({ gigId, supplierCompanyId: g.companyId, buyerUserId: userId })
      .onConflictDoNothing({ target: [chats.gigId, chats.buyerUserId], where: sql`${chats.requestId} is null` });
    const [c] = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.gigId, gigId), eq(chats.buyerUserId, userId), isNull(chats.requestId)));
    return { chatId: c.id };
  }

  async list(userId: number) {
    const myCompanies = (await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, userId))).map((m) => m.id);
    return this.db
      .select({
        id: chats.id,
        requestId: chats.requestId,
        gigId: chats.gigId,
        title: sql<string | null>`coalesce(${requests.title}, ${gigs.title})`,
        supplierCompanyId: chats.supplierCompanyId,
        supplierName: companies.name,
        buyerName: users.firstName,
        buyerUserId: chats.buyerUserId,
        lastMessageAt: chats.lastMessageAt,
        unread: sql<number>`(select count(*)::int from ${messages} m where m.chat_id = ${chats.id} and m.sender_user_id <> ${userId} and m.read_at is null)`,
      })
      .from(chats)
      .leftJoin(requests, eq(requests.id, chats.requestId))
      .leftJoin(gigs, eq(gigs.id, chats.gigId))
      .innerJoin(companies, eq(companies.id, chats.supplierCompanyId))
      .innerJoin(users, eq(users.id, chats.buyerUserId))
      .where(
        and(
          or(eq(chats.buyerUserId, userId), myCompanies.length ? inArray(chats.supplierCompanyId, myCompanies) : sql`false`),
          // Вопрос по услуге без единого сообщения в списке не показываем.
          or(sql`${chats.requestId} is not null`, sql`${chats.lastMessageAt} is not null`),
        ),
      )
      .orderBy(sql`${chats.lastMessageAt} desc nulls last`)
      .limit(100);
  }

  async messages(userId: number, chatId: number, beforeId?: number) {
    const access = await this.sideOf(userId, chatId);
    if (!access) throw notFound('Чат');
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), beforeId ? lt(messages.id, beforeId) : undefined))
      .orderBy(desc(messages.id))
      .limit(50);
    await this.db
      .update(messages)
      .set({ readAt: new Date() })
      .where(and(eq(messages.chatId, chatId), ne(messages.senderUserId, userId), isNull(messages.readAt)));
    this.realtime.toChat(chatId, 'message.read', { chatId, byUserId: userId });
    const [gig] = access.chat.gigId ? await this.db.select({ title: gigs.title }).from(gigs).where(eq(gigs.id, access.chat.gigId)) : [];
    const [co] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, access.chat.supplierCompanyId));
    return {
      side: access.side,
      chat: access.chat,
      gigTitle: gig?.title ?? null,
      supplierName: co?.name ?? null,
      contactsOpen: await this.contactsOpen(access.chat),
      messages: rows.reverse(),
    };
  }

  async send(userId: number, chatId: number, dto: SendMessageDto) {
    const access = await this.sideOf(userId, chatId);
    if (!access) throw forbidden('Нет доступа к чату');
    if (dto.fileId) await this.files.assertOwnReady(userId, [dto.fileId]);
    let text = dto.text ?? null;
    let masked = false;
    if (text && !(await this.contactsOpen(access.chat))) ({ text, masked } = maskContacts(text));
    const [msg] = await this.db
      .insert(messages)
      .values({ chatId, senderUserId: userId, text, fileId: dto.fileId ?? null })
      .returning();
    await this.db.update(chats).set({ lastMessageAt: new Date() }).where(eq(chats.id, chatId));
    this.realtime.toChat(chatId, 'message.created', msg);

    // Собеседнику — в бот, если он не в Mini App.
    const [sender] = await this.db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId));
    const [gig] = !access.chat.requestId && access.chat.gigId ? await this.db.select({ title: gigs.title }).from(gigs).where(eq(gigs.id, access.chat.gigId)) : [];
    const payload = { chatId, requestId: access.chat.requestId, gigTitle: gig?.title ?? '', from: sender?.firstName ?? '', text: (text ?? '📎').slice(0, 300) };
    if (access.side === 'buyer') {
      const members = await this.db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.companyId, access.chat.supplierCompanyId));
      for (const m of members) {
        this.realtime.toUser(m.userId, 'message.created', msg);
        await this.notifications.notify(m.userId, 'message', payload, { respectOnline: true });
      }
    } else {
      const [co] = await this.db.select({ name: companies.name }).from(companies).where(eq(companies.id, access.chat.supplierCompanyId));
      this.realtime.toUser(access.chat.buyerUserId, 'message.created', msg);
      await this.notifications.notify(access.chat.buyerUserId, 'message', { ...payload, from: co?.name ?? payload.from }, { respectOnline: true });
    }
    return { ...msg, masked };
  }

  /** Новые сообщения после id: для опроса, если сокет недоступен. */
  async since(userId: number, chatId: number, afterId: number) {
    const access = await this.sideOf(userId, chatId);
    if (!access) throw notFound('Чат');
    return this.db.select().from(messages).where(and(eq(messages.chatId, chatId), gt(messages.id, afterId))).orderBy(messages.id);
  }
}

@Controller('v1/chats')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.chat.list(u.id);
  }

  @Get(':id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query('before') before?: string, @Query('after') after?: string) {
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    const afterId = num(after);
    if (afterId !== undefined) return this.chat.since(u.id, id, afterId);
    return this.chat.messages(u.id, id, num(before));
  }

  @Post(':id/messages')
  @RateLimit('chat', 60, 60)
  send(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(sendMessageSchema)) dto: SendMessageDto) {
    return this.chat.send(u.id, id, dto);
  }
}
