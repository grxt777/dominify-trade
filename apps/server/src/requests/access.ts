import { Inject, Injectable } from '@nestjs/common';
import { memberships, requestDeliveries, requests, staff, type Db } from '@dominify/db';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../infra/tokens';

export type RequestRole =
  | { kind: 'author' }
  | { kind: 'supplier'; companyId: number; deliveryId: number }
  | { kind: 'staff' };

/**
 * Кто и в какой роли видит заявку. Поставщик видит полную заявку, только если она была ему разослана:
 * иначе конкурент выкачал бы все заявки платформы.
 */
@Injectable()
export class RequestAccess {
  constructor(@Inject(DB) private readonly db: Db) {}

  async roleOf(userId: number, requestId: number): Promise<RequestRole | null> {
    const [r] = await this.db.select({ authorUserId: requests.authorUserId }).from(requests).where(eq(requests.id, requestId));
    if (!r) return null;
    if (r.authorUserId === userId) return { kind: 'author' };
    const myCompanies = await this.db.select({ id: memberships.companyId }).from(memberships).where(eq(memberships.userId, userId));
    if (myCompanies.length) {
      const [d] = await this.db
        .select({ id: requestDeliveries.id, companyId: requestDeliveries.supplierCompanyId, notifyAt: requestDeliveries.notifyAt })
        .from(requestDeliveries)
        .where(
          and(
            eq(requestDeliveries.requestId, requestId),
            inArray(
              requestDeliveries.supplierCompanyId,
              myCompanies.map((c) => c.id),
            ),
          ),
        );
      // Отложенная рассылка (бесплатный тариф) открывает заявку только после notifyAt.
      if (d && d.notifyAt.getTime() <= Date.now()) return { kind: 'supplier', companyId: d.companyId, deliveryId: d.id };
    }
    const [st] = await this.db.select().from(staff).where(eq(staff.userId, userId));
    if (st) return { kind: 'staff' };
    return null;
  }
}
