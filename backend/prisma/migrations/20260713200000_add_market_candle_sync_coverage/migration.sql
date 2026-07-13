-- Coverage completeness for market candle sync checkpoints.
--
-- `status = completed` only records that a run terminated normally. Whether
-- the provider cursor actually confirmed the whole target range is a separate
-- fact, persisted here:
--   * coverage_complete: the entire half-open [target_from, target_to) range
--     was confirmed by the provider cursor (target_reached / confirmed_empty).
--   * covered_from / covered_to: the half-open instant range actually
--     confirmed so far. Grows monotonically while the run pages.
--   * completion_reason: target_reached | confirmed_empty |
--     empty_page_before_target | provider_exhausted_before_target | ...
--
-- Existing completed rows deliberately stay coverage_complete = FALSE with
-- NULL covered ranges: their true coverage is unknown (provider_exhausted or
-- empty_page terminations were previously recorded as completed), so they are
-- no longer accepted as serving coverage evidence until a re-sync or repair
-- writes a coverage-audited checkpoint. Do NOT backfill from candle min/max.
ALTER TABLE "market_candle_sync_states"
    ADD COLUMN "coverage_complete" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "completion_reason" TEXT,
    ADD COLUMN "covered_from" TIMESTAMPTZ(3),
    ADD COLUMN "covered_to" TIMESTAMPTZ(3);

-- A claimed covered range must be well-formed when present.
ALTER TABLE "market_candle_sync_states"
    ADD CONSTRAINT "market_candle_sync_states_covered_range_check" CHECK (
        "covered_from" IS NULL OR "covered_to" IS NULL OR "covered_from" < "covered_to"
    );
