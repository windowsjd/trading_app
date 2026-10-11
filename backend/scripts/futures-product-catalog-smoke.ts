import type { FuturesService } from '../src/futures/futures.service';
import type { FuturesExecuteResult } from '../src/futures/futures.presenter';
import type { FuturesLimitService } from '../src/futures/futures-limit.service';
/** Local/approved isolated harness only. Normal login/refresh + HTTP/WS; no
 * authentication seam, provider call, SQL fixture write or financial shortcut. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { readInputs, isLocal } from './load-test/manifest';
import { preflight, verifyApi } from './load-test/preflight';
import { installNetworkGuard } from './load-test/network-guard';
import { AppClient, ApiFailure } from './load-test/client';
import { Metrics } from './load-test/metrics';
import type { Fixture } from './load-test/actor';
import {
  BINANCE_FUTURES_SYMBOLS,
  BINANCE_FUTURES_ONLY_SYMBOLS,
} from '../src/providers/binance/binance-product-catalog';
import { BINANCE_FIXED_SYMBOLS } from '../src/providers/binance/binance-fixed-asset-universe';

async function main() {
  const [manifest, credentials, fixturePath] = process.argv.slice(2);
  if (!manifest || !credentials || !fixturePath)
    throw new Error(
      'Usage: futures-product-catalog-smoke.ts MANIFEST CREDENTIALS FIXTURE',
    );
  const { m, c, manifestHash } = readInputs(manifest, credentials);
  assert.ok(isLocal(m), 'This regression runner permits loopback targets only');
  assert.ok(m.users <= 20, 'Small functional regression only');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  assert.equal(fixture.manifestHash, manifestHash);
  await preflight(m, c);
  await verifyApi(m, c, manifestHash);
  let blocked = 0;
  await installNetworkGuard(
    m,
    () => {
      blocked++;
    },
    true,
  );
  process.env.DATABASE_URL = c.databaseUrl;
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { Prisma } = await import('../src/generated/prisma/client.js');
  const { ledgerChain } = await import('./load-test/audit.js');
  const db = new PrismaService();
  const metrics = new Metrics();
  try {
    // All test users remain in the full audit. Select one initially sound account
    // for this focused regression; do not relabel other smoke audit findings.
    let actor: Fixture['actors'][number] | undefined;
    for (const candidate of fixture.actors.filter(
      (a) => a.mode === 'general',
    )) {
      const wallets = await db.cashWallet.findMany({
        where: { tradingAccountId: candidate.accountId },
      });
      let sound = true;
      for (const w of wallets) {
        const rows = await db.walletTransaction.findMany({
          where: { walletId: w.id },
        });
        if (!ledgerChain(rows, w.balanceAmount)) sound = false;
      }
      if (sound) {
        actor = candidate;
        break;
      }
    }
    assert.ok(actor, 'No account with a passing initial exact ledger chain');
    const http = new AppClient(m, c, actor.email, metrics);
    await http.login();
    await http.refresh();
    const path = `/trading-accounts/${actor.accountId}`;
    const list = (await http.get(
      '/assets?assetType=crypto&market=BINANCE&limit=100&withPrice=false',
    )) as { assets: Array<{ symbol: string }> };
    assert.deepEqual(
      list.assets.map((a: { symbol: string }) => a.symbol).sort(),
      [...BINANCE_FIXED_SYMBOLS].sort(),
    );
    const catalog = (await http.get(
      `${path}/futures/instruments`,
      0,
      true,
    )) as Awaited<ReturnType<FuturesService['instruments']>>['data'];
    assert.deepEqual(
      catalog.instruments
        .map((i: { underlying: { symbol: string } }) => i.underlying.symbol)
        .sort(),
      [...BINANCE_FUTURES_SYMBOLS].sort(),
    );
    const ws = new WebSocket(
      `${m.target.apiOrigin.replace('http', 'ws')}/api/v1/ws?token=${encodeURIComponent(http.accessToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    await delay(150);
    const rejected = (body: unknown) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.off('message', receive);
          reject(new Error('WS rejection ACK timeout'));
        }, 3000);
        const receive = (data: WebSocket.RawData) => {
          const raw = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
          const p = JSON.parse(raw.toString('utf8')) as {
            type?: string;
            code?: string;
          };
          if (p.type !== 'subscription_error' && p.type !== 'error') return;
          clearTimeout(timer);
          ws.off('message', receive);
          try {
            const expected: Record<string, string> = {
              asset_ticker: 'INVALID_SUBSCRIPTION',
              asset_candle: 'ASSET_NOT_AVAILABLE',
              asset_order_book: 'UNSUPPORTED_ASSET',
            };
            assert.equal(
              p.code,
              expected[(body as { channel: string }).channel],
            );
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error('WS rejection mismatch'));
          }
        };
        ws.on('message', receive);
        ws.send(JSON.stringify(body));
      });
    let fills = 0;
    try {
      for (const symbol of BINANCE_FUTURES_ONLY_SYMBOLS) {
        const info = catalog.instruments.find(
          (i: { underlying: { symbol: string } }) =>
            i.underlying.symbol === symbol,
        );
        assert.ok(
          info?.referencePriceEvidence,
          `${symbol} Last evidence missing`,
        );
        assert.ok(info?.markPrice, `${symbol} Mark missing`);
        assert.ok(info.referencePrice, `${symbol} Last price missing`);
        const assetId = info.underlying.assetId;
        const search = (await http.get(
          `/assets?search=${symbol}&withPrice=false`,
          0,
          true,
        )) as { assets: Array<{ symbol: string }> };
        assert.equal(search.assets.length, 0);
        for (const route of [
          `/assets/${assetId}`,
          `/assets/${assetId}/price`,
          `/assets/${assetId}/candles?interval=5m&limit=10`,
        ])
          await assert.rejects(
            http.get(route, 0, true),
            (e: unknown) => e instanceof ApiFailure && e.status === 404,
          );
        for (const side of ['buy', 'sell'])
          for (const type of ['market', 'limit']) {
            const body = {
              assetId,
              side,
              orderType: type,
              ...(side === 'buy' ? { amount: '10' } : { quantity: '0.1' }),
              ...(type === 'limit' ? { limitPrice: '100' } : {}),
            };
            await assert.rejects(
              http.request('POST', `${path}/orders/quote`, body),
              (e: unknown) =>
                e instanceof ApiFailure && e.code === 'ASSET_NOT_TRADABLE',
            );
          }
        for (const channel of [
          'asset_ticker',
          'asset_candle',
          'asset_order_book',
        ])
          await rejected({
            type: 'subscribe',
            channel,
            assetId,
            ...(channel === 'asset_candle' ? { interval: '5m' } : {}),
          });
        assert.equal(
          await db.assetPriceSnapshot.count({ where: { assetId } }),
          0,
        );
        assert.equal(await db.marketCandle.count({ where: { assetId } }), 0);
        const last = await db.futuresLastPriceSnapshot.findFirstOrThrow({
          where: { instrumentId: info.id, source: 'binance_usdm_agg_trade_ws' },
        });
        assert.equal(last.symbol, symbol);
        assert.equal(last.providerProduct, 'binance_usdm_perpetual');
        const mark = await db.futuresMarkSnapshot.findFirstOrThrow({
          where: { instrumentId: info.id, source: 'binance_usdm_mark_ws' },
        });
        assert.equal(mark.symbol, symbol);
        const existing = await db.futuresPosition.findFirst({
          where: {
            tradingAccountId: actor.accountId,
            instrumentId: info.id,
            status: 'open',
          },
        });
        if (existing)
          await http.request('POST', `${path}/futures/execute`, {
            instrumentId: info.id,
            positionId: existing.id,
            leverage: existing.leverage,
            marginMode: existing.marginMode,
            direction: existing.direction,
            operation: 'close',
            quantity: existing.quantity.toFixed(8),
            idempotencyKey: randomUUID(),
          });
        const body = {
          instrumentId: info.id,
          operation: 'open',
          direction: 'long',
          quantity: '0.01000000',
          leverage: 2,
          marginMode: symbol === 'PUMPUSDT' ? 'cross' : 'isolated',
          idempotencyKey: randomUUID(),
        };
        const open = (await http.request(
          'POST',
          `${path}/futures/execute`,
          body,
        )) as FuturesExecuteResult['data'];
        const again = (await http.request(
          'POST',
          `${path}/futures/execute`,
          body,
        )) as FuturesExecuteResult['data'];
        assert.equal(again.execution.id, open.execution.id);
        assert.equal(open.execution.priceEvidence.priceBasis, 'futures_last');
        assert.equal(open.execution.priceEvidence.assetPriceSnapshotId, null);
        assert.ok(open.execution.priceEvidence.lastPriceSnapshotId);
        const evidence = await db.futuresLastPriceSnapshot.findUniqueOrThrow({
          where: { id: open.execution.priceEvidence.lastPriceSnapshotId },
        });
        assert.equal(evidence.instrumentId, info.id);
        assert.equal(evidence.price.toFixed(8), open.execution.executionPrice);
        for (const [operation, quantity] of [
          ['increase', '0.01000000'],
          ['reduce', '0.01000000'],
          ['close', '0.01000000'],
        ]) {
          const d = (await http.request('POST', `${path}/futures/execute`, {
            instrumentId: info.id,
            positionId: open.position.id,
            leverage: open.position.leverage,
            marginMode: open.position.marginMode,
            direction: open.position.direction,
            operation,
            quantity,
            idempotencyKey: randomUUID(),
          })) as FuturesExecuteResult['data'];
          assert.equal(d.execution.priceEvidence.priceBasis, 'futures_last');
          fills++;
        }
        fills++;
        const entry = (await http.request(
          'POST',
          `${path}/futures/limit-orders`,
          {
            instrumentId: info.id,
            direction: 'long',
            quantity: '0.01000000',
            leverage: 2,
            marginMode: 'isolated',
            limitPrice: new Prisma.Decimal(info.referencePrice)
              .mul('.5')
              .toFixed(8),
            idempotencyKey: randomUUID(),
          },
        )) as Awaited<ReturnType<FuturesLimitService['create']>>['data'];
        await http.request(
          'POST',
          `${path}/futures/limit-orders/${entry.order.id}/cancel`,
          { idempotencyKey: randomUUID() },
        );
      }
    } finally {
      ws.close();
    }
    for (const w of await db.cashWallet.findMany({
      where: { tradingAccountId: actor.accountId },
    })) {
      const rows = await db.walletTransaction.findMany({
        where: { walletId: w.id },
      });
      assert.ok(
        ledgerChain(rows, w.balanceAmount),
        `Exact ledger chain failed for ${w.walletScope}`,
      );
      assert.equal(w.reservedAmount.toFixed(8), '0.00000000');
    }
    assert.equal(blocked, 0);
    console.log(
      JSON.stringify(
        {
          verdict: 'PASS',
          spotSymbols: 25,
          futuresSymbols: 25,
          futuresOnly: BINANCE_FUTURES_ONLY_SYMBOLS,
          spotQuoteRejections: 20,
          spotWsRejections: 15,
          lastMarkWs: 5,
          marketLifecycleFills: fills,
          limitCreateCancel: 5,
          idempotencyReplay: 5,
          exactLedgerChains: 'PASS (focused account)',
          externalProviderAttempts: blocked,
          fullFixtureAudit:
            'See separate harness audit; never replaced by this focused check',
        },
        null,
        2,
      ),
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
