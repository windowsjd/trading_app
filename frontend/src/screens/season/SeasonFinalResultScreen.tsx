import SeasonTitle from '../../components/tradingAccount/SeasonTitle';
import React, { useEffect } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SeasonFinalResultScreenProps } from '../../app/navigation/types';
import { resetToHome } from '../../app/navigation/seasonRouting';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import ErrorState from '../../components/states/ErrorState';
import FullPageLoading from '../../components/states/FullPageLoading';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getMySeasonFinalResult,
  markMySeasonFinalResultViewed,
  type SeasonFinalResultDto,
} from '../../features/record/api';
import {
  FINAL_RANKING_NOT_QUALIFIED_LABEL,
  finalResultBadge,
  isShownFinalResult,
} from '../../features/record/seasonFinalResult';
import type { TradingAccountsDto } from '../../features/tradingAccount/api';
import { useAppearance } from '../../theme/appearance';
import { getScreenContentStyle } from '../../theme/screenLayout';
import { semantic } from '../../theme/tokens';
import { getHomeTier } from '../home/tierPresentation';
import TierEmblem from '../home/TierEmblem';
import SeasonBadgeCard from '../my/SeasonBadgeCard';
import { rankingFigureText } from '../ranking/StandingCard';

const IDS = TEST_IDS.seasonFinalResult;

/**
 * 시즌최종결과: one settled season's official result for me, in this order —
 * (title in the header) the final tier emblem, the tier's name under it, the
 * final rank, the return rate, the final assets, and the season's badge.
 *
 * Every figure is settlement's stored result from the server
 * (`/records/me/seasons/:id/final-result`); nothing is recomputed or revalued
 * at current prices. The badge is 내 뱃지's own card over the same rule.
 * A participant who did not qualify keeps their settled assets and return,
 * with 최종 랭킹 자격 미충족 in place of a rank and tier — never an invented
 * emblem or badge. An exclusion, a season still being settled and a result the
 * server cannot verify each say so instead.
 *
 * Seeing the result is recorded on the server (first view only) after a shown
 * result — not on a pending, failed or unverifiable read — and only the stored
 * answer flips the season entry from 시즌결과 확인하기 to the next-season action.
 */
export default function SeasonFinalResultScreen({ navigation, route }: SeasonFinalResultScreenProps) {
  const { seasonId } = route.params;
  const queryClient = useQueryClient();
  const resultKey = QUERY_KEYS.record.seasonFinalResult(seasonId);
  const resultQuery = useQuery({
    queryKey: resultKey,
    queryFn: () => getMySeasonFinalResult(seasonId),
  });
  const view = useMutation({
    mutationFn: () => markMySeasonFinalResultViewed(seasonId),
    onSuccess: (stored) => {
      // The server's stored first view, never a local guess.
      queryClient.setQueryData<SeasonFinalResultDto>(resultKey, (current) =>
        current ? { ...current, viewedAt: stored.viewedAt } : current);
      queryClient.setQueriesData<TradingAccountsDto>(
        { queryKey: QUERY_KEYS.tradingAccount.listAll },
        (current) => current && Array.isArray(current.accounts) ? {
          ...current,
          accounts: current.accounts.map((account) => account.season?.seasonId === stored.seasonId
            ? { ...account, season: { ...account.season, finalResultViewedAt: stored.viewedAt } }
            : account),
        } : current,
      );
      return queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tradingAccount.listAll });
    },
  });

  const data = resultQuery.data;
  const unseen = !!data && isShownFinalResult(data.result) && data.viewedAt === null;
  const { mutate, isIdle } = view;
  useEffect(() => {
    // Once per screen, after the result is on screen. A failed save is not
    // retried on its own: the entry keeps 시즌결과 확인하기 and the notice
    // below offers the retry.
    if (unseen && isIdle) mutate();
  }, [unseen, isIdle, mutate]);

  const close = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else resetToHome(navigation);
  };

  if (resultQuery.isLoading) {
    return <FullPageLoading message="시즌 최종결과를 불러오는 중입니다." />;
  }

  if (resultQuery.isError || !data) {
    return (
      <ErrorState
        error={resultQuery.error}
        title="시즌 최종결과를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void resultQuery.refetch()}
      />
    );
  }

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.screen}>
      <ScrollView testID={IDS.screen} style={styles.screen} contentContainerStyle={styles.content}>
        <SeasonTitle style={styles.seasonName} containerStyle={{ justifyContent: 'center' }} name={data.season.name} displayBadge={data.season.displayBadge} />
        <ResultBody data={data} onRetry={() => void resultQuery.refetch()} />
        {view.isError ? (
          <View style={styles.viewError}>
            <ErrorNotice
              error={view.error}
              message="결과 확인 상태를 저장하지 못했습니다. 다시 시도해주세요."
              style={styles.viewErrorText}
              testID={IDS.viewError}
            />
            <CTAButton testID={IDS.viewRetry} variant="neutral" label="다시 시도" onPress={() => mutate()} />
          </View>
        ) : null}
        <CTAButton testID={IDS.done} label="확인" onPress={close} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ResultBody({ data, onRetry }: { data: SeasonFinalResultDto; onRetry: () => void }) {
  const { result } = data;
  if (result.state === 'available' || result.state === 'not_qualified') {
    const ranked = result.state === 'available';
    const { rate, total } = rankingFigureText(result);
    const badge = finalResultBadge(data);
    return (
      <>
        <TierHero tierCode={ranked ? result.finalTier : null}
          fallbackName={ranked ? result.finalTier : FINAL_RANKING_NOT_QUALIFIED_LABEL} />
        <View style={styles.figures}>
          <Figure label="최종순위" testID={IDS.rank}
            value={ranked ? `${result.finalRank}위` : FINAL_RANKING_NOT_QUALIFIED_LABEL} />
          <Figure label="수익률" testID={IDS.returnRate} value={rate.text} color={rate.color} />
          <Figure label="최종자산" testID={IDS.totalAsset} value={total} />
        </View>
        <View testID={IDS.badge} style={styles.badgeSection}>
          <Text style={styles.sectionLabel}>최종 시즌 뱃지</Text>
          {badge ? (
            <>
              <SeasonBadgeCard badge={badge} />
              <Text style={styles.helper}>MY 탭의 내 뱃지에 보관됩니다.</Text>
            </>
          ) : (
            <Text testID={IDS.noBadge} style={styles.helper}>
              최종 랭킹 자격을 충족하지 못해 이 시즌의 뱃지가 없습니다.
            </Text>
          )}
        </View>
      </>
    );
  }
  if (result.state === 'excluded') {
    return (
      <>
        <TierHero tierCode={null} fallbackName="시즌 참가 제외" />
        <Status message="이 시즌 참가에서 제외되어 최종 순위와 티어, 뱃지가 없습니다." />
      </>
    );
  }
  if (result.state === 'pending') {
    return <Status message="시즌 결과를 정산하고 있습니다. 정산이 끝나면 최종 결과를 확인할 수 있습니다." />;
  }
  if (result.state === 'not_joined') {
    return <Status message="이 시즌에 참가하지 않아 최종 결과가 없습니다." />;
  }
  return (
    <>
      <Status message="저장된 시즌 최종 결과를 확인할 수 없습니다. 잠시 후 다시 시도해주세요." />
      <CTAButton variant="neutral" label="다시 불러오기" onPress={onRetry} />
    </>
  );
}

