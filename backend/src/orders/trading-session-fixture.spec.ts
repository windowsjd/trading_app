import { spawnSync } from 'node:child_process';

describe('PostgreSQL runner calendar fixture', () => {
  it.each(['2026-07-10', '2026-07-11', '2026-07-12'])(
    'keeps open/close, candle and unavailable boundaries on %s without mocking Date',
    (date) => {
      const result = spawnSync(
        'pnpm',
        [
          'tsx',
          '-e',
          `
        import { tradingSessions } from './test/support/trading-session-fixture';
        import assert from 'node:assert/strict';
        import { getAssetTradingStatus } from './src/orders/market-hours.policy';
        import { resolveRegularSessionForEvent } from './src/orders/market-calendar.policy';
        import { markMarketSessionOverrideStoreRequired, resetMarketSessionOverrideStoreForTest } from './src/orders/market-calendar/market-session-override.store';
        const now = new Date('${date}T03:00:00Z');
        const closeAt = new Date(now.getTime() + 2000);
        const asset = { assetType: 'domestic_stock', market: 'KRX' };
        const dateConstructor = Date;
        tradingSessions.set(now, closeAt);
        assert.equal(getAssetTradingStatus(asset, now).tradable, true);
        assert.equal(getAssetTradingStatus(asset, new Date(closeAt.getTime() - 1)).tradable, true);
        assert.equal(getAssetTradingStatus(asset, closeAt).reason, 'MARKET_CLOSED');
        assert.equal(resolveRegularSessionForEvent(asset, now).closeTime.getTime(), closeAt.getTime());
        assert.equal(resolveRegularSessionForEvent(asset, closeAt), null);
        assert.equal(resolveRegularSessionForEvent(asset, new Date(now.getTime() - 86400001)), null);
        markMarketSessionOverrideStoreRequired();
        assert.equal(getAssetTradingStatus(asset, now).reason, 'MARKET_CALENDAR_UNAVAILABLE');
        assert.equal(resolveRegularSessionForEvent(asset, now), null);
        resetMarketSessionOverrideStoreForTest();
        tradingSessions.reset();
        assert.equal(getAssetTradingStatus(asset, now).tradable, '${date}' === '2026-07-10');
        assert.equal(Date, dateConstructor);
        console.log('calendar fixture boundaries passed');
      `,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('calendar fixture boundaries passed');
    },
  );
});
