import React from 'react';
import Svg, { Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { StyleSheet, Text, View, type ViewStyle } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import { getRankingTier, type RankingRankType } from '../../features/ranking/api';
import type { PodiumEntry, PodiumPlace } from '../../features/ranking/podium';
import { getHomeTier } from '../home/tierPresentation';
import TierEmblem from '../home/TierEmblem';
import { rankingFigureText } from './StandingCard';

/** Per-place design values (TOP 3 시상대 spec). */
const PLACE = {
  1: { avatar: 56, ring: '#D6A935', height: 64, top: '#F8E8B4', bottom: '#EBC966', size: 30, line: 36, color: '#7D5A0B', pad: 8 },
  2: { avatar: 48, ring: '#AEB6C3', height: 50, top: '#EEF1F5', bottom: '#D3D9E1', size: 26, line: 32, color: '#566171', pad: 6 },
  3: { avatar: 48, ring: '#CF9566', height: 40, top: '#F5DEC8', bottom: '#E0B28A', size: 24, line: 30, color: '#80491F', pad: 4 },
} as const;
// Left to right: 2 · 1 · 3. Screen readers get the card's own label, in 1 · 2 · 3 order.
const VISUAL_ORDER: PodiumPlace[] = [2, 1, 3];
// The spec's light values; dark keeps the app's own roles.
const LIGHT = { tierText: '#5B6472', avatar: '#E6E9EE' };
const HIDDEN = {
  accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true,
} as const;

/**
 * TOP 3 시상대: a display-only block of the whole ranking's first three, from
 * the ranking tab's publication (no read of its own). No title, button or
 * motion; the visible text is the place numbers and each person's data.
 */
export default function RankingPodium({ entries, rankType, style }: {
  entries: PodiumEntry[];
  rankType?: RankingRankType;
  style?: ViewStyle;
}) {
  const { mode } = useAppearance();
  const byPlace = new Map(entries.map((entry) => [entry.place, entry]));
  const label = entries.map(({ place, item, mine }) => {
    const tier = getHomeTier(getRankingTier(item, rankType), mode);
    return `${place}위 ${item.nickname}${mine ? '(나)' : ''}, 수익률 ${rankingFigureText(item).rate.text}${tier ? `, ${tier.name} 티어` : ''}`;
  }).join('. ');
  return (
    <View testID="ranking-podium" style={[styles.card, style]} accessible accessibilityLabel={label}>
      <Svg {...HIDDEN} pointerEvents="none" width={300} height={110} style={styles.glow}>
        <Defs>
          <RadialGradient id="ranking-podium-glow" cx={150} cy={0} rx={150} ry={110} fx={150} fy={0} gradientUnits="userSpaceOnUse">
            <Stop offset={0} stopColor="#F0C95C" stopOpacity={0.3} />
            <Stop offset={1} stopColor="#F0C95C" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={300} height={110} fill="url(#ranking-podium-glow)" />
      </Svg>
      <View style={styles.columns} {...HIDDEN}>
        {VISUAL_ORDER.map((place) => {
          const entry = byPlace.get(place);
          return entry ? <PodiumColumn key={place} entry={entry} rankType={rankType} mode={mode} /> : null;
        })}
      </View>
    </View>
  );
}

function PodiumColumn({ entry, rankType, mode }: { entry: PodiumEntry; rankType?: RankingRankType; mode: 'light' | 'dark' }) {
  const { place, item, mine } = entry;
  const spec = PLACE[place];
  const tier = getHomeTier(getRankingTier(item, rankType), mode);
  const { rate } = rankingFigureText(item);
  const id = `ranking-podium-${place}`;
  return (
    <View testID={id} style={styles.column}>
      <View style={{ width: spec.avatar, height: spec.avatar }}>
        {/* 2 of the card's own color, then 2 of the place's ring, outside the avatar. */}
        <View style={[styles.ring, styles.gap]} />
        <View style={[styles.ring, styles.outerRing, { borderColor: spec.ring }]} />
        <ProfileAvatar profileImageUrl={item.profileImageUrl} size={spec.avatar} testID={`${id}-avatar`}
          frameStyle={mode === 'light' ? styles.avatarLight : styles.avatarDark} />
        {place === 1 ? (
          <Svg testID="ranking-podium-crown" width={26} height={16} viewBox="0 0 26 16" style={styles.crown}>
            <Defs>
              <LinearGradient id="ranking-podium-crown-fill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset={0} stopColor="#F6D365" />
                <Stop offset={1} stopColor="#D49A12" />
              </LinearGradient>
            </Defs>
            <Path d="M2 14L1 4l6 4.5L13 1l6 7.5L25 4l-1 10z" fill="url(#ranking-podium-crown-fill)" stroke="#B9830B" strokeWidth={1} />
          </Svg>
        ) : null}
      </View>
      <View style={styles.nameLine}>
        <Text testID={`${id}-name`} numberOfLines={1} ellipsizeMode="tail" style={styles.name}>{item.nickname}</Text>
        {mine ? (
          <View testID={`${id}-me`} style={styles.meChip}>
            <Text maxFontSizeMultiplier={1.3} style={styles.meChipText}>나</Text>
          </View>
        ) : null}
      </View>
      <Text testID={`${id}-return`} style={[styles.rate, { color: rate.color }]}>{rate.text}</Text>
      <View style={styles.tierLine}>
        {tier ? (
          <>
            <TierEmblem tier={tier.id} size={12} testID={`${id}-emblem`} imageTestID={`${id}-emblem-image`} />
            <Text testID={`${id}-tier`} style={[styles.tierName, mode === 'light' && styles.tierNameLight]}>{tier.name}</Text>
          </>
        ) : null}
      </View>
      {/* The design height, grown only when large text would clip its number. */}
      <View testID={`${id}-stand`} style={[styles.stand, { minHeight: spec.height }]}>
        <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
          <Defs>
            <LinearGradient id={`${id}-stand-fill`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset={0} stopColor={spec.top} />
              <Stop offset={1} stopColor={spec.bottom} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width="100%" height="100%" fill={`url(#${id}-stand-fill)`} />
        </Svg>
        <View style={styles.highlight} />
        <Text maxFontSizeMultiplier={1.3}
          style={[styles.number, { fontSize: spec.size, lineHeight: spec.line, color: spec.color, paddingTop: spec.pad }]}>{place}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: semantic.surface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 16,
    overflow: 'hidden',
    paddingTop: 22,
    paddingHorizontal: 10,
    paddingBottom: 0,
  },
  glow: { position: 'absolute', top: 0, left: '50%', marginLeft: -150 },
  columns: { flexDirection: 'row', alignItems: 'flex-end', columnGap: 4 },
  column: { flex: 1, minWidth: 0, alignItems: 'center' },
  ring: { position: 'absolute', borderRadius: 999, borderWidth: 2 },
  gap: { top: -2, right: -2, bottom: -2, left: -2, borderColor: semantic.surface },
  outerRing: { top: -4, right: -4, bottom: -4, left: -4 },
  avatarLight: { backgroundColor: LIGHT.avatar, borderWidth: 0 },
  avatarDark: { backgroundColor: semantic.raised, borderWidth: 0 },
  crown: { position: 'absolute', left: 15, top: -18 },
  nameLine: { marginTop: 12, minHeight: 18, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', columnGap: 4 },
  name: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 18, fontWeight: '700', color: semantic.text },
  // The list row's 나 chip.
  meChip: { flexShrink: 0, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: semantic.text },
  meChipText: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: semantic.surface },
  // Never cut: a figure too wide for its column wraps inside it.
  rate: { marginTop: 1, minHeight: 18, maxWidth: '100%', fontSize: 15, lineHeight: 18, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
  tierLine: { marginTop: 2, minHeight: 14, flexDirection: 'row', alignItems: 'center', columnGap: 4, maxWidth: '100%' },
  tierName: { flexShrink: 1, minWidth: 0, fontSize: 11, lineHeight: 14, color: semantic.secondary },
  tierNameLight: { color: LIGHT.tierText },
  stand: { marginTop: 10, width: '100%', borderTopLeftRadius: 12, borderTopRightRadius: 12, overflow: 'hidden', alignItems: 'center' },
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.75)' },
  number: { fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
});
