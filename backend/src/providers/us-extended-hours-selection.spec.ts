jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
  };
});

import { AssetType, CurrencyCode, Prisma } from '../generated/prisma/client';
import { findMarketAwareAssetPriceCandidates } from './asset-price-snapshot-query';
import {
  PROVIDER_SOURCE_NAMES,
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  selectUsExtendedHoursExecutionSnapshot,
  type ProviderWorkflow,
} from './source-eligibility.policy';
import { resolveUsExtendedHoursWindow } from '../orders/us-extended-hours.policy';

const REGULAR = PROVIDER_SOURCE_NAMES.usStockTiingo;
const EXTENDED = PROVIDER_SOURCE_NAMES.usStockTiingoExtended;
const us = { assetType: AssetType.us_stock, market: 'NAS' };

// 2026-11-10 (Tuesday, EST): pre-market 09:00Z–14:30Z, regular 14:30Z–21:00Z,
// after-hours 21:00Z–01:00Z. The previous session (11-09) closed 21:00Z.
const PRE = new Date('2026-11-10T11:00:00.000Z');
const AFTER = new Date('2026-11-10T23:00:00.000Z');
const OVERNIGHT = new Date('2026-11-11T02:00:00.000Z');

type Row = {
  id: string;
  sourceType: string;
  sourceName: string;
  effectiveAt: Date;
  capturedAt: Date;
  price: Prisma.Decimal;
};
const row = (
  id: string,
  sourceName: string,
  effectiveAt: string,
  price = '101',
  capturedAt?: string,
): Row => ({
  id,
  sourceType: 'provider_api',
  sourceName,
  effectiveAt: new Date(effectiveAt),
  capturedAt: new Date(capturedAt ?? effectiveAt),
  price: new Prisma.Decimal(price),
});
// Yesterday's last regular-session price (the existing carry-forward).
const lastRegular = row('regular-1109', REGULAR, '2026-11-09T20:59:58.000Z');

function select(
  workflow: ProviderWorkflow,
  now: Date,
  candidates: Row[],
  freshnessThresholdSeconds = 300,
) {
  return selectMarketAwareAssetPriceSnapshotBySourcePriority({
    asset: us,
    workflow,
    candidates,
    expectedSourceNames: [REGULAR],
    now,
    freshnessThresholdSeconds,
    isPositiveValue: (candidate) => candidate.price.gt(0),
  });
}
const selectedId = (selection: ReturnType<typeof select>) =>
  selection.state === 'selected' ? selection.snapshot.id : null;

const DISPLAY_WORKFLOWS: ProviderWorkflow[] = [
  'assets_with_price',
  'home_live_valuation',
  'positions_live_valuation',
  'live_portfolio_valuation',
];

