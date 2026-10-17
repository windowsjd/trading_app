/**
 * Read-only audit of the stored chart history of every active stock (KRX and
 * US) against the app's chart windows: 5m/15m/30m/1h = previous 3/6/12/24
 * sessions of stored 5m, 4h = previous 96 sessions, 1d = previous 576
 * sessions (2026-10-17 expansion, report §10.3). Reads stored candles only:
 * no provider call, no write. A US row counts only from the current US
 * provider, so run it with the server's `US_STOCK_PRICE_PROVIDER`.
 *
 * Usage (from backend/; pin DATABASE_URL — .env.local may point at Render):
 *   DATABASE_URL=... US_STOCK_PRICE_PROVIDER=tiingo \
 *     pnpm exec tsx scripts/stock-chart-history-audit.ts [--market krx|us] \
 *     [--asset-id <uuid> ...] [--json <file>] \
 *     [--us-intraday-history-from YYYY-MM-DD]
 *
 * `--us-intraday-history-from` is the oldest US session with full Tiingo 5m
 * bars as MEASURED by `smoke:tiingo-official` (historyDepth.intradayHistoryReach);
 * older US 5m/4h gaps are then reported as `limited_by_provider`. Without it
 * they stay `incomplete` (a provider limit is never assumed).
 *
 * Prints one summary line per market and chart, then every window that is
 * not complete. Exit code 0 when every window is complete or limited
 * (listing, KRX collection start, measured provider depth), 1 when any is
 * incomplete or reaches a date without calendar data, 2 on usage.
 */
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';

loadRuntimeEnv();

import { PrismaService } from '../src/prisma/prisma.service';
import { MarketSessionOverrideLoaderService } from '../src/orders/market-calendar/market-session-override.loader.service';
import { getMarketSessionOverrideRuntimeStatus } from '../src/orders/market-calendar/market-session-override.store';
import { readUsStockPriceProvider } from '../src/providers/us-stock-price-provider.config';
import {
  STOCK_CHART_HISTORY_WINDOWS,
  StockChartHistoryAudit,
} from '../src/assets/stock-chart-history-audit';

type Args = {
  markets: ('KRX' | 'US')[] | undefined;
  assetIds: string[] | undefined;
  json: string | null;
  usIntradayHistoryFrom: string | undefined;
};

export function parseStockChartHistoryAuditArgs(
  argv: readonly string[],
): Args | null {
  const markets: ('KRX' | 'US')[] = [];
  const assetIds: string[] = [];
  let json: string | null = null;
  let usIntradayHistoryFrom: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    if (flag === '--market') {
      const market = value.toUpperCase();
      if (market !== 'KRX' && market !== 'US') return null;
      if (!markets.includes(market)) markets.push(market);
    } else if (flag === '--asset-id') assetIds.push(value);
    else if (flag === '--json') json = value;
    else if (flag === '--us-intraday-history-from') {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
      usIntradayHistoryFrom = value;
    } else return null;
  }
  return {
    markets: markets.length ? markets : undefined,
    assetIds: assetIds.length ? assetIds : undefined,
    json,
    usIntradayHistoryFrom,
  };
}

async function main(): Promise<number> {
  const args = parseStockChartHistoryAuditArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      'usage: stock-chart-history-audit [--market krx|us] [--asset-id <uuid> ...] [--json <file>] [--us-intraday-history-from YYYY-MM-DD]',
    );
    return 2;
  }
  requireDatabaseUrl();
  console.log(`database: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);
  const usProvider = readUsStockPriceProvider();
  console.log(`US rows counted from provider: ${usProvider}`);
  if (usProvider !== 'tiingo')
    console.warn(
      'warning: US_STOCK_PRICE_PROVIDER is not tiingo; US windows are judged on non-Tiingo rows.',
    );
  const prisma = new PrismaService();
  const calendarLoader = new MarketSessionOverrideLoaderService(prisma);
  try {
    await prisma.$connect();
    // Same calendar the read path uses (operator overrides included).
    await calendarLoader.onModuleInit();
    if (getMarketSessionOverrideRuntimeStatus().state !== 'ready')
      throw new Error(
        'Initial market-session override load failed (calendar_unavailable); the audit did not run.',
      );
    const report = await new StockChartHistoryAudit(prisma, {
      usIntradayHistoryFrom: args.usIntradayHistoryFrom,
    }).run({
      now: new Date(),
      markets: args.markets,
      assetIds: args.assetIds,
    });
    if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
    for (const market of ['KRX', 'US'] as const) {
      const count = report.assets.filter((a) => a.market === market).length;
      if (count === 0) continue;
      for (const { chart, sessions } of STOCK_CHART_HISTORY_WINDOWS) {
        const cell = report.summary[market][chart];
        console.log(
          [
            market.padEnd(4),
            `${chart.padEnd(3)} (${String(sessions).padStart(3)} sessions)`,
            `assets=${count}`,
            `complete=${cell.complete}`,
            `limitedByListing=${cell.limitedByListing}`,
            `limitedByCollectionStart=${cell.limitedByCollectionStart}`,
            `limitedByProvider=${cell.limitedByProvider}`,
            `incomplete=${cell.incomplete}`,
            `calendarUnavailable=${cell.calendarUnavailable}`,
          ].join(' '),
        );
      }
    }
    for (const asset of report.assets)
      for (const window of asset.windows) {
        if (window.state === 'complete') continue;
        console.log(
          [
            window.state.padEnd(20),
            asset.market.padEnd(4),
            asset.symbol.padEnd(8),
            window.chart.padEnd(3),
            `covered=${window.sessionsCovered}/${window.sessionsExpected}`,
            `first=${window.firstCoveredSession ?? '-'}`,
            `leadingMissing=${window.leadingMissing.count}`,
            `interiorMissing=${window.interiorMissing.count}`,
            `unexplained=${window.unexplained.count}`,
            window.unexplained.dates.length
              ? `defects=${window.unexplained.dates.join(',')}`
              : '',
            asset.listedOn ? `listedOn=${asset.listedOn}` : '',
            asset.collectionStart
              ? `collectionStart=${asset.collectionStart}`
              : '',
          ].join(' '),
        );
      }
    console.log(`\npass=${report.pass}`);
    return report.pass ? 0 : 1;
  } finally {
    await calendarLoader.onModuleDestroy();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
