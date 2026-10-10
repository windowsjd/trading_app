// STRICTLY READ-ONLY transition check for an operator-approved run against the
// production database. Not executed by the 2026-10-10 task (approval pending).
// - DATABASE_URL comes ONLY from the shell environment (no .env files).
// - The session is forced read-only and verified before any query; every query
//   runs inside BEGIN READ ONLY ... ROLLBACK. Aggregate counts only, no user data.
// cd backend && DATABASE_URL='<approved url>' node ../docs/investigations/2026-10-10-futures-last-price/reproduction/production-readonly-check.cjs
const { Client } = require('../../../../backend/node_modules/pg');

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('Set DATABASE_URL explicitly for this run.');
const url = new URL(raw);
console.log('target host:', url.hostname.replace(/^[^.]+/, '<id>'), 'db:', url.pathname.slice(1));
(async () => {
  const c = new Client({
    connectionString: raw,
    options: '-c default_transaction_read_only=on -c statement_timeout=15000',
    ssl: url.hostname === '127.0.0.1' ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();
  const ro = (await c.query('SHOW default_transaction_read_only')).rows[0]
    .default_transaction_read_only;
  if (ro !== 'on') throw new Error('Session is not read-only; aborting.');
  await c.query('BEGIN READ ONLY');
  const q = async (label, sql) =>
    console.log(label, JSON.stringify((await c.query(sql)).rows));
  await q('now', `SELECT clock_timestamp() AS now`);
  await q('migrations', `SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished, max(migration_name) FILTER (WHERE finished_at IS NOT NULL) AS latest FROM _prisma_migrations`);
  await q('eligibleSpotAssets', `SELECT count(*) AS n, string_agg(symbol, ',' ORDER BY symbol) AS symbols FROM assets WHERE is_active AND asset_type='crypto' AND market='BINANCE' AND currency_code='USD' AND price_currency='USD' AND settlement_currency='USD'`);
  await q('futuresInstruments', `SELECT count(*) AS n, count(*) FILTER (WHERE is_active) AS active, count(*) FILTER (WHERE mark_verified_at IS NOT NULL) AS verified, max(mark_verified_at) AS latest_verified FROM futures_instruments`);
  await q('futuresPositions', `SELECT status, count(*) FROM futures_positions GROUP BY status`);
  await q('futuresExecutions', `SELECT count(*) AS n, max(executed_at) AS last FROM futures_executions`);
  await q('futuresLimitOrders', `SELECT status, count(*) FROM futures_limit_orders GROUP BY status`);
  await q('protectionGroups', `SELECT domain, status, count(*) FROM protection_groups GROUP BY domain, status ORDER BY 1, 2`);
  await q('pendingChildren', `SELECT g.domain, count(*) FROM protection_children c JOIN protection_groups g ON g.id = c.group_id WHERE c.status = 'pending' GROUP BY g.domain`);
  await q('seasonFutures', `SELECT (SELECT count(*) FROM futures_season_prices) AS season_prices, (SELECT count(*) FROM futures_season_settlements) AS settlements, (SELECT count(*) FROM futures_liquidations) AS liquidations`);
  await q('futuresWalletReservations', `SELECT count(*) AS wallets, count(*) FILTER (WHERE reserved_amount > 0) AS reserved FROM cash_wallets WHERE wallet_scope = 'crypto_futures'`);
  await q('seasons', `SELECT status, count(*), min(end_at) AS min_end, max(end_at) AS max_end FROM seasons GROUP BY status ORDER BY 1`);
  await q('markSnapshots', `SELECT count(*) AS n, max(captured_at) AS latest FROM futures_mark_snapshots`);
  await c.query('ROLLBACK');
  await c.end();
})().catch((e) => {
  console.error('ERR', e.code || '', String(e.message).split('\n')[0]);
  process.exit(1);
});
