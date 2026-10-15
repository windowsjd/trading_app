jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
      rejected: 'rejected',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: { Decimal },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  evaluateFinalQualification,
  minRecognizedTurnoverKrwAtMoneyScale,
  readSeasonTradingActivity,
  remainingRecognizedTurnoverKrw,
  resolveSeasonFinalQualificationCriteria,
} from './season-final-qualification';

const d = (value: string) => new Prisma.Decimal(value);
const season = {
  id: 'season-1',
  startAt: new Date('2026-11-02T00:00:00.000Z'),
  endAt: new Date('2026-11-23T00:00:00.000Z'),
};
const launchCriteria = () =>
  resolveSeasonFinalQualificationCriteria({
    initialCapitalKrw: d('10000000'),
    finalRankingMinTradedInstruments: 5,
    finalRankingMinTurnoverRatio: d('3'),
  })!;

type OrderRow = {
  id: string;
  tradingAccountId: string;
  assetId: string;
  currencyCode: 'KRW' | 'USD';
  grossAmount: Prisma.Decimal | null;
  fxRateSnapshot: {
    id: string;
    baseCurrency: string;
    quoteCurrency: string;
    rate: Prisma.Decimal;
  } | null;
};
type ExecutionRow = {
  id: string;
  tradingAccountId: string;
  instrumentId: string;
  notional: Prisma.Decimal;
  leverage: number;
  executedAt: Date;
};
type FxTable = Record<string, Record<string, { id: string; rate: string }>>;
/** The `where` the activity reader sends; read back by the scope test. */
type ReadWhere = {
  status?: string;
  executedAt: { gte: Date; lt: Date } | null;
  tradingAccountId: { in: string[] };
  tradingAccount: { seasonParticipant: { seasonId: string } };
};
const whereOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as [{ where: ReadWhere }])[0].where;

const KOREA_EXIM = 'korea_exim_exchange_rate';
const EXCHANGE_RATE_API = 'exchange_rate_api';

/** Mock client: `fx[source][isoInstant]` is the snapshot that source holds. */
function createClient(
  input: {
    orders?: OrderRow[];
    undatedFills?: number;
    executions?: ExecutionRow[];
    fx?: FxTable;
  } = {},
) {
  const $queryRaw = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const instants = values[0] as string[];
      const source = strings.join('?').includes("'admin_manual'")
        ? 'admin_manual'
        : (values[1] as string);
      const table = input.fx?.[source] ?? {};
      return Promise.resolve(
        instants
          .filter((at) => table[at])
          .map((at) => ({ at, id: table[at].id, rate: table[at].rate })),
      );
    },
  );

  // Like the database, a read returns only rows of the accounts it names.
  const inAccounts = <T extends { tradingAccountId: string }>(
    rows: T[] | undefined,
    args: { where: ReadWhere },
  ) =>
    (rows ?? []).filter((row) =>
      args.where.tradingAccountId.in.includes(row.tradingAccountId),
    );

  return {
    order: {
      findMany: jest.fn((args: { where: ReadWhere }) =>
        Promise.resolve(inAccounts(input.orders, args)),
      ),
      count: jest.fn().mockResolvedValue(input.undatedFills ?? 0),
    },
    futuresExecution: {
      findMany: jest.fn((args: { where: ReadWhere }) =>
        Promise.resolve(inAccounts(input.executions, args)),
      ),
    },
    $queryRaw,
  };
}

function order(
  overrides: Partial<OrderRow> & Pick<OrderRow, 'id' | 'assetId'>,
): OrderRow {
  return {
    tradingAccountId: 'account-1',
    currencyCode: 'KRW',
    grossAmount: d('1000000'),
    fxRateSnapshot: null,
    ...overrides,
  };
}

function usdOrder(
  id: string,
  assetId: string,
  gross: string,
  rate: string,
  pair: { baseCurrency: string; quoteCurrency: string } = {
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
  },
): OrderRow {
  return order({
    id,
    assetId,
    currencyCode: 'USD',
    grossAmount: d(gross),
    fxRateSnapshot: { id: `fx-${id}`, ...pair, rate: d(rate) },
  });
}

