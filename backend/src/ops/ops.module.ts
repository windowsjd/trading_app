import { Module } from '@nestjs/common';
import { BatchModule } from '../batch/batch.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RankingModule } from '../ranking/ranking.module';
import { OpsJobLockService } from './ops-job-lock.service';
import { OpsJobRunService } from './ops-job-run.service';
import { OpsJobRunnerService } from './ops-job-runner.service';
import { OpsSchedulerService } from './ops-scheduler.service';

@Module({
  imports: [BatchModule, PrismaModule, RankingModule],
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
