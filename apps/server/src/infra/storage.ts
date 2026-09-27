import { Inject, Injectable } from '@nestjs/common';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

  constructor(@Inject(CONFIG) private readonly cfg: Config) {
    this.s3 =
      cfg.STORAGE_DRIVER === 's3'
        ? new S3Client({
            region: cfg.S3_REGION,
            endpoint: cfg.S3_ENDPOINT || undefined,
            forcePathStyle: true,
            credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY },
          })
        : null;
  }

  /** Ссылка, по которой клиент сам загрузит файл методом PUT. */
  async uploadUrl(key: string, mime: string, ttlSec = 600): Promise<string> {
    if (this.s3) {
      return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, ContentType: mime }), {
        expiresIn: ttlSec,
      });
    }
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

  // ── локальный режим ──

  localPath(key: string): string {
    const safe = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return path.resolve(this.cfg.LOCAL_STORAGE_DIR, safe);
  }

  private localSig(key: string, op: 'get' | 'put', ttlSec: number): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = createHmac('sha256', this.cfg.JWT_SECRET).update(`${op}:${key}:${exp}`).digest('base64url');
    return `op=${op}&exp=${exp}&sig=${sig}`;
  }

  verifyLocalSig(key: string, op: string, exp: number, sig: string): boolean {
    if (!exp || exp < Date.now() / 1000) return false;
    const expected = createHmac('sha256', this.cfg.JWT_SECRET).update(`${op}:${key}:${exp}`).digest('base64url');
    return expected === sig;
  }
}
