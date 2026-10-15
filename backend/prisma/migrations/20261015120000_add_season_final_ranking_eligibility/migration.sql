-- Season final-ranking eligibility (docs/season-final-ranking-eligibility.md).
-- Additive only: every existing season keeps NULL (no rule, so every normal
-- participant is still ranked) and every existing participant keeps NULL
-- evidence. No existing row, rank, tier, reward or financial value is rewritten.
BEGIN;

-- AlterTable: the rule of one season. NULL/NULL = no rule.
ALTER TABLE "seasons"
  ADD COLUMN "final_ranking_min_traded_instruments" INTEGER,
  ADD COLUMN "final_ranking_min_turnover_ratio" DECIMAL(10,4);

-- Every branch is NULL-safe: a CHECK that evaluates to NULL passes, so a
-- half-set rule must be rejected by explicit IS NOT NULL tests.
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_final_ranking_eligibility_check" CHECK (
  ("final_ranking_min_traded_instruments" IS NULL AND "final_ranking_min_turnover_ratio" IS NULL)
  OR ("final_ranking_min_traded_instruments" IS NOT NULL AND "final_ranking_min_turnover_ratio" IS NOT NULL
    AND "final_ranking_min_traded_instruments" >= 1 AND "final_ranking_min_turnover_ratio" > 0)
);

-- The rule is fixed before the season opens. Adding, changing or removing it
-- after `upcoming` would apply it retroactively to trades already made or to a
-- result already published.
CREATE FUNCTION guard_season_final_ranking_eligibility() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'upcoming'
     AND (NEW.final_ranking_min_traded_instruments IS DISTINCT FROM OLD.final_ranking_min_traded_instruments
       OR NEW.final_ranking_min_turnover_ratio IS DISTINCT FROM OLD.final_ranking_min_turnover_ratio) THEN
    RAISE EXCEPTION 'season final ranking eligibility is fixed once the season has left upcoming'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER seasons_final_ranking_eligibility_immutable
  BEFORE UPDATE OF "final_ranking_min_traded_instruments", "final_ranking_min_turnover_ratio" ON "seasons"
  FOR EACH ROW EXECUTE FUNCTION guard_season_final_ranking_eligibility();

-- AlterTable: the eligibility settlement confirmed at Season.endAt.
ALTER TABLE "season_participants"
  ADD COLUMN "final_qualified" BOOLEAN,
  ADD COLUMN "final_traded_instrument_count" INTEGER,
  ADD COLUMN "final_recognized_turnover_krw" DECIMAL(24,8);

ALTER TABLE "season_participants" ADD CONSTRAINT "season_participants_final_qualification_check" CHECK (
  ("final_qualified" IS NULL AND "final_traded_instrument_count" IS NULL AND "final_recognized_turnover_krw" IS NULL)
  OR ("final_qualified" IS NOT NULL AND "final_traded_instrument_count" IS NOT NULL
    AND "final_recognized_turnover_krw" IS NOT NULL
    AND "final_traded_instrument_count" >= 0 AND "final_recognized_turnover_krw" >= 0)
);

-- A participant that did not qualify never holds a final rank or tier, whoever
-- writes the row (settlement, tier assignment or an operator correction).
ALTER TABLE "season_participants" ADD CONSTRAINT "season_participants_unqualified_unranked_check" CHECK (
  "final_qualified" IS NOT FALSE OR ("final_rank" IS NULL AND "final_tier" IS NULL)
);

COMMIT;
