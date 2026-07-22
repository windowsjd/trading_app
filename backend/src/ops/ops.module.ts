import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProvidersModule } from '../providers/providers.module';
import { RankingModule } from '../ranking/ranking.module';
import { AssetsModule } from '../assets/assets.module';
import { OrdersModule } from '../orders/orders.module';
import { OpsJobLockService } from './ops-job-lock.service';
import { OpsJobRunService } from './ops-job-run.service';
import { OpsJobRunnerService } from './ops-job-runner.service';
import { OpsSchedulerService } from './ops-scheduler.service';

@Module({
  imports: [
    AssetsModule,
    BatchModule,
    PrismaModule,
    ProvidersModule,
    RankingModule,
    OrdersModule,
  ],
  providers: [
    OpsJobLockService,
    OpsJobRunService,
    OpsJobRunnerService,
    OpsSchedulerService,
  ],
  exports: [
    OpsJobLockService,
    OpsJobRunService,
    OpsJobRunnerService,
    OpsSchedulerService,
  ],
})
export class OpsModule {}
