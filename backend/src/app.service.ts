import { Injectable, Optional } from '@nestjs/common';
import { getOpsSchedulerConfig } from './ops/ops-config';
import { PrismaService } from './prisma/prisma.service';
import { KisWebSocketStreamingService } from './providers/kis/kis-websocket-streaming.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly kisWebSocketStreamingService?: KisWebSocketStreamingService,
  ) {}

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
        kisWebSocketStreaming:
          this.kisWebSocketStreamingService?.getStatus() ?? null,
        currentTime: new Date().toISOString(),
      },
    };
  }
}
