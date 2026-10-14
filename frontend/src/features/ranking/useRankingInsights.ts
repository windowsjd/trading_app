import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { ERROR_CODE } from '../../models/enums/errorCode';
import type { CurrentSeasonDto } from '../../models/dto/season';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { getRankingSlice, type GetRankingSliceParams, type RankingItemDto, type RankingsResponseDto } from './api';
import {
  RANKING_INSIGHT_KEYS,
  buildRankingInsights,
  explainRankingInsights,
  previousDayStanding,
  previousRankingDate,
  upperTierLastRank,
  type RankingInsight,
  type RankingInsightInput,
  type RankingInsightKey,
} from './rankingInsights';

/** Rows the publication already carries (scope all, offset 0, limit 3). */
const PUBLICATION_ROWS = 3;

// A pinned set never changes, so its rows stay cached. A 409 means a newer
// set exists and the next publication poll moves there: no retry for that.
const retrySliceRead = (failureCount: number, error: unknown) =>
  failureCount < 1 && getApiErrorCode(error) !== ERROR_CODE.RANKING_SNAPSHOT_CHANGED;

/**
 * Where a read stands for this set: not needed, still out, failed, or
 * answered. Data already read for a pinned key stays valid even when a later
 * refetch of it fails.
 */
type ReadState = 'skipped' | 'pending' | 'failed' | 'done';
const readState = (enabled: boolean, query: { data?: unknown; isError: boolean }): ReadState =>
  !enabled ? 'skipped' : query.data !== undefined ? 'done' : query.isError ? 'failed' : 'pending';

const rowAt = (rows: readonly RankingItemDto[] | undefined, rank: number) =>
  rows?.find((row) => row.rank === rank) ?? null;

/** Rows of the answer only when it is the requested set. */
function rowsOf(response: RankingsResponseDto | undefined, rankingDate: string | null, capturedAt: string | null) {
  return response?.state === 'available' && response.rankingDate === rankingDate && response.capturedAt === capturedAt
    ? response.rankings : undefined;
}

/**
 * Messages of the 순위 안내 slot for the ranking tab's publication: always the
 * whole (전체) daily ranking, whatever tab is selected. Only an active,
 * joined season with my daily row qualifies; otherwise there are none.
 *
 * Besides rows the publication already holds, it reads at most three rows by
 * rank: directly above me, the upper tier's edge (b, b + 1) and yesterday's
 * last set. Current-day reads pin the publication's `capturedAt` so one set's
 * values are never mixed with another's. While a new set's reads are still
 * out, the last complete messages stay; they are replaced together. A failed
 * read drops only its own message.
 *
 * Development builds log one line per set (a new `capturedAt` or rank) with
 * every message's explainRankingInsights reason, once its reads are done.
 */