/** The emblem of the final tier, its name below; no tier → a plain ring, never an invented emblem. */
function TierHero({ tierCode, fallbackName }: { tierCode: string | null; fallbackName: string }) {
  const { mode } = useAppearance();
  const { width } = useWindowDimensions();
  const tier = getHomeTier(tierCode, mode);
  const size = width < 360 ? 132 : 160;
  return (
    <View style={styles.hero}>
      {tier ? (
        <TierEmblem tier={tier.id} size={size} testID={IDS.emblem} imageTestID={`${IDS.emblem}-image`} />
      ) : (
        <View testID={IDS.emblem} style={[styles.neutral, { width: size, height: size }]}
          accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <View style={styles.neutralRing}><Text style={styles.neutralMark}>—</Text></View>
        </View>
      )}
      <Text testID={IDS.tierName} style={styles.tierName}>{tier?.name ?? fallbackName}</Text>
    </View>
  );
}

function Figure({ label, value, color, testID }: { label: string; value: string; color?: string; testID: string }) {
  return (
    <View style={styles.figure} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text testID={testID} style={[styles.figureValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function Status({ message }: { message: string }) {
  return <Text testID={IDS.status} style={styles.status}>{message}</Text>;
}

/** Everything wraps (no numberOfLines): long season names, the 자격 미충족 line and large font scales stay whole. */
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24, gap: 16 },
  seasonName: { fontSize: 15, lineHeight: 22, fontWeight: '600', color: semantic.secondary, textAlign: 'center' },
  hero: { alignItems: 'center', gap: 8, minWidth: 0 },
  tierName: { fontSize: 22, lineHeight: 30, fontWeight: '800', color: semantic.text, textAlign: 'center' },
  neutral: { alignItems: 'center', justifyContent: 'center' },
  neutralRing: { width: '65%', height: '65%', borderRadius: 999, borderWidth: 1, borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' },
  neutralMark: { fontSize: 28, color: semantic.muted },
  figures: {
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: semantic.surface,
    minWidth: 0,
  },
  // A value moves under its label only when the two cannot share the line.
  figure: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 12,
    paddingVertical: 10,
    minWidth: 0,
  },
  figureLabel: { fontSize: 15, lineHeight: 22, color: semantic.secondary },
  figureValue: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '700',
    color: semantic.text,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  badgeSection: { gap: 8, minWidth: 0 },
  sectionLabel: { fontSize: 16, lineHeight: 24, fontWeight: '700', color: semantic.text },
  helper: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  status: { fontSize: 15, lineHeight: 23, color: semantic.secondary, textAlign: 'center' },
  viewError: { gap: 8 },
  viewErrorText: { fontSize: 13, lineHeight: 20, color: semantic.error },
});
