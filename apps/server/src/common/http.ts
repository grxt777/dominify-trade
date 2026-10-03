import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  PipeTransform,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { captureException } from '../infra/monitoring';

/** Валидация тела запроса общей zod-схемой из @dominify/shared. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new BadRequestException({
        code: 'validation_error',
        message: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    return r.data;
  }
}

export class AppError extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ code, message }, status);
  }
}

export const notFound = (what = 'Объект') => new AppError('not_found', `${what} не найден`, HttpStatus.NOT_FOUND);
export const forbidden = (msg = 'Нет доступа') => new AppError('forbidden', msg, HttpStatus.FORBIDDEN);
export const conflict = (code: string, msg: string) => new AppError(code, msg, HttpStatus.CONFLICT);

/** Единый формат ошибок: { error: { code, message } }. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (!res || typeof res.status !== 'function') return;
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const obj = typeof body === 'object' && body ? (body as Record<string, unknown>) : { message: String(body) };
      res.status(status).json({
        error: {
          code: (obj.code as string) ?? HttpStatus[status]?.toLowerCase() ?? 'error',
          message: Array.isArray(obj.message) ? obj.message.join('; ') : (obj.message as string) ?? 'Ошибка',
        },
      });
      return;
    }
    if (exception instanceof ZodError) {
      res.status(400).json({ error: { code: 'validation_error', message: exception.message } });
      return;
    }
    this.log.error(exception instanceof Error ? exception.stack : String(exception));
    const req = host.switchToHttp().getRequest<{ method?: string; route?: { path?: string } }>();
    captureException(exception, { method: req?.method, route: req?.route?.path });
    res.status(500).json({ error: { code: 'internal', message: 'Внутренняя ошибка, мы уже разбираемся' } });
  }
}
