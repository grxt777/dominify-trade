import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import {
  answerRequestSchema,
  parseRequestSchema,
  submitRequestSchema,
  type AnswerRequestDto,
  type ParseRequestDto,
  type SubmitRequestDto,
} from '@dominify/shared';
import { AppError, ZodPipe } from '../common/http';
import { CurrentUser, RateLimit, type AuthUser } from '../auth/guards';
import { UsersService } from '../users/users.service';
import { RequestsService } from './requests.service';

@Controller('v1')
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly users: UsersService,
  ) {}

  /** Черновик из свободного текста и вложений. Разбор приходит асинхронно (WebSocket request.updated). */
  @Post('requests/parse')
  @RateLimit('parse', 20, 3600)
  parse(@CurrentUser() u: AuthUser, @Body(new ZodPipe(parseRequestSchema)) dto: ParseRequestDto) {
    return this.requests.createDraft(u.id, dto, 'miniapp');
  }

  @Post('requests')
  submit(@CurrentUser() u: AuthUser, @Body(new ZodPipe(submitRequestSchema)) dto: SubmitRequestDto) {
    return this.requests.submit(u.id, dto);
  }

  @Get('requests')
  mine(@CurrentUser() u: AuthUser) {
    return this.requests.listMine(u.id);
  }

  @Get('requests/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.requests.view(u.id, id);
  }

  @Post('requests/:id/answer')
  @RateLimit('answer', 30, 3600)
  answer(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body(new ZodPipe(answerRequestSchema)) dto: AnswerRequestDto) {
    return this.requests.answer(u.id, id, dto);
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.requests.cancel(u.id, id);
  }

  /** Лента заявок поставщика. companyId — из параметра или активная компания пользователя. */
  @Get('feed')
  async feed(@CurrentUser() u: AuthUser, @Query('companyId') companyIdRaw?: string) {
    const companyId = companyIdRaw ? Number(companyIdRaw) : u.activeCompanyId;
    if (!companyId) throw new AppError('no_company', 'Сначала создайте компанию поставщика');
    await this.users.assertMember(u.id, companyId);
    return this.requests.feed(u.id, companyId);
  }
}
