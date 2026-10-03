import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AuthController, MeController } from './auth/auth.controller';
import { AuthGuard, RateLimitGuard } from './auth/guards';
import { BillingController, PayPageController, PaymentWebhooksController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { ClickService } from './billing/click';
import { PaymeService } from './billing/payme';
import { CatalogController, CatalogService } from './catalog/catalog';
import { ChatController, ChatService } from './chat/chat';
import { ErrorFilter } from './common/http';
import { CompaniesController, CompaniesService } from './companies/companies';
import { DealsController, DealsService } from './deals/deals';
import { FilesController, FilesService } from './files/files';
import { GigsController, GigsService } from './gigs/gigs';
import { GrowthService } from './growth/growth';
import { HealthController } from './health';
import { InfraModule } from './infra/infra.module';
import { MatchingService } from './matching/matching.service';
import { ComplaintsController } from './moderation/complaints';
import { NotificationsService } from './notifications/notifications.service';
import { OffersController, OffersService } from './offers/offers';
import { ParsingService } from './parsing/parsing.service';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RequestAccess } from './requests/access';
import { RequestsController } from './requests/requests.controller';
import { RequestsService } from './requests/requests.service';
import { UsersService } from './users/users.service';
import { NotificationSender } from './worker/sender';

const services = [
  UsersService,
  CatalogService,
  CompaniesService,
  ParsingService,
  RequestAccess,
  RequestsService,
  MatchingService,
  OffersService,
  DealsService,
  ChatService,
  BillingService,
  PaymeService,
  ClickService,
  NotificationsService,
  FilesService,
  GigsService,
  GrowthService,
];

/** Бизнес-логика без HTTP: общая для api, бота и воркера. */
@Module({
  imports: [InfraModule],
  providers: services,
  exports: services,
})
export class CoreModule {}

@Module({
  imports: [CoreModule],
  controllers: [
    HealthController,
    AuthController,
    MeController,
    CatalogController,
    CompaniesController,
    GigsController,
    RequestsController,
    OffersController,
    DealsController,
    ChatController,
    FilesController,
    ComplaintsController,
    BillingController,
    PaymentWebhooksController,
    PayPageController,
    AdminController,
  ],
  providers: [
    RealtimeGateway,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class ApiModule {}

@Module({
  imports: [CoreModule],
  providers: [NotificationSender],
  exports: [NotificationSender],
})
export class WorkerModule {}

@Module({
  imports: [CoreModule],
})
export class BotModule {}
