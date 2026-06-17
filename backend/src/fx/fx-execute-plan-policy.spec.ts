jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import type { NormalizedFxExecuteRequest } from './fx-execute-request-policy';
import {
  buildFxExecutePlan,
  type FxExecuteSnapshotWithId,
  type FxExecuteWalletCandidate,
} from './fx-execute-plan-policy';

describe('fx execute plan policy', () => {
  const executeNow = new Date('2026-05-01T00:01:00.000Z');
  const capturedAt = new Date('2026-05-01T00:00:31.000Z');
  const effectiveAt = new Date('2026-05-01T00:00:30.000Z');
  const createdAt = new Date('2026-05-01T00:00:32.000Z');

  const krwUsdRequest: NormalizedFxExecuteRequest = {
    userId: 'user-1',
    seasonParticipantId: 'participant-1',
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '135000.00000000',
    idempotencyKey: 'idempotency-key-1',
    requestHash: 'request-hash-1',
  };

  const usdKrwRequest: NormalizedFxExecuteRequest = {
    ...krwUsdRequest,
    fromCurrency: 'USD',
    toCurrency: 'KRW',
    sourceAmount: '100.00000000',
  };

  const wallet = (
    id: string,
    currencyCode: 'KRW' | 'USD',
    balanceAmount: string | Prisma.Decimal,
    seasonParticipantId = 'participant-1',
  ): FxExecuteWalletCandidate => ({
    id,
    seasonParticipantId,
    currencyCode,
    balanceAmount,
  });

  const snapshot = (
    id: string,
    overrides: Partial<FxExecuteSnapshotWithId> = {},
  ): FxExecuteSnapshotWithId => ({
    id,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    sourceType: FxRateSourceType.admin_manual,
    rate: '1350.00000000',
    effectiveAt,
    capturedAt,
    createdAt,
    ...overrides,
  });

  const buildPlan = (
    overrides: Partial<Parameters<typeof buildFxExecutePlan>[0]> = {},
  ) =>
    buildFxExecutePlan({
      request: krwUsdRequest,
      sourceWallet: wallet('krw-wallet-1', 'KRW', '200000.00000000'),
      targetWallet: wallet('usd-wallet-1', 'USD', '10.00000000'),
      snapshots: [snapshot('snapshot-1')],
      fxFeeRate: '0.001000',
      executeNow,
      ...overrides,
    });

  const expectErrorCode = (
    overrides: Partial<Parameters<typeof buildFxExecutePlan>[0]>,
    errorCode: string,
  ) => {
    expect(buildPlan(overrides)).toEqual({
      ok: false,
      errorCode,
    });
  };

  it('creates a KRW to USD execute plan candidate', () => {
    const result = buildPlan();

    expect(result).toEqual({
      ok: true,
      value: {
        userId: 'user-1',
        seasonParticipantId: 'participant-1',
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceWalletId: 'krw-wallet-1',
        targetWalletId: 'usd-wallet-1',
        sourceAmount: '135000.00000000',
        grossTargetAmount: '100.00000000',
        feeRate: '0.001000',
        feeAmount: '0.10000000',
        feeCurrency: 'USD',
        appliedRate: '1350.00000000',
        netTargetAmount: '99.90000000',
        targetCreditAmount: '99.90000000',
        sourceDebitAmount: '135000.00000000',
        fxRateSnapshotId: 'snapshot-1',
        rateCapturedAt: capturedAt,
        rateEffectiveAt: effectiveAt,
        requestHash: 'request-hash-1',
        idempotencyKey: 'idempotency-key-1',
      },
    });
  });

  it('creates a USD to KRW execute plan candidate', () => {
    const result = buildPlan({
      request: usdKrwRequest,
      sourceWallet: wallet('usd-wallet-1', 'USD', '100.00000000'),
      targetWallet: wallet('krw-wallet-1', 'KRW', '0.00000000'),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        fromCurrency: 'USD',
        toCurrency: 'KRW',
        sourceAmount: '100.00000000',
        grossTargetAmount: '135000.00000000',
        feeRate: '0.001000',
        feeAmount: '135.00000000',
        feeCurrency: 'KRW',
        netTargetAmount: '134865.00000000',
        targetCreditAmount: '134865.00000000',
        sourceDebitAmount: '100.00000000',
        appliedRate: '1350.00000000',
      },
    });
  });

  it('omits write-time only identifiers and balances from the plan', () => {
    const result = buildPlan();

    expect(result).toMatchObject({ ok: true });

    if (result.ok) {
      expect(result.value).not.toHaveProperty('balanceAfter');
      expect(result.value).not.toHaveProperty('quoteId');
      expect(result.value).not.toHaveProperty('expiresAt');
      expect(result.value).not.toHaveProperty('exchangeId');
    }
  });

  it.each([
    ['source null', { sourceWallet: null }, 'SOURCE_WALLET_NOT_FOUND'],
    ['target null', { targetWallet: null }, 'TARGET_WALLET_NOT_FOUND'],
    [
      'source participant mismatch',
      {
        sourceWallet: wallet(
          'krw-wallet-1',
          'KRW',
          '200000.00000000',
          'other-participant',
        ),
      },
      'SOURCE_WALLET_NOT_FOUND',
    ],
    [
      'target participant mismatch',
      {
        targetWallet: wallet(
          'usd-wallet-1',
          'USD',
          '10.00000000',
          'other-participant',
        ),
      },
      'TARGET_WALLET_NOT_FOUND',
    ],
    [
      'source currency mismatch',
      { sourceWallet: wallet('usd-wallet-1', 'USD', '200000.00000000') },
      'SOURCE_WALLET_NOT_FOUND',
    ],
    [
      'target currency mismatch',
      { targetWallet: wallet('krw-wallet-1', 'KRW', '10.00000000') },
      'TARGET_WALLET_NOT_FOUND',
    ],
  ])('maps wallet validation failure: %s', (_label, overrides, errorCode) => {
    expectErrorCode(overrides, errorCode);
  });

  it('returns FX_RATE_UNAVAILABLE when there is no eligible snapshot', () => {
    expectErrorCode({ snapshots: [] }, 'FX_RATE_UNAVAILABLE');
  });

  it('ignores disallowed sourceType snapshots', () => {
    expectErrorCode(
      {
        snapshots: [
          snapshot('provider', { sourceType: FxRateSourceType.provider_api }),
          snapshot('official', { sourceType: FxRateSourceType.official_batch }),
        ],
      },
      'FX_RATE_UNAVAILABLE',
    );
  });

  it('ignores future effectiveAt snapshots', () => {
    expectErrorCode(
      {
        snapshots: [
          snapshot('future', {
            effectiveAt: new Date('2026-05-01T00:01:00.001Z'),
          }),
        ],
      },
      'FX_RATE_UNAVAILABLE',
    );
  });

  it('ignores non-positive rate snapshots', () => {
    expectErrorCode(
      {
        snapshots: [
          snapshot('zero', { rate: '0.00000000' }),
          snapshot('negative', { rate: '-1.00000000' }),
        ],
      },
      'FX_RATE_UNAVAILABLE',
    );
  });

  it('returns FX_RATE_STALE when the selected snapshot is older than 60 seconds', () => {
    expectErrorCode(
      {
        snapshots: [
          snapshot('stale', {
            effectiveAt: new Date('2026-04-30T23:59:59.999Z'),
          }),
        ],
      },
      'FX_RATE_STALE',
    );
  });

  it('accepts a selected snapshot exactly at the 60 second freshness boundary', () => {
    const result = buildPlan({
      snapshots: [
        snapshot('threshold', {
          effectiveAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        fxRateSnapshotId: 'threshold',
        rateEffectiveAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    });
  });

  it('selects the latest eligible snapshot by effectiveAt, capturedAt, and createdAt', () => {
    const first = snapshot('first', {
      effectiveAt: new Date('2026-05-01T00:00:30.000Z'),
      capturedAt: new Date('2026-05-01T00:00:31.000Z'),
      createdAt: new Date('2026-05-01T00:00:33.000Z'),
      rate: '1300.00000000',
    });
    const second = snapshot('second', {
      effectiveAt: new Date('2026-05-01T00:00:50.000Z'),
      capturedAt: new Date('2026-05-01T00:00:50.000Z'),
      createdAt: new Date('2026-05-01T00:00:50.000Z'),
      rate: '1400.00000000',
    });
    const third = snapshot('third', {
      effectiveAt: new Date('2026-05-01T00:00:50.000Z'),
      capturedAt: new Date('2026-05-01T00:00:51.000Z'),
      createdAt: new Date('2026-05-01T00:00:49.000Z'),
      rate: '1500.00000000',
    });
    const fourth = snapshot('fourth', {
      effectiveAt: new Date('2026-05-01T00:00:50.000Z'),
      capturedAt: new Date('2026-05-01T00:00:51.000Z'),
      createdAt: new Date('2026-05-01T00:00:52.000Z'),
      rate: '1600.00000000',
    });
    const result = buildPlan({
      snapshots: [first, second, third, fourth],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        fxRateSnapshotId: 'fourth',
        appliedRate: '1600.00000000',
        rateCapturedAt: fourth.capturedAt,
        rateEffectiveAt: fourth.effectiveAt,
      },
    });
  });

  it('keeps USD/KRW as the only eligible snapshot source pair', () => {
    const result = buildPlan({
      snapshots: [
        snapshot('krw-usd', {
          baseCurrency: CurrencyCode.KRW,
          quoteCurrency: CurrencyCode.USD,
        }),
        snapshot('usd-krw'),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        fxRateSnapshotId: 'usd-krw',
      },
    });
  });

  it.each([
    ['equal', '135000.00000000'],
    ['greater', '135000.00000001'],
  ])('accepts source balance %s to sourceAmount', (_label, balanceAmount) => {
    expect(
      buildPlan({
        sourceWallet: wallet('krw-wallet-1', 'KRW', balanceAmount),
      }),
    ).toMatchObject({ ok: true });
  });

  it('returns INSUFFICIENT_BALANCE when source balance is less than sourceAmount', () => {
    expectErrorCode(
      {
        sourceWallet: wallet('krw-wallet-1', 'KRW', '134999.99999999'),
      },
      'INSUFFICIENT_BALANCE',
    );
  });

  it.each([
    ['invalid', 'not-a-decimal'],
    ['non-finite', 'Infinity'],
  ])('throws clearly for %s source wallet balance', (_label, balanceAmount) => {
    expect(() =>
      buildPlan({
        sourceWallet: wallet('krw-wallet-1', 'KRW', balanceAmount),
      }),
    ).toThrow('sourceWallet.balanceAmount must be a finite decimal');
  });

  it('calculates KRW to USD exact division', () => {
    expect(buildPlan()).toMatchObject({
      ok: true,
      value: {
        grossTargetAmount: '100.00000000',
      },
    });
  });

  it('calculates KRW to USD repeating decimal at scale 8', () => {
    const result = buildPlan({
      request: {
        ...krwUsdRequest,
        sourceAmount: '1000.00000000',
      },
      sourceWallet: wallet('krw-wallet-1', 'KRW', '1000.00000000'),
      snapshots: [snapshot('snapshot-1', { rate: '3.00000000' })],
      fxFeeRate: '0.000000',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        grossTargetAmount: '333.33333333',
        feeAmount: '0.00000000',
        netTargetAmount: '333.33333333',
      },
    });
  });

  it('calculates USD to KRW multiplication', () => {
    expect(
      buildPlan({
        request: usdKrwRequest,
        sourceWallet: wallet('usd-wallet-1', 'USD', '100.00000000'),
        targetWallet: wallet('krw-wallet-1', 'KRW', '0.00000000'),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        grossTargetAmount: '135000.00000000',
      },
    });
  });

  it('rounds feeAmount half-up and derives netTargetAmount from gross minus fee', () => {
    const request: NormalizedFxExecuteRequest = {
      ...usdKrwRequest,
      sourceAmount: '0.00000500',
    };
    const result = buildPlan({
      request,
      sourceWallet: wallet('usd-wallet-1', 'USD', '0.00000500'),
      targetWallet: wallet('krw-wallet-1', 'KRW', '0.00000000'),
      snapshots: [snapshot('snapshot-1', { rate: '1.00000000' })],
      fxFeeRate: '0.001000',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        grossTargetAmount: '0.00000500',
        feeAmount: '0.00000001',
        netTargetAmount: '0.00000499',
        targetCreditAmount: '0.00000499',
      },
    });
  });

  it('avoids JS number precision drift by using Decimal strings', () => {
    const result = buildPlan({
      request: {
        ...krwUsdRequest,
        sourceAmount: '9007199254740993.00000000',
      },
      sourceWallet: wallet('krw-wallet-1', 'KRW', '9007199254740993.00000000'),
      snapshots: [snapshot('snapshot-1', { rate: '3.00000000' })],
      fxFeeRate: '0.000000',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        grossTargetAmount: '3002399751580331.00000000',
        netTargetAmount: '3002399751580331.00000000',
      },
    });
  });

  it('does not require PrismaService or DB access', () => {
    expect(buildPlan()).toMatchObject({ ok: true });
  });

  it('does not mutate input arrays or wallet objects', () => {
    const sourceWallet = wallet('krw-wallet-1', 'KRW', '200000.00000000');
    const targetWallet = wallet('usd-wallet-1', 'USD', '10.00000000');
    const snapshots = [snapshot('older'), snapshot('newer')];
    const originalSnapshots = snapshots.slice();
    const originalSourceWallet = { ...sourceWallet };
    const originalTargetWallet = { ...targetWallet };

    buildPlan({
      sourceWallet,
      targetWallet,
      snapshots,
    });

    expect(snapshots).toEqual(originalSnapshots);
    expect(sourceWallet).toEqual(originalSourceWallet);
    expect(targetWallet).toEqual(originalTargetWallet);
  });

  it('does not create exchange, wallet transaction, or execute request rows', () => {
    const result = buildPlan();

    expect(result).toMatchObject({ ok: true });

    if (result.ok) {
      expect(result.value).not.toHaveProperty('exchangeTransaction');
      expect(result.value).not.toHaveProperty('walletTransaction');
      expect(result.value).not.toHaveProperty('fxExecuteRequest');
    }
  });
});
