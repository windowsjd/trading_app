import { spawnSync } from 'node:child_process';

const itLive = process.env.KIS_LIVE_CANDLE_SMOKE === '1' ? it : it.skip;

describe('KIS live trade parser smoke', () => {
  itLive(
    'receives a bounded dry-run H0STCNT0 trade without snapshot writes',
    () => {
      const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const result = spawnSync(command, ['exec', 'tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `KIS live candle smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('kis live candle smoke ok');
    },
    35_000,
  );
});

const RUNNER = String.raw`
import 'dotenv/config';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';

async function main() {
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.SCHEDULER_RANKING_ENABLED = 'false';
  process.env.ENABLE_RANKING_SCHEDULER = 'false';
  process.env.SCHEDULER_SEASON_LIFECYCLE_ENABLED = 'false';
  process.env.ENABLE_SEASON_LIFECYCLE_SCHEDULER = 'false';
  process.env.SCHEDULER_SETTLEMENT_ENABLED = 'false';
  process.env.ENABLE_SEASON_SETTLEMENT_SCHEDULER = 'false';
  process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'false';
  process.env.SCHEDULER_PROVIDER_BINANCE_ENABLED = 'false';
  process.env.SCHEDULER_PROVIDER_KIS_ENABLED = 'false';
  process.env.ENABLE_PROVIDER_KIS_SCHEDULER = 'false';
  process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED = 'false';
  process.env.MARKET_CANDLE_RECONCILIATION_ENABLED = 'false';
  process.env.CANDLE_LIVE_STREAMING_ENABLED = 'false';
  const [{ AppModule }, { KisWebSocketClient }] = await Promise.all([
    import('./src/app.module'),
    import('./src/providers/kis/kis-websocket.client'),
  ]);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const client = app.get(KisWebSocketClient);
    const result = await client.runTradePriceIngestion({ dryRun: true, durationMs: 15000, maxSnapshots: 1, domesticSymbols: [process.env.KIS_DOMESTIC_CANDLE_SMOKE_SYMBOL ?? '005930'], usSymbols: [] });
    assert.equal(result.success, true);
    assert.equal(result.subscriptions.sent, 1);
    assert.ok(result.wouldCreate >= 1);
    assert.equal(result.created, 0);
    console.log('kis live candle smoke ok');
  } finally {
    await app.close();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'smoke failed'); process.exit(1); });
`;
