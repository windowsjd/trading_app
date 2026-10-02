-- Additive, nullable one-shot result; existing full fills and limit rows stay intact.
ALTER TABLE "orders"
  ADD COLUMN "executed_quantity" DECIMAL(24,8),
  ADD COLUMN "canceled_quantity" DECIMAL(24,8),
  ADD COLUMN "requested_amount" DECIMAL(24,8),
  ADD COLUMN "unspent_amount" DECIMAL(24,8),
  ADD COLUMN "execution_evidence" JSONB;

-- This check is intentionally SQL-only (Prisma does not model CHECKs).
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_execution_result_check" CHECK (
  ("executed_quantity" IS NULL AND "canceled_quantity" IS NULL
    AND "requested_amount" IS NULL AND "unspent_amount" IS NULL AND "execution_evidence" IS NULL)
  OR
  ("executed_quantity" IS NOT NULL AND "executed_quantity" > 0
    AND "order_type" = 'market' AND "status" = 'executed'
    AND "executed_at" IS NOT NULL AND "executed_price" IS NOT NULL AND "executed_price" > 0
    AND "gross_amount" IS NOT NULL AND "gross_amount" > 0
    AND "fee_amount" IS NOT NULL AND "net_amount" IS NOT NULL
    AND "execution_evidence" IS NOT NULL
    AND (
      ("requested_amount" IS NULL AND "unspent_amount" IS NULL
        AND "canceled_quantity" IS NOT NULL AND "canceled_quantity" >= 0
        AND "quantity" = "executed_quantity" + "canceled_quantity"
        AND (("canceled_quantity" = 0 AND "cancel_reason" IS NULL AND "canceled_at" IS NULL)
          OR ("canceled_quantity" > 0 AND "cancel_reason" IS NOT NULL
            AND "cancel_reason" = 'insufficient_market_liquidity'
            AND "canceled_at" IS NOT NULL AND "canceled_at" = "executed_at")))
      OR
      ("side" = 'buy' AND "requested_amount" IS NOT NULL AND "requested_amount" > 0
        AND "canceled_quantity" IS NULL AND "quantity" = "executed_quantity"
        AND "unspent_amount" IS NOT NULL AND "unspent_amount" >= 0
        AND "requested_amount" = "gross_amount" + "unspent_amount"
        AND (("cancel_reason" IS NULL AND "canceled_at" IS NULL)
          OR ("cancel_reason" IS NOT NULL AND "cancel_reason" = 'insufficient_market_liquidity'
            AND "unspent_amount" > 0 AND "canceled_at" IS NOT NULL AND "canceled_at" = "executed_at")))
    ))
);