function execution(
  id: string,
  instrumentId: string,
  notional: string,
  leverage: number,
  executedAt: string,
  tradingAccountId = 'account-1',
): ExecutionRow {
  return {
    id,
    tradingAccountId,
    instrumentId,
    notional: d(notional),
    leverage,
    executedAt: new Date(executedAt),
  };
}

async function activityOf(
  client: ReturnType<typeof createClient>,
  accountIds: string[] = ['account-1'],
) {
  return readSeasonTradingActivity(client as never, {
    season,
    tradingAccountIds: accountIds,
  });
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
      isHttp,
      status: isHttp ? error.getStatus() : null,
      code: body?.error?.code ?? null,
    };
  }
  return { isHttp: false, status: null, code: 'NO_ERROR' };
}

describe('resolveSeasonFinalQualificationCriteria', () => {
  it('treats a season without a rule as "everyone is ranked"', () => {
    expect(
      resolveSeasonFinalQualificationCriteria({
        initialCapitalKrw: d('10000000'),
        finalRankingMinTradedInstruments: null,
        finalRankingMinTurnoverRatio: null,
      }) === null,
    ).toBe(true);
    // Seasons read before the columns existed (mocked rows) behave the same.
    expect(
      resolveSeasonFinalQualificationCriteria({
        initialCapitalKrw: d('10000000'),
      }) === null,
    ).toBe(true);
  });

  it('derives the turnover threshold from the initial capital, never an absolute amount', () => {
    const criteria = launchCriteria();

    expect(criteria.minTradedInstrumentCount).toBe(5);
    expect(criteria.minRecognizedTurnoverKrw.toFixed(8)).toBe(
      '30000000.00000000',
    );

    const other = resolveSeasonFinalQualificationCriteria({
      initialCapitalKrw: '5000000.00000000',
      finalRankingMinTradedInstruments: 5,
      finalRankingMinTurnoverRatio: '3.0000',
    })!;
    expect(other.minRecognizedTurnoverKrw.toFixed(8)).toBe('15000000.00000000');
  });

  it.each([
    [5, null],
    [null, '3'],
    [0, '3'],
    [5, '0'],
    [5, '-1'],
    [2.5, '3'],
  ])('fails closed on a damaged rule (%s, %s)', async (minCount, ratio) => {
    const failure = await failureOf(
      Promise.resolve().then(() =>
        resolveSeasonFinalQualificationCriteria({
          initialCapitalKrw: d('10000000'),
          finalRankingMinTradedInstruments: minCount,
          finalRankingMinTurnoverRatio: ratio,
        }),
      ),
    );
    expect(failure.status).toBe(500);
    expect(failure.code).toBe('RANKING_QUALIFICATION_CRITERIA_INVALID');
  });
});

