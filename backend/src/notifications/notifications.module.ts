import { Module } from '@nestjs/common';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { OperatorAuditService } from '../operator/operator-audit.service';
import { OperatorGuard } from '../operator/operator.guard';
import {
  NoticesController,
  NotificationsController,
  OperatorNoticesController,
} from './notifications.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushDevicesService } from './push-devices.service';
import { ImportantNoticesService } from './important-notices.service';
import { ExpoPushClient } from './expo-push.client';
import { PushNotificationScanner } from './push-notification-scanner.service';
import { PushDispatcher } from './push-dispatcher.service';
import { PushNotificationWorker } from './push-notification.worker';

/** Push notifications (docs/push-notifications-contract.md). Depends on no
 * trading module: it only reads committed rows through PrismaService. */
@Module({
  controllers: [
    NotificationsController,
    NoticesController,
    OperatorNoticesController,
  ],
  providers: [
    NotificationPreferencesService,
    PushDevicesService,
    ImportantNoticesService,
    ExpoPushClient,
    PushNotificationScanner,
    PushDispatcher,
    PushNotificationWorker,
    OperatorAuditService,
    OperatorGuard,
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class NotificationsModule {}
