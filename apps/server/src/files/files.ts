import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { chats, files, memberships, messages, offers, requestFiles, requests, staff, type Db } from '@dominify/db';
import { uploadRequestSchema, type UploadRequestDto } from '@dominify/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { randomToken } from '../common/crypto';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, Public, RateLimit, type AuthUser } from '../auth/guards';
import { StorageService } from '../infra/storage';
import { DB } from '../infra/tokens';
import { RequestAccess } from '../requests/access';
import { matchesMime } from './sniff';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
};

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

type FileRow = typeof files.$inferSelect;

@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly access: RequestAccess,
  ) {}

  /** Выдать ссылку для загрузки файла. Ссылка одноразовая: после загрузки файл перезаписать нельзя. */
  async presign(userId: number, dto: UploadRequestDto) {
    const key = `u/${userId}/${Date.now().toString(36)}-${randomToken(6)}.${EXT[dto.mime]}`;
    const [row] = await this.db.insert(files).values({ ownerUserId: userId, key, mime: dto.mime, size: dto.size, fileName: dto.fileName }).returning();
    return { id: row.id, uploadUrl: await this.storage.uploadUrl(key, dto.mime), headers: { 'content-type': dto.mime } };
  }

  /** Принять содержимое по подписанной ссылке: размер не больше заявленного, сигнатура совпадает с типом. */
  async acceptUpload(key: string, body: Buffer) {
    const [f] = await this.db.select().from(files).where(eq(files.key, key));
    if (!f) throw notFound('Файл');
    if (f.status !== 'pending') throw new AppError('already_uploaded', 'Файл уже загружен', HttpStatus.CONFLICT);
    if (body.length === 0 || body.length > Math.min(f.size, MAX_FILE_BYTES)) {
      throw new AppError('bad_size', 'Размер файла не совпадает с заявленным', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    if (!matchesMime(body, f.mime)) throw new AppError('bad_file', 'Содержимое файла не совпадает с его типом', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    await this.storage.put(key, body, f.mime);
    await this.db.update(files).set({ status: 'uploaded', size: body.length }).where(eq(files.id, f.id));
  }

  async complete(userId: number, id: number) {
    const [f] = await this.db.select().from(files).where(eq(files.id, id));
    if (!f || f.ownerUserId !== userId) throw notFound('Файл');
    if (f.status === 'ready') return { id, status: 'ready' };
    if (f.status !== 'uploaded' || !(await this.storage.exists(f.key))) throw new AppError('not_uploaded', 'Файл ещё не загружен');
    await this.db.update(files).set({ status: 'ready' }).where(eq(files.id, id));
    return { id, status: 'ready' };
  }

  /** Серверная загрузка (файлы из чата бота). */
  async saveBuffer(userId: number, buf: Buffer, mime: string, fileName: string, telegramFileId?: string) {
    if (!EXT[mime] || !matchesMime(buf, mime)) throw new AppError('bad_file', 'Неподдерживаемый формат файла', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    if (buf.length > MAX_FILE_BYTES) throw new AppError('bad_size', 'Файл больше 20 МБ', HttpStatus.PAYLOAD_TOO_LARGE);
    const key = `u/${userId}/${Date.now().toString(36)}-${randomToken(6)}.${EXT[mime]}`;
    await this.storage.put(key, buf, mime);
    const [row] = await this.db
      .insert(files)
      .values({ ownerUserId: userId, key, mime, size: buf.length, fileName, status: 'ready', telegramFileId: telegramFileId ?? null })
      .returning();
    return row;
  }

  /**
   * Прикрепить можно только свои загруженные файлы. Без этой проверки участник любого чата
   * подставил бы чужой fileId в сообщение и получил доступ к файлу.
   */
  async assertOwnReady(userId: number, fileIds: number[]): Promise<void> {
    const ids = [...new Set(fileIds)];
    if (!ids.length) return;
    const own = await this.db
      .select({ id: files.id })
      .from(files)
      .where(and(inArray(files.id, ids), eq(files.ownerUserId, userId), eq(files.status, 'ready')));
    if (own.length !== ids.length) throw forbidden('Файл не найден или ещё не загружен');
  }

  /**
   * Доступ к файлу: владелец, команда, участник заявки, чата или получатель отклика с этим файлом.
   * Во всех ветках файл должен быть приложен своим владельцем: старые записи с чужими fileId доступа не дают.
   */
  async canAccess(userId: number, fileId: number): Promise<FileRow | null> {
    const [f] = await this.db.select().from(files).where(eq(files.id, fileId));
    if (!f || f.status !== 'ready') return null;
    if (f.ownerUserId === userId) return f;
    if (f.ownerUserId === null) return null;
    const [st] = await this.db.select().from(staff).where(eq(staff.userId, userId));
    if (st) return f;

    const reqs = await this.db
      .select({ requestId: requestFiles.requestId })
      .from(requestFiles)
      .innerJoin(requests, eq(requests.id, requestFiles.requestId))
      .where(and(eq(requestFiles.fileId, fileId), eq(requests.authorUserId, f.ownerUserId)));
    for (const r of reqs) if (await this.access.roleOf(userId, r.requestId)) return f;

    const inChats = await this.db
      .select({ chatId: messages.chatId })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .leftJoin(memberships, and(eq(memberships.companyId, chats.supplierCompanyId), eq(memberships.userId, userId)))
      .where(
        and(
          eq(messages.fileId, fileId),
          eq(messages.senderUserId, f.ownerUserId),
          or(eq(chats.buyerUserId, userId), sql`${memberships.userId} is not null`),
        ),
      )
      .limit(1);
    if (inChats.length) return f;

    const inOffers = await this.db
      .select({ requestId: offers.requestId })
      .from(offers)
      .where(and(sql`${offers.fileIds} @> ${JSON.stringify([fileId])}::jsonb`, eq(offers.authorUserId, f.ownerUserId)))
      .limit(5);
    for (const o of inOffers) if ((await this.access.roleOf(userId, o.requestId))?.kind === 'author') return f;
    return null;
  }

  async byKey(key: string): Promise<FileRow | null> {
    const [f] = await this.db.select().from(files).where(eq(files.key, key));
    return f ?? null;
  }
}

/** Заголовки для отдачи пользовательских файлов: браузер не исполнит их как страницу. */
function fileHeaders(res: Response, f: FileRow) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=600');
  const disposition = f.mime.startsWith('image/') ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(f.fileName ?? 'file')}`);
}

@Controller('v1/files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageService,
  ) {}

  @Post()
  @RateLimit('upload', 60, 3600)
  presign(@CurrentUser() u: AuthUser, @Body(new ZodPipe(uploadRequestSchema)) dto: UploadRequestDto) {
    return this.files.presign(u.id, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.files.complete(u.id, id);
  }

  /** Короткоживущая ссылка на скачивание. */
  @Get(':id/url')
  async url(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const f = await this.files.canAccess(u.id, id);
    if (!f) throw notFound('Файл');
    return { url: await this.storage.downloadUrl(f.key), mime: f.mime, fileName: f.fileName };
  }

  // ── Загрузка и отдача файлов через api по подписанной ссылке (локальный диск или бакет). ──

  @Public()
  @Put('local/*key')
  async localPut(@Req() req: Request, @Res() res: Response, @Query() q: { op?: string; exp?: string; sig?: string }) {
    const key = decodeURIComponent(req.path.replace(/^\/v1\/files\/local\//, ''));
    if (q.op !== 'put' || !this.storage.verifyLocalSig(key, 'put', Number(q.exp), q.sig ?? '')) throw forbidden('Ссылка недействительна');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_FILE_BYTES) throw new AppError('too_large', 'Файл больше 20 МБ', HttpStatus.PAYLOAD_TOO_LARGE);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_FILE_BYTES) throw new AppError('too_large', 'Файл больше 20 МБ', HttpStatus.PAYLOAD_TOO_LARGE);
      chunks.push(chunk as Buffer);
    }
    await this.files.acceptUpload(key, Buffer.concat(chunks));
    res.status(200).json({ ok: true });
  }

  @Public()
  @Get('local/*key')
  async localGet(@Req() req: Request, @Res() res: Response, @Query() q: { op?: string; exp?: string; sig?: string }) {
    const key = decodeURIComponent(req.path.replace(/^\/v1\/files\/local\//, ''));
    if (q.op !== 'get' || !this.storage.verifyLocalSig(key, 'get', Number(q.exp), q.sig ?? '')) throw forbidden('Ссылка недействительна');
    const f = await this.files.byKey(key);
    if (!f) throw notFound('Файл');
    try {
      const buf = await this.storage.get(key);
      fileHeaders(res, f);
      res.type(f.mime).send(buf);
    } catch {
      throw notFound('Файл');
    }
  }
}
