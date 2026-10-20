-- Additive and inert until an operator explicitly prepares/arms a launch.
ALTER TABLE seasons
  ADD COLUMN launch_kind TEXT,
  ADD COLUMN launch_armed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN launch_test_user_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN suspended_at TIMESTAMP(3),
  ADD COLUMN trading_cutoff_at TIMESTAMP(3),
  ADD COLUMN launch_activated_at TIMESTAMP(3),
  ADD COLUMN launch_source_snapshot_json JSONB;

ALTER TABLE seasons ADD CONSTRAINT seasons_launch_policy_check CHECK (
  (launch_kind IS NULL AND NOT launch_armed AND cardinality(launch_test_user_ids) = 0
    AND launch_activated_at IS NULL AND launch_source_snapshot_json IS NULL)
  OR
  (launch_kind IS NOT NULL AND launch_kind IN ('test', 'release') AND name = 'season0'
    AND end_at - start_at = INTERVAL '504 hours'
    AND initial_capital_krw = 10000000
    AND final_ranking_min_traded_instruments IS NOT NULL
    AND final_ranking_min_turnover_ratio IS NOT NULL
    AND final_ranking_min_traded_instruments = 5
    AND final_ranking_min_turnover_ratio = 3
    AND ((launch_kind = 'test' AND cardinality(launch_test_user_ids) > 0)
      OR (launch_kind = 'release' AND cardinality(launch_test_user_ids) = 0))
    AND (NOT launch_armed OR (status = 'upcoming' AND launch_activated_at IS NULL)))
);

CREATE FUNCTION guard_launch_season_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.launch_armed AND NOT OLD.launch_armed AND clock_timestamp() >= NEW.start_at THEN
    RAISE EXCEPTION 'Cannot arm a launch after its start' USING ERRCODE = '23514';
  END IF;
  IF (OLD.launch_kind IS NOT NULL OR NEW.launch_kind IS NOT NULL) AND
     (OLD.status <> 'upcoming' OR clock_timestamp() >= OLD.start_at
       OR EXISTS (SELECT 1 FROM season_participants WHERE season_id = OLD.id)) THEN
    IF ROW(NEW.launch_kind, NEW.name, NEW.start_at, NEW.end_at,
           NEW.initial_capital_krw, NEW.trade_fee_rate, NEW.fx_fee_rate,
           NEW.launch_test_user_ids, NEW.final_ranking_min_traded_instruments,
           NEW.final_ranking_min_turnover_ratio, NEW.launch_source_snapshot_json)
       IS DISTINCT FROM
       ROW(OLD.launch_kind, OLD.name, OLD.start_at, OLD.end_at,
           OLD.initial_capital_krw, OLD.trade_fee_rate, OLD.fx_fee_rate,
           OLD.launch_test_user_ids, OLD.final_ranking_min_traded_instruments,
           OLD.final_ranking_min_turnover_ratio, OLD.launch_source_snapshot_json)
       OR (OLD.status <> 'upcoming' AND NEW.status = 'upcoming') THEN
      RAISE EXCEPTION 'Launch policy is frozen after its start or first participation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER seasons_launch_policy_immutable BEFORE UPDATE ON seasons
  FOR EACH ROW EXECUTE FUNCTION guard_launch_season_policy();
