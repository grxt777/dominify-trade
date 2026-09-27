import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param, ParseIntPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { chats, files, memberships, messages, offers, requestFiles, staff, type Db } from '@dominify/db';
import { uploadRequestSchema, type UploadRequestDto } from '@dominify/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomToken } from '../common/crypto';
import { AppError, forbidden, notFound, ZodPipe } from '../common/http';
import { CurrentUser, Public, RateLimit, type AuthUser } from '../auth/guards';
import { StorageService } from '../infra/storage';
import { DB } from '../infra/tokens';
import { RequestAccess } from '../requests/access';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
};

@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly access: RequestAccess,
  ) {}

  /** Выдать ссылку для прямой загрузки файла в хранилище. */
  async presign(userId: number, dto: UploadRequestDto) {
    const key = `u/${userId}/${Date.now().toString(36)}-${randomToken(6)}.${EXT[dto.mime]}`;
    const [row] = await this.db.insert(files).values({ ownerUserId: userId, key, mime: dto.mime, size: dto.size, fileName: dto.fileName }).returning();
    return { id: row.id, uploadUrl: await this.storage.uploadUrl(key, dto.mime), headers: { 'content-type': dto.mime } };
  }

  async complete(userId: number, id: number) {
    const [f] = await this.db.select().from(files).where(eq(files.id, id));
    if (!f || f.ownerUserId !== userId) throw notFound('Файл');
    await this.db.update(files).set({ status: 'ready' }).where(eq(files.id, id));
    return { id, status: 'ready' };
  }

  /** Серверная загрузка (файлы из чата бота). */
  async saveBuffer(userId: number, buf: Buffer, mime: string, fileName: string, telegramFileId?: string) {
    const ext = EXT[mime] ?? 'bin';
    const key = `u/${userId}/${Date.now().toString(36)}-${randomToken(6)}.${ext}`;
    await this.storage.put(key, buf, mime);
    const [row] = await this.db
      .insert(files)
      .values({ ownerUserId: userId, key, mime, size: buf.length, fileName, status: 'ready', telegramFileId: telegramFileId ?? null })
      .returning();
    return row;
  }

  /** Доступ к файлу: владелец, команда, участник заявки, чата или получатель отклика с этим файлом. */
  async canAccess(userId: number, fileId: number): Promise<typeof files.$inferSelect | null> {
    const [f] = await this.db.select().from(files).where(eq(files.id, fileId));
    if (!f) return null;
    if (f.ownerUserId === userId) return f;
    const [st] = await this.db.select().from(staff).where(eq(staff.userId, userId));
    if (st) return f;
    const reqs = await this.db.select({ requestId: requestFiles.requestId }).from(requestFiles).where(eq(requestFiles.fileId, fileId));
    for (const r of reqs) if (await this.access.roleOf(userId, r.requestId)) return f;
    const inChats = await this.db
      .select({ chatId: messages.chatId })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .leftJoin(memberships, and(eq(memberships.companyId, chats.supplierCompanyId), eq(memberships.userId, userId)))
      .where(and(eq(messages.fileId, fileId), or(eq(chats.buyerUserId, userId), sql`${memberships.userId} is not null`)))
      .limit(1);
    if (inChats.length) return f;
    const inOffers = await this.db
      .select({ requestId: offers.requestId })
      .from(offers)
      .where(sql`${offers.fileIds} @> ${JSON.stringify([fileId])}::jsonb`)
      .limit(5);
    for (const o of inOffers) if ((await this.access.roleOf(userId, o.requestId))?.kind === 'author') return f;
    return null;
  }
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

  // ── Локальный драйвер хранилища: подписанные PUT и GET. На Railway вместо этого работает бакет. ──

  @Public()
  @Put('local/*key')
  async localPut(@Req() req: Request, @Res() res: Response, @Query() q: { op?: string; exp?: string; sig?: string }) {
    const key = decodeURIComponent(req.path.replace(/^\/v1\/files\/local\//, ''));
    if (q.op !== 'put' || !this.storage.verifyLocalSig(key, 'put', Number(q.exp), q.sig ?? '')) throw forbidden('Ссылка недействительна');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 20 * 1024 * 1024) throw new AppError('too_large', 'Файл больше 20 МБ');
      chunks.push(chunk as Buffer);
    }
    const full = this.storage.localPath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, Buffer.concat(chunks));
    res.status(200).json({ ok: true });
  }

  @Public()
  @Get('local/*key')
  async localGet(@Req() req: Request, @Res() res: Response, @Query() q: { op?: string; exp?: string; sig?: string }) {
    const key = decodeURIComponent(req.path.replace(/^\/v1\/files\/local\//, ''));
    if (q.op !== 'get' || !this.storage.verifyLocalSig(key, 'get', Number(q.exp), q.sig ?? '')) throw forbidden('Ссылка недействительна');
    try {
      const buf = await readFile(this.storage.localPath(key));
      const ext = path.extname(key).slice(1);
      const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
      res.type(mime).send(buf);
    } catch {
      throw notFound('Файл');
    }
  }
}
