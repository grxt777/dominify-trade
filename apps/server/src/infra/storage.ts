import { Inject, Injectable } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config';
import { CONFIG } from './tokens';

/**
 * Хранилище файлов. На Railway — Storage bucket (S3-совместимый) с подписанными ссылками.
 * Локально — папка на диске, а ссылки подписывает сам api.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client | null;
  /** Отдельный ключ для подписи ссылок на файлы, производный от JWT_SECRET: токен входа и ссылка не взаимозаменяемы. */
  private readonly linkKey: Buffer;

  constructor(@Inject(CONFIG) private readonly cfg: Config) {
    this.linkKey = createHmac('sha256', cfg.JWT_SECRET).update('dominify:file-links').digest();
    this.s3 =
      cfg.STORAGE_DRIVER === 's3'
        ? new S3Client({
            region: cfg.S3_REGION,
            endpoint: cfg.S3_ENDPOINT || undefined,
            forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
            credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
          })
        : null;
  }

  /**
   * Ссылка, по которой клиент загрузит файл методом PUT. Загрузка всегда идёт через api:
   * так не нужен CORS на бакете, а api сам кладёт файл в хранилище.
   */
  async uploadUrl(key: string, _mime: string, ttlSec = 600): Promise<string> {
    return `${this.cfg.PUBLIC_API_URL}/v1/files/local/${encodeURIComponent(key)}?${this.localSig(key, 'put', ttlSec)}`;
  }

  /** Короткоживущая ссылка на скачивание. */
  async downloadUrl(key: string, ttlSec = 600): Promise<string> {
    if (this.s3) {
      return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }), { expiresIn: ttlSec });
    }
    return `${this.cfg.PUBLIC_API_URL}/v1/files/local/${encodeURIComponent(key)}?${this.localSig(key, 'get', ttlSec)}`;
  }

  /** Серверная запись (файлы из чата бота). */
  async put(key: string, body: Buffer, mime: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, Body: body, ContentType: mime }));
      return;
    }
    const full = this.localPath(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    if (this.s3) {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes);
    }
    return readFile(this.localPath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      if (this.s3) {
        await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
        return true;
      }
      await stat(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  // ── локальный режим ──

  localPath(key: string): string {
    const safe = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return path.resolve(this.cfg.LOCAL_STORAGE_DIR, safe);
  }

  private sign(op: string, key: string, exp: number): string {
    return createHmac('sha256', this.linkKey).update(`${op}:${key}:${exp}`).digest('base64url');
  }

  private localSig(key: string, op: 'get' | 'put', ttlSec: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `op=${op}&exp=${exp}&sig=${this.sign(op, key, exp)}`;
  }

  verifyLocalSig(key: string, op: string, exp: number, sig: string): boolean {
    if (!exp || exp < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sign(op, key, exp));
    const got = Buffer.from(sig);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}
