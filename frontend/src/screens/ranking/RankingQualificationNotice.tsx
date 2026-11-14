import React, { useEffect, useState } from 'react';
import type { TextStyle } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import Svg, { Path } from 'react-native-svg';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ActionPressable from '../../components/common/ActionPressable';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getRankingQualification } from '../../features/ranking/api';
import {
  qualificationNotice,
  qualificationRefreshMs,
  type QualificationCriterion,
} from '../../features/ranking/qualification';

/**
 * 최종 랭킹 참가 기준 안내 on the ranking tab (2026-11-14): one small red
 * line between 내 순위 and the ranking list, right above the list's tabs —
 * no card, background or border — shown only when the server says my
 * participation in this season does not meet its final-ranking criteria
 * (features/ranking/qualification.ts). The line and its ⓘ are one control
 * (a 44pt target, the 증거금 모드 ⓘ's mark) that opens the criteria in the
 * screens' floating sheet: required, current and still-needed instruments and
 * recognized turnover, exactly as the server counted them.
 *
 * It is information, not a block: trading and the provisional rank and tier
 * stay as they are. A failed read shows nothing.
 */
export default function RankingQualificationNotice({ seasonId, enabled, focused }: {
  seasonId: string | null | undefined;
  /** Only for a participant of this season (the server answers `not_joined` otherwise). */
  enabled: boolean;
  focused: boolean;
}) {
  const { colors } = useAppearance();
  const [open, setOpen] = useState(false);
  const askedSeasonId = seasonId ?? '';
  const query = useQuery({
    queryKey: QUERY_KEYS.ranking.qualification(askedSeasonId),
    queryFn: ({ signal }) => getRankingQualification(askedSeasonId, signal),
    enabled: enabled && !!seasonId,
    staleTime: 30_000,
    refetchInterval: (read) => qualificationRefreshMs(read.state.data, focused),
  });
  // Never left open over another tab, and closed once the verdict is gone.
  const notice = enabled && !query.isError ? qualificationNotice(query.data, seasonId, Date.now()) : null;
  const shown = !!notice;
  useEffect(() => {
    if (!focused || !shown) setOpen(false);
  }, [focused, shown]);
  if (!notice) return null;
  return (
    <>
      <ActionPressable testID="ranking-qualification-notice" style={styles.touch} onPress={() => setOpen(true)}
        accessibilityRole="button" accessibilityLabel={notice.text}
        accessibilityHint="최종 랭킹 참가 기준과 부족한 실적을 엽니다">
        <View style={styles.row}>
          <Text testID="ranking-qualification-text" style={styles.text}>{notice.text}</Text>
          <View testID="ranking-qualification-info" style={styles.info} {...HIDDEN}>
            <Svg width={16} height={16} viewBox="0 0 24 24" aria-hidden>
              <Path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5v.5" fill="none" stroke={colors.error}
                strokeWidth={2} strokeLinecap="round" />
            </Svg>
          </View>
        </View>
      </ActionPressable>
      <SheetPortal>
        <InlineBottomSheet testID="ranking-qualification-sheet" title="최종 랭킹 참가 기준" floating
          visible={open && focused} onClose={() => setOpen(false)}>
          <ScrollView style={styles.scroll} bounces={false}>
            <View style={styles.body} testID="ranking-qualification-body">
              <Text testID="ranking-qualification-basis" style={styles.basis}>{notice.basisLine}</Text>
              <Criterion testID="ranking-qualification-instruments" title="서로 다른 거래 종목" value={notice.instruments} />
              <Criterion testID="ranking-qualification-turnover" title="인정 거래대금" value={notice.turnover} />
              {notice.notes.map((note) => <Text key={note} style={styles.note}>{note}</Text>)}
            </View>
          </ScrollView>
        </InlineBottomSheet>
      </SheetPortal>
    </>
  );
}

/** One criterion: 필요 · 현재 · 추가 필요 (or 충족). A value moves under its label only when the two cannot share the line. */
function Criterion({ title, value, testID }: { title: string; value: QualificationCriterion; testID: string }) {
  const rows: Array<[string, string, boolean]> = [
    ['필요', value.required, false],
    ['현재 인정', value.current, false],
    ['추가 필요', value.remaining ?? '충족', !value.met],
  ];
  return (
    <View testID={testID} style={styles.criterion}>
      <Text style={styles.criterionTitle}>{title}</Text>
      {rows.map(([label, text, short]) => (
        <View key={label} style={styles.figure} accessible accessibilityLabel={`${title} ${label} ${text}`}>
          <Text style={styles.figureLabel}>{label}</Text>
          <Text testID={`${testID}-${label === '필요' ? 'required' : label === '현재 인정' ? 'current' : 'remaining'}`}
            style={[styles.figureValue, short && styles.figureShort]}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

const TABULAR: TextStyle['fontVariant'] = ['tabular-nums'];
const HIDDEN = {
  accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true,
} as const;

// Plain objects: loaded by harnesses with minimal native mocks.
const styles = {
  // The words start at the list's edge; the negative margin gives the press ink room (as 순위 안내).
  touch: { borderRadius: 10, paddingVertical: 6, paddingHorizontal: 8, marginHorizontal: -8, marginTop: -4, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  // Small and red, wrapping whole at narrow widths and large text (never cut).
  text: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 19, color: semantic.error },
  info: { width: 24, height: 24, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { gap: 12, paddingHorizontal: 4, paddingBottom: 8 },
  basis: { fontSize: 13, lineHeight: 19, color: semantic.secondary },
  criterion: { borderRadius: 12, paddingVertical: 4, paddingHorizontal: 12, backgroundColor: semantic.raised, minWidth: 0 },
  criterionTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text, paddingTop: 8 },
  figure: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
    columnGap: 12, paddingVertical: 6, minWidth: 0,
  },
  figureLabel: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  figureValue: {
    flexShrink: 1, minWidth: 0, fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text,
    textAlign: 'right', fontVariant: TABULAR,
  },
  figureShort: { color: semantic.error },
  note: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
} as const;
