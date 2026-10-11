-- Only non-financial UI confirmations; no account/ledger/order backfill.
CREATE UNIQUE INDEX "orders_id_trading_account_id_key" ON "orders" ("id", "trading_account_id");
CREATE TABLE "beginner_quest_acknowledgements" (
  "trading_account_id" TEXT NOT NULL,
  "step_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "acknowledged_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "beginner_quest_acknowledgements_pkey" PRIMARY KEY ("trading_account_id", "step_id"),
  CONSTRAINT "beginner_quest_acknowledgements_step_check" CHECK ("step_id" IN ('holdings_reviewed', 'limit_result_reviewed')),
  CONSTRAINT "beginner_quest_acknowledgements_account_fkey" FOREIGN KEY ("trading_account_id") REFERENCES "trading_accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "beginner_quest_acknowledgements_order_fkey" FOREIGN KEY ("order_id", "trading_account_id") REFERENCES "orders" ("id", "trading_account_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "beginner_quest_acknowledgements_order_id_trading_account_id_idx" ON "beginner_quest_acknowledgements" ("order_id", "trading_account_id");
