jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: { Decimal },
  };
});

import { HttpException } from '@nestjs/common';
import { pinFuturesExecutionFxEvidence } from './futures-fx-evidence';

const executedAt = new Date('2026-11-03T01:00:00.000Z');

function createTx(input: {
  rule: boolean;
  evidence?: { source: string; id: string; rate: string };
}) {
  return {
    season: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(
        input.rule
          ? {
              finalRankingMinTradedInstruments: 5,
              finalRankingMinTurnoverRatio: '3',
            }
          : {
              finalRankingMinTradedInstruments: null,
              finalRankingMinTurnoverRatio: null,
            },
      ),
    },
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const instants = values[0] as string[];
        const source = strings.join('?').includes("'admin_manual'")
          ? 'admin_manual'
          : (values[1] as string);
        return Promise.resolve(
          input.evidence && input.evidence.source === source
            ? instants.map((at) => ({
                at,
                id: input.evidence!.id,
                rate: input.evidence!.rate,
              }))
            : [],
        );
      },
    ),
  };
}

/** Reduces a thrown error to primitives (never compares the error object). */
async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const isHttp = error instanceof HttpException;
    const body = isHttp
      ? (error.getResponse() as { error?: { code?: string } })
      : undefined;
    return {
      status: isHttp ? error.getStatus() : null,
      code: body?.error?.code ?? null,
    };
  }
  return { status: null, code: 'NO_ERROR' };
}

describe('pinFuturesExecutionFxEvidence', () => {
  it('pins nothing and reads nothing for a general or beginner account', async () => {
    const tx = createTx({ rule: true });

    const pinned = await pinFuturesExecutionFxEvidence(tx as never, {
      seasonId: null,
      tradingAccountId: 'account-1',
      executedAt,
    });

    expect(pinned === null).toBe(true);
    expect(tx.season.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('pins nothing in a season without an eligibility rule, even without any FX', async () => {
    const tx = createTx({ rule: false });

    const pinned = await pinFuturesExecutionFxEvidence(tx as never, {
      seasonId: 'season-1',
      tradingAccountId: 'account-1',
      executedAt,
    });

    expect(pinned === null).toBe(true);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('pins the settlement-rule USD/KRW evidence held at the execution instant', async () => {
    const tx = createTx({
      rule: true,
      evidence: {
        source: 'exchange_rate_api',
        id: 'fx-era',
        rate: '1385.12',
      },
    });

    const pinned = await pinFuturesExecutionFxEvidence(tx as never, {
      seasonId: 'season-1',
      tradingAccountId: 'account-1',
      executedAt,
    });

    expect(pinned).toBe('fx-era');
    // Korea EXIM first, then exchange_rate_api; the exact execution instant.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0][1]).toEqual([executedAt.toISOString()]);
  });

  it('refuses the execution in a rule season when no USD/KRW evidence was held', async () => {
    const tx = createTx({ rule: true });

    const failure = await failureOf(
      pinFuturesExecutionFxEvidence(tx as never, {
        seasonId: 'season-1',
        tradingAccountId: 'account-1',
        executedAt,
      }),
    );

    expect(failure.status).toBe(409);
    expect(failure.code).toBe('FUTURES_FX_EVIDENCE_UNAVAILABLE');
    // Provider sources, then the approved manual fallback, all consulted.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
