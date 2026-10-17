jest.mock('../../generated/prisma/client', () => ({
  AssetType: { domestic_stock: 'domestic_stock', us_stock: 'us_stock' },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  PrismaClient: class PrismaClient {},
}));

import {
  EXPANSION_2026_10_17,
  FIRST_PHASE_UNIVERSE,
  KIS_FIXED_ASSET_UNIVERSE,
  KIS_FIXED_DOMESTIC_SYMBOLS,
  KIS_FIXED_US_SYMBOLS,
} from './kis-fixed-asset-universe';
import { buildProviderConfig } from '../provider-config.service';
import {
  TIINGO_DEFAULT_OFFICIAL_SYMBOLS,
  TIINGO_MAX_OFFICIAL_SYMBOLS,
  fromTiingoTicker,
  readTiingoConfig,
  toTiingoTicker,
} from '../tiingo/tiingo.config';
import { planAssetUniverseUpserts } from '../../../scripts/lib/asset-universe-upsert';
import { buildKisDesiredUniverse } from '../../../scripts/seed-kis-fixed-asset-universe';

const domestic = (list: typeof KIS_FIXED_ASSET_UNIVERSE) =>
  list.filter((entry) => entry.assetType === 'domestic_stock');
const us = (list: typeof KIS_FIXED_ASSET_UNIVERSE) =>
  list.filter((entry) => entry.assetType === 'us_stock');

describe('fixed stock universe (2026-10-17: US 100, KRX 70)', () => {
  it('keeps the first phase and appends 55 domestic + 75 US stocks', () => {
    expect(domestic(FIRST_PHASE_UNIVERSE)).toHaveLength(15);
    expect(us(FIRST_PHASE_UNIVERSE)).toHaveLength(25);
    expect(domestic(EXPANSION_2026_10_17)).toHaveLength(55);
    expect(us(EXPANSION_2026_10_17)).toHaveLength(75);
    expect(domestic(KIS_FIXED_ASSET_UNIVERSE)).toHaveLength(70);
    expect(us(KIS_FIXED_ASSET_UNIVERSE)).toHaveLength(100);
    // Append-only: the first phase is the unchanged head, in its order.
    expect(KIS_FIXED_ASSET_UNIVERSE.slice(0, 40)).toEqual(FIRST_PHASE_UNIVERSE);
    expect(FIRST_PHASE_UNIVERSE.map((entry) => entry.symbol)).toEqual([
      '005930',
      '000660',
      '034020',
      '010140',
      '042660',
      '005380',
      '000270',
      '035420',
      '035720',
      '068270',
      '051910',
      '066570',
      '086520',
      '247540',
      '028300',
      'NVDA',
      'TSLA',
      'AMD',
      'AAPL',
      'AMZN',
      'MSFT',
      'GOOGL',
      'META',
      'PLTR',
      'INTC',
      'SOFI',
      'RIVN',
      'MARA',
      'WBD',
      'CSCO',
      'MU',
      'QCOM',
      'PYPL',
      'MSTR',
      'SMCI',
      'F',
      'BAC',
      'PFE',
      'T',
      'UBER',
    ]);
  });

  it('never registers one security twice', () => {
    const keys = KIS_FIXED_ASSET_UNIVERSE.map((e) => `${e.market}:${e.symbol}`);
    expect(new Set(keys).size).toBe(keys.length);
    // A US ticker is unique across NAS/NYS too (Tiingo maps by ticker).
    const usSymbols = us(KIS_FIXED_ASSET_UNIVERSE).map((e) => e.symbol);
    expect(new Set(usSymbols).size).toBe(usSymbols.length);
  });

  it('maps every domestic stock to a six-digit KRX code in KRW', () => {
    for (const entry of domestic(KIS_FIXED_ASSET_UNIVERSE)) {
      expect(entry.symbol).toMatch(/^\d{6}$/u);
      expect(entry.kisSymbol).toBe(entry.symbol);
      expect(entry.market).toBe('KRX');
      expect(entry.currencyCode).toBe('KRW');
      expect(entry.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('maps every US stock to its NAS/NYS listing, a Tiingo ticker and USD', () => {
    for (const entry of us(KIS_FIXED_ASSET_UNIVERSE)) {
      expect(['NAS', 'NYS']).toContain(entry.market);
      expect(entry.kisSymbol).toBe(`${entry.market}:${entry.symbol}`);
      expect(entry.currencyCode).toBe('USD');
      expect(entry.symbol).toMatch(/^[A-Z][A-Z0-9.]{0,9}$/u);
      expect(fromTiingoTicker(toTiingoTicker(entry.symbol))).toBe(entry.symbol);
      expect(entry.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('records listing dates as calendar dates only', () => {
    for (const entry of KIS_FIXED_ASSET_UNIVERSE)
      if (entry.listedOn !== undefined)
        expect(entry.listedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('serves the whole US universe from Tiingo by default (official mode)', () => {
    expect([...TIINGO_DEFAULT_OFFICIAL_SYMBOLS]).toEqual(
      us(KIS_FIXED_ASSET_UNIVERSE).map((entry) => entry.symbol),
    );
    expect(TIINGO_DEFAULT_OFFICIAL_SYMBOLS.length).toBeLessThanOrEqual(
      TIINGO_MAX_OFFICIAL_SYMBOLS,
    );
    const config = readTiingoConfig({
      TIINGO_ENABLED: 'true',
      TIINGO_TRIAL_MODE: 'false',
      TIINGO_API_TOKEN: 'synthetic',
      RENDER: 'true',
    });
    expect(config.configError).toBeNull();
    expect(config.allowedSymbols).toHaveLength(100);
  });

  it('keeps the KIS runtime defaults on the first phase, inside the 41-symbol watchlist cap', () => {
    expect(KIS_FIXED_DOMESTIC_SYMBOLS).toHaveLength(15);
    expect(KIS_FIXED_US_SYMBOLS).toEqual(
      us(FIRST_PHASE_UNIVERSE).map((entry) => entry.kisSymbol),
    );
    // Every provider-config read builds the KIS watchlist: it must not throw.
    expect(() => buildProviderConfig({})).not.toThrow();
    expect(buildProviderConfig({}).kis.usSymbols).toHaveLength(25);
  });

  it('seeds idempotently: existing rows keep their IDs, a rerun changes nothing', () => {
    const desired = buildKisDesiredUniverse();
    expect(desired).toHaveLength(170);
    const existingFirstPhase = desired.slice(0, 40).map((row, index) => ({
      ...row,
      id: `existing-${index}`,
      isActive: true,
    }));
    const firstRun = planAssetUniverseUpserts(desired, existingFirstPhase);
    expect(firstRun.creates).toHaveLength(130);
    expect(firstRun.updates).toHaveLength(0);
    expect(firstRun.unchanged.map((row) => row.existingId)).toEqual(
      existingFirstPhase.map((row) => row.id),
    );
    const allExisting = desired.map((row, index) => ({
      ...row,
      id: `row-${index}`,
      isActive: true,
    }));
    const rerun = planAssetUniverseUpserts(desired, allExisting);
    expect(rerun.creates).toHaveLength(0);
    expect(rerun.updates).toHaveLength(0);
    expect(rerun.unchanged).toHaveLength(170);
  });
});