describe('evaluateFinalQualification', () => {
  const criteria = launchCriteria();
  const enoughTurnover = d('30000000.00000000');

  it.each([
    [0, false],
    [4, false],
    [5, true],
    [6, true],
  ])('distinct instruments %i → requirement met %s', (count, met) => {
    const result = evaluateFinalQualification(criteria, {
      tradedInstrumentCount: count,
      recognizedTurnoverKrw: enoughTurnover,
    });
    expect(result.tradedInstrumentRequirementMet).toBe(met);
    expect(result.qualified).toBe(met);
  });

  it.each([
    ['29999999.99999999', false],
    ['30000000.00000000', true],
    ['30000000.00000001', true],
    ['45000000.00000000', true],
  ])('recognized turnover %s → requirement met %s', (turnover, met) => {
    const result = evaluateFinalQualification(criteria, {
      tradedInstrumentCount: 5,
      recognizedTurnoverKrw: d(turnover),
    });
    expect(result.turnoverRequirementMet).toBe(met);
    expect(result.qualified).toBe(met);
  });

  it('requires both conditions', () => {
    const onlyInstruments = evaluateFinalQualification(criteria, {
      tradedInstrumentCount: 9,
      recognizedTurnoverKrw: d('100'),
    });
    const onlyTurnover = evaluateFinalQualification(criteria, {
      tradedInstrumentCount: 1,
      recognizedTurnoverKrw: d('99000000'),
    });
    expect(onlyInstruments.qualified).toBe(false);
    expect(onlyTurnover.qualified).toBe(false);
  });

  it('shows the threshold on the money grid rounded up and floors the remainder at 0', () => {
    const odd = resolveSeasonFinalQualificationCriteria({
      initialCapitalKrw: d('1000.00000001'),
      finalRankingMinTradedInstruments: 1,
      finalRankingMinTurnoverRatio: d('3.3333'),
    })!;
    // 3333.300000033333 exactly; any 8-place turnover >= it is >= the ceiling.
    expect(minRecognizedTurnoverKrwAtMoneyScale(odd).toFixed(8)).toBe(
      '3333.30000004',
    );
    expect(
      evaluateFinalQualification(odd, {
        tradedInstrumentCount: 1,
        recognizedTurnoverKrw: d('3333.30000003'),
      }).turnoverRequirementMet,
    ).toBe(false);
    expect(
      evaluateFinalQualification(odd, {
        tradedInstrumentCount: 1,
        recognizedTurnoverKrw: d('3333.30000004'),
      }).turnoverRequirementMet,
    ).toBe(true);

    expect(
      remainingRecognizedTurnoverKrw(criteria, {
        tradedInstrumentCount: 0,
        recognizedTurnoverKrw: d('12000000'),
      }).toFixed(8),
    ).toBe('18000000.00000000');
    expect(
      remainingRecognizedTurnoverKrw(criteria, {
        tradedInstrumentCount: 0,
        recognizedTurnoverKrw: d('31000000'),
      }).toFixed(8),
    ).toBe('0.00000000');
  });
});

