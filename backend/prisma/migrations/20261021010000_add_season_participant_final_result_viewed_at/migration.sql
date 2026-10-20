-- 시즌최종결과 확인 (docs/records-api-contract.md, final-result): when the
-- participant first saw the settled season's final result, per user and season.
--
-- Additive only: one nullable column, no default, no backfill. A participant
-- of an already settled season has not seen the new screen, so it stays NULL
-- until they do. Old code never reads or writes it.
ALTER TABLE "season_participants" ADD COLUMN "final_result_viewed_at" TIMESTAMP(3);
