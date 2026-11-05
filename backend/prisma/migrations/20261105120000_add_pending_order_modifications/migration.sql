-- 대기주문·설정 변경 (docs/pending-order-modification-contract.md). Additive only:
-- no existing row, reservation, ledger or evidence is rewritten.
--
-- A pending order or setting is changed IN PLACE, so its id, links (conditional
-- child orders, entry plans) and first registration time (created_at /
-- submitted_at) stay as they were. Two columns per table carry the change:
--   revised_at  the latest change's time; the evidence floor becomes
--               COALESCE(revised_at, <created/submitted time>), so a price or
--               candle from before the change can never fill or trigger the
--               changed terms.
--   revision    0 until changed, then +1 per change; a change names the
--               revision it was made from, so a stale screen cannot overwrite a
--               newer change.
BEGIN;
ALTER TABLE "orders" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "conditional_buy_orders" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "conditional_sell_orders" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "futures_limit_orders" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "futures_conditional_entries" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "futures_tp_sl_settings" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "entry_tp_sl_plans" ADD COLUMN "revised_at" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Append-only record of every committed change: its idempotency key (a retry
-- after a lost response replays instead of applying twice) and the terms
-- before and after. Never updated or deleted except by account deletion.
CREATE TABLE "pending_order_modifications" (
    "id" TEXT NOT NULL,
    "trading_account_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "before_json" JSONB NOT NULL,
    "after_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_order_modifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_order_modifications_shape" CHECK (
      "target_type" IN ('spot_order', 'conditional_buy', 'conditional_sell', 'futures_limit_order', 'futures_conditional_entry', 'futures_tp_sl', 'entry_tp_sl_plan')
      AND "revision" > 0
    )
);
CREATE UNIQUE INDEX "pending_order_modifications_trading_account_id_idempotency__key" ON "pending_order_modifications"("trading_account_id", "idempotency_key");
CREATE INDEX "pending_order_modifications_target_type_target_id_revision_idx" ON "pending_order_modifications"("target_type", "target_id", "revision");
ALTER TABLE "pending_order_modifications" ADD CONSTRAINT "pending_order_modifications_trading_account_id_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