describe('US extended-hours price selection (2026-11-10)', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
    process.env.US_STOCK_EXTENDED_HOURS_PRICE_ENABLED = 'true';
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('never adds the extended source to any workflow eligibility', () => {
    for (const workflow of [
      ...DISPLAY_WORKFLOWS,
      'orders_quote',
      'orders_execute',
      'daily_portfolio_snapshot',
      'season_settlement',
    ] as ProviderWorkflow[]) {
      const eligibility = resolveAssetProviderEligibility({
        workflow,
        asset: { ...us, currencyCode: CurrencyCode.USD },
      });
      expect(eligibility).toMatchObject({ eligible: true });
      if (eligibility.eligible)
        expect(eligibility.sourceNames).toEqual([REGULAR]);
    }
  });

  it('shows the newest price of the current pre-market window in display and live valuation reads', () => {
    // 40 minutes old: extended trading is sparse; the window bounds it.
    const pre = row('pre-1', EXTENDED, '2026-11-10T10:20:00.000Z', '103.5');
    for (const workflow of DISPLAY_WORKFLOWS) {
      const selection = select(workflow, PRE, [pre, lastRegular]);
      expect(selectedId(selection)).toBe('pre-1');
      expect(selection.decision).toMatchObject({
        selectedSourceName: EXTENDED,
        fallbackUsed: false,
        freshnessAgeSeconds: 2400,
      });
    }
  });

  it('keeps the regular carry-forward for daily snapshots and every order workflow', () => {
    const pre = row('pre-1', EXTENDED, '2026-11-10T10:59:59.000Z');
    expect(
      selectedId(select('daily_portfolio_snapshot', PRE, [pre, lastRegular])),
    ).toBe('regular-1109');
    for (const workflow of ['orders_quote', 'orders_execute'] as const) {
      const selection = select(workflow, PRE, [pre, lastRegular], 10);
      expect(selection).toMatchObject({
        state: 'not_selected',
        decision: { rejectedProviderReason: 'market_closed' },
      });
    }
  });

  it('never shows an earlier window, a future row or a non-positive price', () => {
    // Yesterday's after-hours is not today's pre-market.
    const yesterdayAfter = row('after-1109', EXTENDED, '2026-11-09T23:30:00Z');
    const future = row('future', EXTENDED, '2026-11-10T11:00:01.000Z');
    const receivedLater = row(
      'received-later',
      EXTENDED,
      '2026-11-10T10:59:00.000Z',
      '101',
      '2026-11-10T11:00:05.000Z',
    );
    const zero = row('zero', EXTENDED, '2026-11-10T10:30:00.000Z', '0');
    for (const candidate of [yesterdayAfter, future, receivedLater, zero])
      expect(
        selectedId(select('assets_with_price', PRE, [candidate, lastRegular])),
      ).toBe('regular-1109');
  });

  it('uses after-hours prices only inside after-hours and drops them overnight', () => {
    const after = row('after-1', EXTENDED, '2026-11-10T22:10:00.000Z', '99');
    const lastRegularToday = row(
      'regular-1110',
      REGULAR,
      '2026-11-10T20:59:59Z',
    );
    expect(
      selectedId(select('assets_with_price', AFTER, [after, lastRegularToday])),
    ).toBe('after-1');
    // 20:00 New York: back to the regular close carry-forward.
    expect(
      selectedId(
        select('assets_with_price', OVERNIGHT, [after, lastRegularToday]),
      ),
    ).toBe('regular-1110');
  });

  it('never lets an extended price stand in during the regular session', () => {
    const openNow = new Date('2026-11-10T14:30:05.000Z');
    const lastPre = row('pre-last', EXTENDED, '2026-11-10T14:29:59.000Z');
    expect(select('assets_with_price', openNow, [lastPre])).toMatchObject({
      state: 'not_selected',
      decision: {
        rejectedProviderReason: 'effective_at_outside_current_session',
      },
    });
    const regular = row('regular-open', REGULAR, '2026-11-10T14:30:01.000Z');
    expect(
      selectedId(select('assets_with_price', openNow, [lastPre, regular])),
    ).toBe('regular-open');
  });

  it('is exactly the regular policy with the price switch off', () => {
    delete process.env.US_STOCK_EXTENDED_HOURS_PRICE_ENABLED;
    const pre = row('pre-1', EXTENDED, '2026-11-10T10:59:00.000Z');
    for (const workflow of DISPLAY_WORKFLOWS)
      expect(selectedId(select(workflow, PRE, [pre, lastRegular]))).toBe(
        'regular-1109',
      );
  });

  it('never touches KRX or crypto selection', () => {
    const krx = selectMarketAwareAssetPriceSnapshotBySourcePriority({
      asset: { assetType: AssetType.domestic_stock, market: 'KRX' },
      workflow: 'assets_with_price',
      candidates: [
        row('krx-ext', EXTENDED, '2026-11-10T11:00:00.000Z'),
        row('krx', 'koscom_krx_realtime_price', '2026-11-10T06:29:00.000Z'),
      ],
      expectedSourceNames: ['koscom_krx_realtime_price'],
      now: PRE,
      freshnessThresholdSeconds: 300,
      isPositiveValue: () => true,
    });
    expect(krx.state === 'selected' ? krx.snapshot.id : null).toBe('krx');
  });

  describe('execution evidence', () => {
    const window = resolveUsExtendedHoursWindow(us, PRE)!;
    const execute = (candidates: Row[], now = PRE) =>
      selectUsExtendedHoursExecutionSnapshot({
        candidates,
        window,
        now,
        freshnessThresholdSeconds: 10,
        isPositiveValue: (candidate) => candidate.price.gt(0),
      });

    it('takes a fresh extended price of the current window', () => {
      const fresh = row(
        'fresh',
        EXTENDED,
        '2026-11-10T10:59:55.000Z',
        '101',
        '2026-11-10T10:59:55.200Z',
      );
      expect(execute([fresh])).toMatchObject({
        state: 'selected',
        snapshot: { id: 'fresh' },
      });
    });

    it('refuses stale, regular, earlier-window and future evidence', () => {
      expect(
        execute([row('stale', EXTENDED, '2026-11-10T10:59:49.000Z')]),
      ).toMatchObject({
        state: 'not_selected',
        decision: { rejectedProviderReason: 'captured_at_stale' },
      });
      for (const candidate of [
        row('regular', REGULAR, '2026-11-10T10:59:58.000Z'),
        row('yesterday', EXTENDED, '2026-11-09T23:59:58.000Z'),
        row('future', EXTENDED, '2026-11-10T11:00:01.000Z'),
      ])
        expect(execute([candidate])).toMatchObject({
          state: 'not_selected',
          decision: {
            rejectedProviderReason:
              'effective_at_outside_extended_hours_window',
          },
        });
    });
  });

  describe('candidate reads', () => {
    function client() {
      const findMany = jest.fn(
        (args: { where: { sourceName?: string } }): Promise<Row[]> =>
          Promise.resolve(
            args.where.sourceName === EXTENDED
              ? [row('pre-1', EXTENDED, '2026-11-10T10:50:00.000Z')]
              : [lastRegular],
          ),
      );
      return { findMany, client: { assetPriceSnapshot: { findMany } } };
    }
    const read = (
      c: ReturnType<typeof client>,
      workflow: ProviderWorkflow,
      now = PRE,
    ) =>
      findMarketAwareAssetPriceCandidates(c.client as never, {
        asset: { ...us, id: 'asset-1', currencyCode: CurrencyCode.USD },
        workflow,
        now,
        sourceNames: [REGULAR],
      });

    it('adds one bounded read of the current window for display reads', async () => {
      const c = client();
      const candidates = await read(c, 'assets_with_price');
      expect(candidates.map((candidate) => candidate.id)).toEqual([
        'pre-1',
        'regular-1109',
      ]);
      const extendedRead = c.findMany.mock.calls
        .map(([args]) => args as { where: Record<string, unknown> })
        .find((args) => args.where.sourceName === EXTENDED);
      expect(extendedRead?.where).toMatchObject({
        assetId: 'asset-1',
        effectiveAt: {
          gte: new Date('2026-11-10T09:00:00.000Z'),
          lte: PRE,
        },
        capturedAt: { lte: PRE },
        price: { gt: 0 },
      });
    });

    it('adds nothing for daily snapshots, overnight, or with the switch off', async () => {
      for (const [workflow, now] of [
        ['daily_portfolio_snapshot', PRE],
        ['assets_with_price', OVERNIGHT],
      ] as const) {
        const c = client();
        await read(c, workflow, now);
        expect(
          c.findMany.mock.calls.some(
            ([args]) =>
              (args as { where: { sourceName?: string } }).where.sourceName ===
              EXTENDED,
          ),
        ).toBe(false);
      }
      delete process.env.US_STOCK_EXTENDED_HOURS_PRICE_ENABLED;
      const off = client();
      await read(off, 'assets_with_price');
      expect(off.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
