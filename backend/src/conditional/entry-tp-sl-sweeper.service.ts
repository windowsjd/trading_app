import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { endEntryTpSlPlansOfEndedEntries } from './entry-tp-sl-state';

/**
 * Safety net for entry plans. Every transaction that ends an entry already
 * ends its pending plans; this bounded sweep (once a minute, a few indexed
 * updates) ends any plan whose entry ended by another path. An ended entry
 * never reopens and a plan never executes anything, so no lease is needed:
 * concurrent sweeps converge on the same rows.
 */
@Injectable()
export class EntryTpSlSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EntryTpSlSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.logger.error('ENTRY_TP_SL_SWEEP_FAILED'),
      );
    }, 60_000);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return 0;
    this.running = true;
    try {
      const [{ now }] = await this.prisma.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`;
      return await endEntryTpSlPlansOfEndedEntries(this.prisma, null, now);
    } finally {
      this.running = false;
    }
  }
}
