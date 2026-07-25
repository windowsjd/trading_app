import 'reflect-metadata';
import { WebSocket as WsWebSocket } from 'ws';
import { ProviderConfigService } from '../src/providers/provider-config.service';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import {
  BINANCE_FIXED_ASSET_UNIVERSE,
  BINANCE_FIXED_SYMBOLS,
} from '../src/providers/binance/binance-fixed-asset-universe';
import {
  type BinanceExchangeInfoResponse,
  validateBinanceSpotUniverse,
} from '../src/providers/binance/binance-exchange-info.validation';
import { readBinanceSymbolPricePrecision } from '../src/providers/binance/binance-tick-size';
import { loadRuntimeEnv } from './lib/load-runtime-env';

/**
 * Opt-in real Binance public market-data smoke for the fixed 10-symbol universe.
 *
 *   BINANCE_MARKET_DATA_SMOKE=1 pnpm smoke:binance-fixed-universe
 *
 * READ-ONLY: it calls the public Spot REST + WebSocket APIs only. It never
 * touches the database (no reads, writes, resets), needs no API key, and is
 * refused under NODE_ENV=production. Without the env flag it reports NOT_RUN and
 * exits 0 (never a fake pass). It verifies:
 *   1. exchangeInfo TRADING/Spot/USDT for all 10,
 *   1b. exchangeInfo PRICE_FILTER.tickSize matches the declared display decimals,
 *   2. REST 24hr ticker returns a positive price for all 10,
 *   3. the WS ticker stream delivers at least one tick per symbol within a bound.
 */

const WS_RECEIVE_BUDGET_MS = 15_000;