export function useRankingInsights({ publication, season }: {
  publication: RankingsResponseDto | undefined;
  season: Pick<CurrentSeasonDto, 'status' | 'joined' | 'initialCapitalKrw'> | undefined;
}): RankingInsight[] {
  const myRanking = publication?.myRanking;
  const me = myRanking?.state === 'available' ? myRanking : null;
  const seasonId = publication?.season?.id ?? null;
  const rankingDate = publication?.rankingDate ?? null;
  const capturedAt = publication?.capturedAt ?? null;
  const rows = publication?.rankings;
  const participants = publication?.pagination?.total ?? 0;
  const eligible = !!me && publication?.state === 'available' && publication.rankType === 'daily'
    && season?.status === 'active' && season.joined !== false && !!seasonId && !!rankingDate && !!capturedAt;
  const rank = eligible ? me.rank : 0;
  const read = (offset: number, limit: number): GetRankingSliceParams => ({
    seasonId: seasonId ?? '', rankType: 'daily', rankingDate: rankingDate ?? '', capturedAt, offset, limit,
  });

  // 바로 위 (rank − 1): up to rank 4 that row is among the publication's.
  const readAbove = eligible && rank > PUBLICATION_ROWS + 1;
  const aboveRead = read(rank - 2, 1);
  const aboveQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.slice(aboveRead),
    queryFn: () => getRankingSlice(aboveRead),
    enabled: readAbove,
    staleTime: Infinity,
    retry: retrySliceRead,
  });

  // The next tier up ends at rank b: rows b and b + 1 prove where it ends.
  const edge = eligible ? upperTierLastRank(me.provisionalTier, participants) : null;
  const edgeInPublication = edge !== null && edge + 1 <= PUBLICATION_ROWS;
  const readEdge = edge !== null && rank > edge && !edgeInPublication;
  const edgeRead = read((edge ?? 1) - 1, 2);
  const edgeQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.slice(edgeRead),
    queryFn: () => getRankingSlice(edgeRead),
    enabled: readEdge,
    staleTime: Infinity,
    retry: retrySliceRead,
  });

  // Yesterday's latest daily set (its last ranking); not pinned to today's set.
  const previousDate = eligible ? previousRankingDate(rankingDate) : null;
  const previousRead = { ...read(0, 1), rankingDate: previousDate ?? '', capturedAt: null };
  const previousQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.slice(previousRead),
    queryFn: () => getRankingSlice(previousRead),
    enabled: !!previousDate,
    staleTime: Infinity,
    retry: retrySliceRead,
  });

  const aboveState = readState(readAbove, aboveQuery);
  const edgeState = readState(readEdge, edgeQuery);
  const previousState = readState(!!previousDate, previousQuery);
  const ready = eligible && aboveState !== 'pending' && edgeState !== 'pending' && previousState !== 'pending';
  const aboveData = aboveQuery.data;
  const edgeData = edgeQuery.data;
  const previousData = previousQuery.data;
  const initialCapitalKrw = season?.initialCapitalKrw;
  const input = useMemo((): RankingInsightInput | null => {
    if (!ready || !me) return null;
    const aboveRows = readAbove ? rowsOf(aboveData, rankingDate, capturedAt) : rows;
    const edgeRows = edgeInPublication ? rows : rowsOf(edgeData, rankingDate, capturedAt);
    return {
      me: { rank: me.rank, totalAssetKrw: me.totalAssetKrw, provisionalTier: me.provisionalTier },
      participants,
      first: rowAt(rows, 1),
      above: rowAt(aboveRows, me.rank - 1),
      tierEdge: edge === null ? null : [rowAt(edgeRows, edge), rowAt(edgeRows, edge + 1)],
      initialCapitalKrw,
      previous: previousDayStanding(previousData, previousDate),
    };
  }, [ready, me, readAbove, aboveData, rankingDate, capturedAt, rows, edgeInPublication, edgeData, participants,
    edge, initialCapitalKrw, previousData, previousDate]);
  const complete = useMemo(() => (input ? buildRankingInsights(input) : null), [input]);

  const logged = useRef<string | null>(null);
  useEffect(() => {
    if ((globalThis as { __DEV__?: boolean }).__DEV__ !== true || !input) return;
    const set = `${rankingDate} ${capturedAt} #${input.me.rank}/${participants}`;
    if (logged.current === set) return;
    logged.current = set;
    const explanation = explainRankingInsights(input);
    // Only the hook knows a read failed; the pure rules just see its row missing.
    const reads: Record<RankingInsightKey, ReadState> = {
      above: aboveState, first: 'skipped', tier: edgeState, goal: 'skipped', change: previousState,
    };
    console.debug('[ranking-insight]', `${set} ${RANKING_INSIGHT_KEYS.map((key) => `${key}=${
      !explanation[key].shown && reads[key] === 'failed' ? 'fetch_failed' : explanation[key].reason}`).join(' ')}`);
  }, [input, rankingDate, capturedAt, participants, aboveState, edgeState, previousState]);

  const [held, setHeld] = useState<RankingInsight[]>([]);
  useEffect(() => {
    if (complete) setHeld(complete);
    else if (!eligible) setHeld([]);
  }, [complete, eligible]);

  return eligible ? complete ?? held : [];
}
