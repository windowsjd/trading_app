import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { LimitOrderCancelService } from '../orders/limit-order-cancel.service';
import { OrderReservationService } from '../orders/order-reservation.service';
import { MarketSessionOverrideModule } from '../orders/market-calendar/market-session-override.module';
import { AdminUserStatusController } from './admin-user-status.controller';
import { AdminUserManagementController } from './admin-user-management.controller';
import { OperatorAccountManagementService } from './operator-account-management.service';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorController } from './operator.controller';
import { AdminGuard, OperatorGuard } from './operator.guard';
import { OperatorMarketSessionOverrideController } from './operator-market-session-override.controller';
import { OperatorMarketSessionOverrideService } from './operator-market-session-override.service';
import { OperatorProviderIngestionController } from './operator-provider-ingestion.controller';
import { OperatorProviderIngestionService } from './operator-provider-ingestion.service';
import { OperatorSeasonModerationController } from './operator-season-moderation.controller';
import { OperatorSeasonModerationService } from './operator-season-moderation.service';
import { OperatorService } from './operator.service';
import { OperatorUserStatusService } from './operator-user-status.service';

@Module({
  imports: [PrismaModule, ProvidersModule, MarketSessionOverrideModule],
  controllers: [
    AdminUserManagementController,
    AdminUserStatusController,
    OperatorController,
    OperatorMarketSessionOverrideController,
    OperatorProviderIngestionController,
    OperatorSeasonModerationController,
  ],
  providers: [
    AdminGuard,
    LimitOrderCancelService,
    OperatorAccountManagementService,
    OperatorAuditService,
    OperatorGuard,
    OperatorMarketSessionOverrideService,
    OperatorProviderIngestionService,
    OperatorSeasonModerationService,
    OperatorService,
    OperatorUserStatusService,
    OrderReservationService,
  ],
  exports: [AdminGuard, OperatorAuditService, OperatorGuard, OperatorService],
})
export class OperatorModule {}