async function main() {
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    console.error(
      'binance-fixed-universe-smoke is not allowed under NODE_ENV=production.',
    );
    process.exitCode = 1;
    return;
  }
  if (process.env.BINANCE_MARKET_DATA_SMOKE !== '1') {
    console.log(
      'binance-fixed-universe-smoke: NOT_RUN (set BINANCE_MARKET_DATA_SMOKE=1 to run)',
    );
    return;
  }

  loadRuntimeEnv();
  // Only the (gate-independent) REST/WS base URLs are needed; all calls below
  // hit public endpoints directly, so the smoke never depends on the ingestion
  // gates being enabled.
  const config = new ProviderConfigService().getBinanceConfig();
  const restBaseUrl = config.restBaseUrl.replace(/\/+$/u, '');
  console.log(`Binance REST base: ${restBaseUrl}`);
  console.log(`Binance WS base:   ${config.wsMarketDataBaseUrl}`);
  console.log(
    `Symbols (${BINANCE_FIXED_SYMBOLS.length}): ${BINANCE_FIXED_SYMBOLS.join(', ')}`,
  );

  const httpClient = new ProviderHttpClient();

  // 1) exchangeInfo.
  const exchangeInfo = await httpClient.getJson<BinanceExchangeInfoResponse>(
    `${restBaseUrl}/api/v3/exchangeInfo`,
    { provider: 'binance', timeoutMs: 15_000 },
  );
  const validation = validateBinanceSpotUniverse(
    BINANCE_FIXED_ASSET_UNIVERSE.map((e) => ({
      symbol: e.symbol,
      baseAsset: e.baseAsset,
    })),
    exchangeInfo.json,
  );
  console.log(
    `exchangeInfo: ${validation.ok ? 'OK' : 'FAIL'} (${BINANCE_FIXED_SYMBOLS.length - validation.failures.length}/${BINANCE_FIXED_SYMBOLS.length})`,
  );
  for (const failure of validation.failures) {
    console.error(
      `  x ${failure.symbol}: ${failure.reason} ${failure.detail ?? ''}`,
    );
  }

  // 1b) PRICE_FILTER.tickSize vs the reviewed fixed-universe fallback. The app
  // prefers the live value at runtime; this catches drift in the constant that
  // serves display decimals whenever exchangeInfo is unreachable.
  const livePrecision = new Map(
    readBinanceSymbolPricePrecision(exchangeInfo.json).map((entry) => [
      entry.symbol,
      entry,
    ]),
  );
  let tickSizeOk = 0;
  for (const entry of BINANCE_FIXED_ASSET_UNIVERSE) {
    const live = livePrecision.get(entry.symbol);
    if (!live) {
      console.error(
        `  x tickSize ${entry.symbol}: no PRICE_FILTER in response`,
      );
      continue;
    }
    if (live.displayPriceDecimals !== entry.displayPriceDecimals) {
      console.error(
        `  x tickSize ${entry.symbol}: live ${live.priceTickSize} (${live.displayPriceDecimals}d) != declared ${entry.priceTickSize} (${entry.displayPriceDecimals}d)`,
      );
      continue;
    }
    tickSizeOk += 1;
  }
  console.log(
    `tickSize display decimals: ${tickSizeOk}/${BINANCE_FIXED_SYMBOLS.length}`,
  );

  // 2) REST 24hr ticker per symbol (public endpoint, no gates).
  let restOk = 0;
  for (const symbol of BINANCE_FIXED_SYMBOLS) {
    try {
      const { json } = await httpClient.getJson<{
        lastPrice?: string;
        price?: string;
      }>(
        `${restBaseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`,
        {
          provider: 'binance',
          timeoutMs: 15_000,
        },
      );
      const price = Number(json.lastPrice ?? json.price);
      if (Number.isFinite(price) && price > 0) {
        restOk += 1;
      } else {
        console.error(`  x REST ${symbol}: non-positive price`);
      }
    } catch (error) {
      console.error(
        `  x REST ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`REST 24hr ticker: ${restOk}/${BINANCE_FIXED_SYMBOLS.length}`);

  // 3) WS ticker: at least one tick per symbol within the budget.
  const wsReceived = await collectWsTickerSymbols(config.wsMarketDataBaseUrl);
  const wsOk = BINANCE_FIXED_SYMBOLS.filter((s) => wsReceived.has(s)).length;
  console.log(`WS ticker received: ${wsOk}/${BINANCE_FIXED_SYMBOLS.length}`);
  for (const symbol of BINANCE_FIXED_SYMBOLS) {
    if (!wsReceived.has(symbol))
      console.error(
        `  x WS ${symbol}: no tick within ${WS_RECEIVE_BUDGET_MS}ms`,
      );
  }

  const pass =
    validation.ok &&
    tickSizeOk === BINANCE_FIXED_SYMBOLS.length &&
    restOk === BINANCE_FIXED_SYMBOLS.length &&
    wsOk === BINANCE_FIXED_SYMBOLS.length;
  console.log(`\nbinance-fixed-universe-smoke: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

function collectWsTickerSymbols(wsBaseUrl: string): Promise<Set<string>> {
  const base = wsBaseUrl.replace(/\/+$/u, '');
  const streams = BINANCE_FIXED_SYMBOLS.map(
    (s) => `${s.toLowerCase()}@ticker`,
  ).join('/');
  const url = `${base}/stream?streams=${streams}`;
  const received = new Set<string>();

  return new Promise((resolve) => {
    const socket = new WsWebSocket(url);
    const done = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve(received);
    };
    const timer = setTimeout(done, WS_RECEIVE_BUDGET_MS);
    socket.on('message', (data: Buffer) => {
      try {
        const frame = JSON.parse(data.toString('utf8')) as {
          data?: { e?: string; s?: string };
        };
        if (
          frame.data?.e === '24hrTicker' &&
          typeof frame.data.s === 'string'
        ) {
          received.add(frame.data.s.toUpperCase());
          if (received.size >= BINANCE_FIXED_SYMBOLS.length) done();
        }
      } catch {
        // ignore malformed frames
      }
    });
    socket.on('error', () => done());
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error(
      `binance-fixed-universe-smoke failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
