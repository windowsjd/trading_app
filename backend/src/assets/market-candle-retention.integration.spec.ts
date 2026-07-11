import { spawnSync } from 'node:child_process';

const itDb =
  process.env.MARKET_CANDLE_RETENTION_DB_SMOKE === '1' ? it : it.skip;

describe('Market candle retention PostgreSQL smoke', () => {
  itDb(
    'deletes only old closed 5m rows across bounded batches',
    () => {
      const prepare = spawnSync(pnpm(), ['run', 'test:db:prepare'], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (prepare.status !== 0) {
        throw new Error(`Retention migrate deploy failed:\n${prepare.stderr}`);
      }
      const result = spawnSync(pnpm(), ['exec', 'tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `Retention DB smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('market candle retention db smoke ok');
    },
    130_000,
  );
});

function pnpm(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

const RUNNER = String.raw`
import 'dotenv/config';
import assert from 'node:assert/strict';
import { AssetType, CurrencyCode } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import { MarketCandlesRepository } from './src/assets/market-candles.repository';
import { MarketCandleRetentionService } from './src/assets/market-candle-retention.service';

const prisma = new PrismaService();
const repository = new MarketCandlesRepository(prisma);
const retention = new MarketCandleRetentionService(
  repository,
  { retentionDays: 35, batchSize: 2, maxBatches: 1000 },
  async () => undefined,
);
const market = 'RETENTION-SMOKE-' + Date.now();
let assetId = '';
const now = new Date('2026-07-11T00:00:00.000Z');
const cutoff = new Date('2026-06-06T00:00:00.000Z');
const at = (days: number, minutes = 0) =>
  new Date(now.getTime() - days * 86400000 + minutes * 60000);
const candle = (interval: '5m' | '1d' | '1w', openTime: Date, isClosed = true) => ({
  assetId,
  interval,
  openTime,
  closeTime: new Date(openTime.getTime() + (interval === '5m' ? 300000 : 86400000)),
  open: '100', high: '101', low: '99', close: '100', volume: '1', amount: '100',
  isClosed, sourceProvider: 'retention-smoke', sourceUpdatedAt: now,
});

async function main() {
  await prisma.$connect();
  try {
    const asset = await prisma.asset.create({ data: {
      symbol: 'RET' + Date.now().toString(36).toUpperCase(), name: 'Retention Smoke', market,
      currencyCode: CurrencyCode.USD, priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD, assetType: AssetType.crypto,
    }});
    assetId = asset.id;
    await repository.upsertMany([
      candle('5m', at(36)),
      candle('5m', new Date(cutoff.getTime() - 300000)),
      candle('5m', at(40)),
      candle('5m', at(45)),
      candle('5m', cutoff),
      candle('5m', at(34)),
      candle('5m', at(60), false),
      candle('1d', at(60)),
      candle('1w', at(70)),
    ]);
    const result = await retention.run({ now, batchSize: 2 });
    assert.equal(result.deletedCount, 4);
    assert.equal(result.batchCount, 3);
    const rows = await prisma.marketCandle.findMany({ where: { assetId } });
    assert.equal(rows.length, 5);
    assert(rows.some((row) => row.interval === '5m' && row.openTime.getTime() === cutoff.getTime()));
    assert(rows.some((row) => row.interval === '5m' && !row.isClosed));
    assert(rows.some((row) => row.interval === '1d'));
    assert(rows.some((row) => row.interval === '1w'));
    console.log('market candle retention db smoke ok');
  } finally {
    if (assetId) await prisma.marketCandle.deleteMany({ where: { assetId } });
    await prisma.asset.deleteMany({ where: { market } });
    await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
`;