describe('readSeasonTradingActivity', () => {
  it('reads only executed fills of the given season accounts inside [startAt, endAt)', async () => {
    const client = createClient();

    await activityOf(client);

    const orderWhere = whereOf(client.order.findMany);
    expect(orderWhere.status).toBe('executed');
    expect(orderWhere.executedAt?.gte.toISOString()).toBe(
      season.startAt.toISOString(),
    );
    expect(orderWhere.executedAt?.lt.toISOString()).toBe(
      season.endAt.toISOString(),
    );
    expect(orderWhere.tradingAccountId.in.join(',')).toBe('account-1');
    expect(orderWhere.tradingAccount.seasonParticipant.seasonId).toBe(
      'season-1',
    );
    // An executed fill without a time is looked for separately (damage).
    const undatedWhere = whereOf(client.order.count);
    expect(undatedWhere.status).toBe('executed');
    expect(undatedWhere.executedAt === null).toBe(true);

    const executionWhere = whereOf(client.futuresExecution.findMany);
    expect(executionWhere.executedAt?.gte.toISOString()).toBe(
      season.startAt.toISOString(),
    );
    expect(executionWhere.executedAt?.lt.toISOString()).toBe(
      season.endAt.toISOString(),
    );
    expect(executionWhere.tradingAccount.seasonParticipant.seasonId).toBe(
      'season-1',
    );
  });

  it('returns zero activity for an account without fills', async () => {
    const activity = await activityOf(createClient(), ['account-1']);

    expect(activity.get('account-1')!.tradedInstrumentCount).toBe(0);
    expect(activity.get('account-1')!.recognizedTurnoverKrw.toFixed(8)).toBe(
      '0.00000000',
    );
  });

  it('sums Spot buys and sells at their executed amount and counts a repeated asset once', async () => {
    const client = createClient({
      orders: [
        order({ id: 'o-1', assetId: 'samsung', grossAmount: d('1000000') }),
        order({ id: 'o-2', assetId: 'samsung', grossAmount: d('1100000') }),
        // A partial ERS fill stores what actually filled; it is used as is.
        order({ id: 'o-3', assetId: 'hynix', grossAmount: d('250000.5') }),
      ],
    });

    const activity = (await activityOf(client)).get('account-1')!;

    expect(activity.tradedInstrumentCount).toBe(2);
    expect(activity.recognizedTurnoverKrw.toFixed(8)).toBe('2350000.50000000');
  });

  it('converts a USD Spot fill with the FX snapshot pinned at its execution', async () => {
    const client = createClient({
      orders: [usdOrder('o-1', 'aapl', '100', '1400.5')],
    });

    const activity = (await activityOf(client)).get('account-1')!;

    expect(activity.recognizedTurnoverKrw.toFixed(8)).toBe('140050.00000000');
    // A pinned Spot rate needs no as-of lookup.
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it('recognizes Futures notional ÷ execution leverage for every user execution', async () => {
    const at1 = '2026-11-03T01:00:00.000Z';
    const at2 = '2026-11-04T01:00:00.000Z';
    const at3 = '2026-11-05T01:00:00.000Z';
    const at4 = '2026-11-06T01:00:00.000Z';
    const fx = {
      [KOREA_EXIM]: {
        [at1]: { id: 'fx-1', rate: '1000' },
        [at2]: { id: 'fx-2', rate: '1000' },
        [at3]: { id: 'fx-3', rate: '1000' },
        [at4]: { id: 'fx-4', rate: '1000' },
      },
    };
    const client = createClient({
      executions: [
        execution('e-open-1x', 'btc-perp', '1000', 1, at1), // 1000
        execution('e-increase-5x', 'eth-perp', '1000', 5, at2), // 200
        execution('e-reduce-10x', 'eth-perp', '1000', 10, at3), // 100
        execution('e-close-10x', 'eth-perp', '500', 10, at4), // 50
      ],
      fx,
    });

    const activity = (await activityOf(client)).get('account-1')!;

    // (1000 + 200 + 100 + 50) USD × 1000 KRW/USD.
    expect(activity.recognizedTurnoverKrw.toFixed(8)).toBe('1350000.00000000');
    expect(activity.tradedInstrumentCount).toBe(2);
  });

  it('counts BTC Spot and BTC Futures as two instruments', async () => {
    const at = '2026-11-03T01:00:00.000Z';
    const client = createClient({
      orders: [usdOrder('o-1', 'asset-btc', '50', '1000')],
      executions: [execution('e-1', 'instrument-btc-perp', '200', 2, at)],
      fx: { [KOREA_EXIM]: { [at]: { id: 'fx-1', rate: '1000' } } },
    });

    const activity = (await activityOf(client)).get('account-1')!;

    expect(activity.tradedInstrumentCount).toBe(2);
    expect(activity.recognizedTurnoverKrw.toFixed(8)).toBe('150000.00000000');
  });

  it('uses the FX source priority of season settlement: Korea EXIM, then exchange_rate_api, then approved admin_manual', async () => {
    const a = '2026-11-03T01:00:00.000Z';
    const b = '2026-11-04T01:00:00.000Z';
    const c = '2026-11-05T01:00:00.000Z';
    const client = createClient({
      executions: [
        execution('e-a', 'btc-perp', '100', 1, a),
        execution('e-b', 'btc-perp', '100', 1, b),
        execution('e-c', 'btc-perp', '100', 1, c),
      ],
      fx: {
        [KOREA_EXIM]: { [a]: { id: 'ke-a', rate: '1300' } },
        [EXCHANGE_RATE_API]: {
          [a]: { id: 'era-a', rate: '9999' }, // lower priority, never used
          [b]: { id: 'era-b', rate: '1400' },
        },
        admin_manual: { [c]: { id: 'am-c', rate: '1500' } },
      },
    });

    const activity = (await activityOf(client)).get('account-1')!;

    // 100 × 1300 + 100 × 1400 + 100 × 1500.
    expect(activity.recognizedTurnoverKrw.toFixed(8)).toBe('420000.00000000');
    // Each later query only asks for the instants still unresolved.
    const asked = client.$queryRaw.mock.calls.map(
      (call) => (call[1] as string[]).length,
    );
    expect(asked.join(',')).toBe('3,2,1');
  });

  it('sums raw Decimals and rounds the total half-up to 8 places once', async () => {
    const at = '2026-11-03T01:00:00.000Z';
    const client = createClient({
      executions: [
        execution('e-1', 'btc-perp', '100.00000001', 3, at),
        execution('e-2', 'btc-perp', '100.00000001', 3, at),
      ],
      fx: { [KOREA_EXIM]: { [at]: { id: 'fx-1', rate: '1' } } },
    });

    const activity = (await activityOf(client)).get('account-1')!;

    // 2 × 33.333333336666… = 66.66666667333… → 66.66666667
    expect(activity.recognizedTurnoverKrw.toFixed(8)).toBe('66.66666667');
  });

  it('keeps accounts apart and reads large participant sets in bounded batches', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `account-${i}`);
    const client = createClient({
      orders: [
        order({ id: 'o-1', assetId: 'samsung', tradingAccountId: 'account-0' }),
      ],
    });

    const activity = await activityOf(client, ids);

    expect(activity.size).toBe(120);
    expect(client.order.findMany).toHaveBeenCalledTimes(3);
    expect(activity.get('account-0')!.tradedInstrumentCount).toBe(1);
    expect(activity.get('account-1')!.tradedInstrumentCount).toBe(0);
  });

  it.each([
    [
      'a USD order without FX evidence',
      createClient({
        orders: [
          order({
            id: 'o-1',
            assetId: 'aapl',
            currencyCode: 'USD',
            grossAmount: d('100'),
            fxRateSnapshot: null,
          }),
        ],
      }),
      'RANKING_QUALIFICATION_FX_EVIDENCE_MISSING',
    ],
    [
      'a USD order pinned to a non USD/KRW rate',
      createClient({
        orders: [
          usdOrder('o-1', 'aapl', '100', '0.0007', {
            baseCurrency: 'KRW',
            quoteCurrency: 'USD',
          }),
        ],
      }),
      'RANKING_QUALIFICATION_FX_EVIDENCE_MISMATCH',
    ],
    [
      'a USD order pinned to a non-positive rate',
      createClient({ orders: [usdOrder('o-1', 'aapl', '100', '0')] }),
      'RANKING_QUALIFICATION_FX_EVIDENCE_MISMATCH',
    ],
    [
      'a Futures execution without USD/KRW evidence at or before it',
      createClient({
        executions: [
          execution('e-1', 'btc-perp', '100', 2, '2026-11-03T01:00:00.000Z'),
        ],
      }),
      'RANKING_QUALIFICATION_FX_EVIDENCE_MISSING',
    ],
    [
      'an executed order without an executed amount',
      createClient({
        orders: [order({ id: 'o-1', assetId: 'samsung', grossAmount: null })],
      }),
      'RANKING_QUALIFICATION_EXECUTION_EVIDENCE_INVALID',
    ],
    [
      'an executed fill without an execution time',
      createClient({ undatedFills: 1 }),
      'RANKING_QUALIFICATION_EXECUTION_EVIDENCE_INVALID',
    ],
    [
      'a Futures execution without a positive notional',
      createClient({
        executions: [
          execution('e-1', 'btc-perp', '0', 2, '2026-11-03T01:00:00.000Z'),
        ],
      }),
      'RANKING_QUALIFICATION_EXECUTION_EVIDENCE_INVALID',
    ],
  ])(
    'fails closed (never "not qualified") on %s',
    async (_label, client, code) => {
      const failure = await failureOf(activityOf(client));

      expect(failure.isHttp).toBe(true);
      expect(failure.status).toBe(500);
      expect(failure.code).toBe(code);
    },
  );
});
