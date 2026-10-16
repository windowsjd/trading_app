-- READ-ONLY fingerprint of core financial rows (ledger, wallets, orders, executions, positions).
-- Mutable valuation columns (positions.current_price_*/market_value_*/unrealized_*) are excluded.
SELECT 'wallet_transactions' AS t, count(*)::int AS n, md5(coalesce(string_agg(concat_ws('|', id, wallet_id, amount, balance_after, occurred_at), ',' ORDER BY id), '')) AS digest FROM wallet_transactions
UNION ALL SELECT 'cash_wallets', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, balance_amount, reserved_amount), ',' ORDER BY id), '')) FROM cash_wallets
UNION ALL SELECT 'orders', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, status, quantity, executed_quantity, executed_price, net_amount, asset_price_snapshot_id, updated_at), ',' ORDER BY id), '')) FROM orders
UNION ALL SELECT 'futures_executions', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, quantity, execution_price, realized_pnl, last_price_snapshot_id), ',' ORDER BY id), '')) FROM futures_executions
UNION ALL SELECT 'futures_positions', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, status, quantity, average_entry_price, isolated_margin, realized_pnl), ',' ORDER BY id), '')) FROM futures_positions
UNION ALL SELECT 'positions', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, asset_id, quantity, reserved_quantity, average_cost, realized_pnl), ',' ORDER BY id), '')) FROM positions
UNION ALL SELECT 'assets_existing_30', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, symbol, name, market, asset_type, currency_code, is_active), ',' ORDER BY id), '')) FROM assets WHERE market = 'BINANCE' AND asset_type = 'crypto' AND created_at < '2026-10-16'
UNION ALL SELECT 'futures_instruments_existing_25', count(*)::int, md5(coalesce(string_agg(concat_ws('|', id, underlying_asset_id, product_type, settlement_currency, is_active), ',' ORDER BY id), '')) FROM futures_instruments WHERE created_at < '2026-10-16'
ORDER BY 1;
