import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { complaints, moderationItems, type Db } from '@dominify/db';
import { complaintSchema, type ComplaintDto } from '@dominify/shared';
import { ZodPipe } from '../common/http';
import { CurrentUser, RateLimit, type AuthUser } from '../auth/guards';
import { DB } from '../infra/tokens';

/** Жалобы пользователей: попадают в очередь модерации админки. */
@Controller('v1/complaints')
export class ComplaintsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('complaint', 10, 86_400)
  async create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(complaintSchema)) dto: ComplaintDto) {
    const [c] = await this.db.insert(complaints).values({ authorUserId: u.id, ...dto }).returning();
    await this.db.insert(moderationItems).values({ kind: 'complaint', refType: dto.targetType, refId: dto.targetId, note: dto.reason });
    return { id: c.id };
  }
}
