import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { StyleSheet, View } from '../../theme/native';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import { TEST_IDS } from '../../constants/testIds';

const STAR =
  'M12 3.6l2.57 5.2 5.74.84-4.15 4.05.98 5.71L12 16.7l-5.14 2.7.98-5.71L3.69 9.64l5.74-.84z';

type Props = {
  assetId: string;
  /** Spoken with the action, e.g. "삼성전자 관심종목에 추가". */
  assetName: string;
  /** null: server state unknown (loading or failed) — not "unwatched". */
  watched: boolean | null;
  /** A request is unanswered; the star shows its target and waits. */
  pending: boolean;
  onChange: (assetId: string, watched: boolean) => void;
};

/** The row's own watchlist target, separate from the row's detail press. */
export default function WatchlistToggle({ assetId, assetName, watched, pending, onChange }: Props) {
  const { colors } = useAppearance();
  const unavailable = watched === null || pending;
  const label = watched === null
    ? `${assetName} 관심종목 상태 확인 중`
    : watched ? `${assetName} 관심종목에서 해제` : `${assetName} 관심종목에 추가`;
  return (
    <ActionPressable
      testID={TEST_IDS.market.watchToggle(assetId)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: watched === true, disabled: unavailable, busy: pending }}
      // RN Web reads only the aria-* forms of the same state.
      aria-selected={watched === true}
      aria-busy={pending}
      aria-disabled={unavailable}
      disabled={unavailable}
      style={styles.target}
      onPress={() => {
        if (watched !== null && !pending) onChange(assetId, !watched);
      }}
    >
      <View style={unavailable ? styles.dimmed : styles.icon}>
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Path
            d={STAR}
            fill={watched ? colors.text : 'none'}
            stroke={watched ? colors.text : colors.secondary}
            strokeWidth={1.8}
            strokeLinejoin="round"
          />
        </Svg>
      </View>
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  // Full row height at the trailing edge, never narrower than the 44dp target.
  target: {
    alignSelf: 'stretch',
    minWidth: 48,
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  icon: { opacity: 1 },
  dimmed: { opacity: 0.45 },
});
