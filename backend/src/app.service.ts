import { Injectable } from '@nestjs/common';
import { getOpsSchedulerConfig } from './ops/ops-config';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHealth() {
    return {
      success: true,
      data: {
        service: 'ok',
      },
    };
  }

  async getDbHealth() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      success: true,
      data: {
        database: 'ok',
      },
    };
  }

  async getReadiness() {
    await this.prisma.$queryRaw`SELECT 1`;
    const scheduler = getOpsSchedulerConfig();

    return {
      success: true,
      data: {
        app: 'ok',
        database: 'ok',
        scheduler: {
          enabled: scheduler.enabled,
          timezone: scheduler.timezone,
          jobs: scheduler.jobs,
        },
        currentTime: new Date().toISOString(),
      },
    };
  }
}
