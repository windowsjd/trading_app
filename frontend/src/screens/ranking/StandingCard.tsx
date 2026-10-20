import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type TextStyle } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { getRecordFinancialDisplay } from '../../features/record/financialDisplay';
import { formatKrw } from '../../utils/format';
import { getHomeTier } from '../home/tierPresentation';
import TierCard, { tierForeground } from '../home/TierCard';
import type { TierSpotlight } from '../home/TierCardStage';

type Figures = { returnRate?: string | null; totalAssetKrw?: string | null };

/** One ranking row's figures, in the same words on 내 순위, in the list and on 내 뱃지. */
export function rankingFigureText(ranking: Figures | null) {
  const won = formatKrw(ranking?.totalAssetKrw);
  return { rate: getRecordFinancialDisplay(ranking?.returnRate, 'rate'), total: won === '-' ? '-' : `${won}원` };
}

/**
 * A season standing on the season tier card (TierCard keeps the tier's art,
 * and the emblem with the tier name on the right): 내 순위 on the Ranking tab
 * and every season card on 내 뱃지. The left column reads top to bottom:
 * `header` (the profile, or the season's name), the rank, then the return
 * rate and total assets of the standing's ranking row. Without a known tier
 * the same column sits on a plain card. Ids are `${testIDPrefix}-…`.
 *
 * The return rate reads exactly as the total assets do — the card's own ink
 * (the tier's foreground and halo on the art, the text color on the plain
 * card), no direction color or surface: the rise/fall colors stay with the
 * ranking rows and the TOP 3 podium.
 */
export default function StandingCard({
  testIDPrefix, tier: tierCode, header, rankLabel, rank, settled = false, figures,
  figureLabels = { rate: '수익률', total: '총자산' }, spotlight,
}: {
  testIDPrefix: string;
  /** The ranking API's tier code (`gold`, `master`, …); unknown or absent is no tier. */
  tier: string | null | undefined;
  header?: (foreground: TextStyle | undefined) => React.ReactNode;
  rankLabel: string;
  rank: number | null | undefined;
  /** Adds 최종 랭킹 확정 under the rank. */
  settled?: boolean;
  figures: Figures | null;
  figureLabels?: { rate: string; total: string };
  spotlight?: TierSpotlight;
}) {
  const { mode } = useAppearance();
  const { width } = useWindowDimensions();
  const tier = getHomeTier(tierCode, mode);
  const foreground = tier ? tierForeground(tier, mode) : undefined;
  const { rate, total } = rankingFigureText(figures);
  const label = [styles.label, foreground && styles.onArtLabel, foreground];
  const content = (
    <View style={styles.standing}>
      {header?.(foreground)}
      <View>
        <Text style={label}>{rankLabel}</Text>
        <Text testID={`${testIDPrefix}-rank`} style={[styles.rank, foreground]}>{rank ? `#${rank}` : '-'}</Text>
        {settled ? (
          <Text testID={`${testIDPrefix}-settled`} style={[styles.settledText, foreground && styles.onArtSettled,
            // Whale's art is dark even in Light, where the error red would not read.
            tier?.id === 'whale' && mode === 'light' && foreground]}>최종 랭킹 확정</Text>
        ) : null}
      </View>
      <View testID={`${testIDPrefix}-figures`} style={styles.figures} accessible
        accessibilityLabel={`${figureLabels.rate} ${rate.text}, ${figureLabels.total} ${total}`}>
        <View style={styles.figure}>
          <Text style={label}>{figureLabels.rate}</Text>
          <Text testID={`${testIDPrefix}-return`} style={[styles.figureValue, foreground]}>{rate.text}</Text>
        </View>
        <View style={styles.figure}>
          <Text style={label}>{figureLabels.total}</Text>
          <Text testID={`${testIDPrefix}-total`} style={[styles.figureValue, foreground]}>{total}</Text>
        </View>
      </View>
    </View>
  );
  if (!tier) {
    return <View testID={`${testIDPrefix}-card`} style={styles.card}>{content}</View>;
  }
  return (
    <View style={styles.tierCard}>
      <TierCard testID={`${testIDPrefix}-card`} tier={tier} mode={mode} emblemSize={width < 360 ? 104 : 124}
        caption={<Text testID={`${testIDPrefix}-tier`} style={[styles.tierCaption, foreground]}>{tier.name}</Text>}
        spotlight={spotlight}>
        {content}
      </TierCard>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
    marginBottom: 12,
  },
  tierCard: { marginBottom: 12 },
  onArtLabel: { fontWeight: '700' },
  onArtSettled: { fontWeight: '800' },
  // The left column: header, then the rank, then the figures, with room between the three.
  standing: { gap: 12, minWidth: 0 },
  rank: { fontSize: 32, lineHeight: 40, fontWeight: '800', fontVariant: ['tabular-nums'] },
  figures: { gap: 2, minWidth: 0 },
  // A value moves under its label only when the two cannot share the line;
  // alone on its line it may still wrap, so it never runs into the emblem.
  figure: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, minWidth: 0 },
  figureValue: { flexShrink: 1, minWidth: 0, fontSize: 16, lineHeight: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tierCaption: { fontSize: 15, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  label: { fontSize: 13, color: semantic.secondary },
  settledText: { color: semantic.error, fontWeight: '700' },
});
