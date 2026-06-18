# Ranking Tie-Breaker Migration And Backfill Runbook

## Scope

This runbook covers migration `20260618090000_add_season_ranking_tiebreakers` and existing `season_rankings` rows.

It does not introduce a new schema migration, automatic destructive backfill, provider ingestion trigger, scheduler write, reward policy/catalog, or reward fulfillment behavior.

## Deploy Checklist

Before deploy:

```bash
pnpm exec prisma migrate status
pnpm exec prisma validate
pnpm build
pnpm test
pnpm test:e2e
```

During deploy:

```bash
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
```

Confirm migration `20260618090000_add_season_ranking_tiebreakers` is applied.

## Existing Row Policy

The migration adds:

- `maxDrawdown`
- `totalFillCount`
- `reachedReturnAt`

Existing rows may have default or incomplete tie-breaker evidence:

- `maxDrawdown = 0`
- `totalFillCount = 0`
- `reachedReturnAt = null`

If there are no existing `season_rankings` rows, no backfill action is needed.

If exact historical tie-breaker evidence is not required, existing rows may remain as-is. The ranking API returns these fields null-safely.

If exact historical tie-breaker evidence is required, review the affected `seasonId`, `rankType`, and `rankingDate` with the daily snapshot and executed order evidence available for that date.

Do not manually update or delete production `season_rankings` rows. Regeneration, if approved, should be an explicit operator procedure using the season-ranking or settlement job path, with final tier/read-model impact reviewed first.

## Risks

- Past rows with `reachedReturnAt = null` have incomplete tie-breaker timing evidence.
- Default `maxDrawdown = 0` and `totalFillCount = 0` may differ from actual historical performance.
- Regenerating historical final rankings can affect final tier assignment and record/history results.
- Existing final tier assignments are not overwritten by the final-tier-assignment job; changing historical final rankings after final tiers exist requires a separate operational decision.

## Optional Inspection Queries

Use read-only checks first:

```sql
SELECT
  season_id,
  rank_type,
  ranking_date,
  COUNT(*) AS row_count,
  COUNT(*) FILTER (WHERE reached_return_at IS NULL) AS reached_return_at_null_count,
  COUNT(*) FILTER (WHERE max_drawdown = 0) AS max_drawdown_zero_count,
  COUNT(*) FILTER (WHERE total_fill_count = 0) AS total_fill_count_zero_count
FROM season_rankings
GROUP BY season_id, rank_type, ranking_date
ORDER BY ranking_date DESC, season_id, rank_type;
```

These checks are informational only. They are not approval to backfill or delete data.
