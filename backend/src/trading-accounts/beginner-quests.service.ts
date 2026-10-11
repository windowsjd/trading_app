import { HttpStatus, Injectable } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import { conditionalEnabled } from '../conditional/conditional.config';
import { futuresTradingMode } from '../futures/futures.config';
import { isLimitOrderEnabled } from '../orders/limit-order.config';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from './trading-account-access.service';
import {
  BeginnerQuestEvidence,
  type QuestClient,
} from './beginner-quest-evidence';
export {
  BEGINNER_QUEST_01_ID,
  BEGINNER_QUEST_02_ID,
  BEGINNER_QUEST_01_FX_STEP,
  BEGINNER_QUEST_02_TRANSFER_STEP,
} from './beginner-quest-evidence';

@Injectable()
export class BeginnerQuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TradingAccountAccessService,
    private readonly performance: GeneralAccountPerformanceService,
  ) {}

  private async account(
    userId: string | undefined,
    accountId: string,
    client: QuestClient = this.prisma,
  ) {
    if (!userId)
      throw createApiError(
        'UNAUTHORIZED',
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
      );
    const account = await this.access.getOwnedAccountOrThrow(
      userId,
      accountId.trim(),
      client,
    );
    if (account.mode !== 'beginner')
      throw createApiError(
        'BEGINNER_QUEST_ACCOUNT_ONLY',
        'Quests are available only for beginner accounts.',
        409,
      );
    await this.performance.assertGeneralAccountReady(account, client);
    return account;
  }

  private async response(accountId: string, client: QuestClient) {
    return {
      success: true as const,
      data: {
        ...(await new BeginnerQuestEvidence(client).read(accountId)),
        operations: {
          limitOrdersEnabled: isLimitOrderEnabled(),
          conditionalOrdersEnabled: conditionalEnabled(),
          futuresTradingMode: futuresTradingMode(),
        },
      },
    };
  }

  /** A consistent read; never creates accounts, financial rows, or learning state. */
  async getQuestProgress(userId: string | undefined, accountId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const account = await this.account(userId, accountId, tx);
        return this.response(account.id, tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /** UI acknowledgement is separate from financial evidence, immutable and idempotent. */
  async acknowledge(
    userId: string | undefined,
    accountId: string,
    body: { stepId?: unknown; orderId?: unknown },
  ) {
    const account = await this.account(userId, accountId);
    if (
      !body ||
      typeof body.stepId !== 'string' ||
      !['holdings_reviewed', 'limit_result_reviewed'].includes(body.stepId) ||
      typeof body.orderId !== 'string' ||
      !body.orderId ||
      body.orderId.length > 128
    ) {
      throw createApiError(
        'INVALID_QUEST_ACKNOWLEDGEMENT',
        'Specify a learning step and its order.',
        400,
      );
    }
    const stepId = body.stepId,
      orderId = body.orderId;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM trading_accounts WHERE id = ${account.id} AND user_id = ${account.userId} FOR UPDATE`;
      await this.account(userId, account.id, tx);
      const reader = new BeginnerQuestEvidence(tx);
      const progress = await reader.read(account.id);
      const previous = progress.quests[stepId === 'holdings_reviewed' ? 1 : 4];
      const at = previous.steps[previous.steps.length - 1];
      if (
        previous.status !== 'completed' ||
        !at.completedAt ||
        !at.referenceId
      ) {
        throw createApiError(
          'BEGINNER_QUEST_PREREQUISITE',
          'Complete the preceding quest first.',
          409,
        );
      }
      const after = {
        id: at.referenceId,
        executedAt: new Date(at.completedAt),
      };
      const order =
        stepId === 'holdings_reviewed'
          ? await reader.filledOrder(
              account.id,
              after,
              'crypto',
              'buy',
              orderId,
            )
          : await reader.limitOrder(account.id, after, orderId);
      const evidenceAt =
        order &&
        ('submittedAt' in order
          ? reader.limitResolvedAt(order)
          : order.executedAt);
      if (!order || !evidenceAt) {
        throw createApiError(
          'BEGINNER_QUEST_EVIDENCE_REQUIRED',
          'A qualifying committed order result is required.',
          409,
        );
      }
      const [clock] = await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`;
      if (clock.now <= evidenceAt)
        throw createApiError(
          'BEGINNER_QUEST_EVIDENCE_REQUIRED',
          'Retry after the committed result is available.',
          409,
        );
      await tx.beginnerQuestAcknowledgement.upsert({
        where: {
          tradingAccountId_stepId: { tradingAccountId: account.id, stepId },
        },
        create: {
          tradingAccountId: account.id,
          stepId,
          orderId,
          acknowledgedAt: clock.now,
        },
        update: {},
      });
      return this.response(account.id, tx);
    });
  }
}
