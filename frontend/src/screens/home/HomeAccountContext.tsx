import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import type { TradingAccountDto } from '../../features/tradingAccount/api';
import { getMe } from '../../features/me/api';
import { getRankings, getRankingTier } from '../../features/ranking/api';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import ErrorNotice from '../../components/states/ErrorNotice';
import { useAppearance } from '../../theme/appearance';
import { FINAL_RANKING_NOT_QUALIFIED_LABEL } from '../../features/record/seasonFinalResult';
import { getHomeTier } from './tierPresentation';
import TierEmblem, { tierEmblemWidth } from './TierEmblem';

export function useHomeAccountContext(account: TradingAccountDto | null) {
  const season = account?.mode === 'season' ? account.season : null;
  const rankType: 'final' | 'daily' = season?.seasonStatus === 'settled' ? 'final' : 'daily';
  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000, enabled: !!account,
  });
  const rankingQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list({
      scope: 'all', seasonId: season?.seasonId ?? null, rankType, limit: 1, offset: 0,
    }),
    queryFn: () => getRankings({ scope: 'all', seasonId: season?.seasonId, rankType, limit: 1, offset: 0 }),
    enabled: !!season?.seasonId,
  });
  return { meQuery, rankingQuery, rankType, hasSeason: account?.mode === 'season', seasonId: season?.seasonId ?? null,
    refreshQueries: [meQuery, { ...rankingQuery, enabled: !!season?.seasonId }] };
}

export type HomeAccountContextData = ReturnType<typeof useHomeAccountContext>;

/** The season ranking row behind Home's tier (never for general/beginner). */
function readSeasonStanding(context: HomeAccountContextData, mode: 'light' | 'dark') {
  const { rankingQuery, rankType, hasSeason, seasonId } = context;
  const loading = !!seasonId && rankingQuery.isLoading;
  const myRanking = !rankingQuery.isError && !loading && seasonId &&
    rankingQuery.data?.state === 'available' && rankingQuery.data.myRanking.state === 'available'
    ? rankingQuery.data.myRanking : null;
  const tier = hasSeason ? getHomeTier(getRankingTier(myRanking, rankType), mode) : null;
  // Settlement's verdict, reported by the ranking API: no final rank or tier exists.
  const notQualified = rankType === 'final' && !rankingQuery.isError && !loading &&
    rankingQuery.data?.myRanking.state === 'unavailable' &&
    rankingQuery.data.myRanking.reason === 'FINAL_RANKING_NOT_QUALIFIED';
  const tierLabel = tier?.name ?? (loading ? '티어 확인 중' : rankingQuery.isError ? '티어 확인 실패'
    : notQualified ? FINAL_RANKING_NOT_QUALIFIED_LABEL : '티어 미정');
  return { tier, tierLabel };
}

/**
 * One account box for general, beginner and season accounts: the mode or
 * season title and the change action on top, the profile right below. The
 * rank lives on the Ranking tab; the season tier is shown next to the total
 * assets (HomeTierBadge).
 */
export default function HomeAccountContext({ context }: { context: HomeAccountContextData }) {
  const { meQuery, rankingQuery, hasSeason } = context;
  return (
    <AccountSwitcher home>
      <View style={styles.identity}>
        {meQuery.isLoading ? <View style={styles.flex}><SectionSkeleton lines={1} /></View> : meQuery.data ? <>
          <ProfileAvatar profileImageUrl={meQuery.data.profileImageUrl} size={32} testID="home-profile-avatar" />
          <Text testID={TEST_IDS.home.nickname} style={styles.nickname}>{meQuery.data.nickname}</Text>
        </> : <View style={styles.flex}><InlineEmptyState message="사용자 정보를 불러오지 못했습니다." /></View>}
      </View>
      {/* The tier still reads this ranking row; its failure keeps its own diagnostic. */}
      {hasSeason && rankingQuery.isError
        ? <ErrorNotice error={rankingQuery.error} message="랭킹 정보를 불러오지 못했습니다." style={styles.notice} /> : null}
    </AccountSwitcher>
  );
}

/**
 * Emblem sizes beside the total assets (dp, before the optical scale), chosen
 * from the visible Whale silhouette on common phones: the largest that still
 * fits beside the performance lines without crowding them. Narrow screens and
 * large text keep a smaller emblem so nothing overlaps or clips.
 */
function homeTierBadgeSize(width: number, fontScale: number) {
  if (width < 360 || fontScale > 1.3) return 100;
  return width < 400 ? 132 : 140;
}

/** One column for the emblem and its name, so the name centers under it. */
function useHomeTierColumn(context: HomeAccountContextData) {
  const { mode } = useAppearance();
  const { width, fontScale } = useWindowDimensions();
  const standing = readSeasonStanding(context, mode);
  const size = homeTierBadgeSize(width, fontScale);
  return { ...standing, size, column: standing.tier ? tierEmblemWidth(standing.tier.id, size) : size };
}

/**
 * The season tier emblem beside the total assets. The emblem keeps its
 * original proportions; the numbers stay the primary information. The hero
 * places it beside the total, or lower beside the performance lines when the
 * total needs the width (HomeAssetHero). Its name is HomeTierName.
 */
export function HomeTierBadge({ context }: { context: HomeAccountContextData }) {
  const { tier, size } = useHomeTierColumn(context);
  if (!context.hasSeason) return null;
  return (
    <View testID="home-tier-badge" style={styles.tier}>
      {tier ? <TierEmblem tier={tier.id} size={size} /> :
        <View testID="home-tier-neutral" style={[styles.neutral, { width: size, height: size }]}
          accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <View style={styles.neutralRing}><Text style={styles.neutralMark}>—</Text></View>
        </View>}
    </View>
  );
}

/**
 * The tier name under the emblem, on the asset trend disclosure's line
 * (HomeAssetTrend's `trailing`): both share the emblem's right-aligned column.
 */
export function HomeTierName({ context }: { context: HomeAccountContextData }) {
  const { tierLabel, column } = useHomeTierColumn(context);
  if (!context.hasSeason) return null;
  return (
    <View style={[styles.tierNameColumn, { minWidth: column }]}>
      <Text testID={TEST_IDS.home.tier} style={styles.tierName} accessibilityLabel={`시즌 티어 ${tierLabel}`}
        accessibilityLiveRegion="polite">{tierLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  identity: { flexDirection: 'row', alignItems: 'center', columnGap: 10, minWidth: 0 },
  nickname: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: 16, fontWeight: '600', lineHeight: 24 },
  tier: { alignItems: 'center', flexShrink: 0 },
  tierNameColumn: { maxWidth: '100%', flexShrink: 1, alignItems: 'center' },
  // The same size and weight as the 보유종목 및 포지션 heading (HomeHoldings).
  tierName: { fontSize: 18, lineHeight: 27, fontWeight: '700', textAlign: 'center', color: semantic.text },
  neutral: { alignItems: 'center', justifyContent: 'center' },
  neutralRing: { width: '65%', height: '65%', borderRadius: 999, borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  neutralMark: { fontSize: 22, color: semantic.muted },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
});
