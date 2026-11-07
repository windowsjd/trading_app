import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Text, View, type StyleProp, type ViewStyle } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { useAppearance } from '../../theme/appearance';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getAssetDetail } from '../../features/asset/api';
import { formatSignedPercent, getAssetNameDisplay, getFinancialDirection } from '../../utils/format';
import type { CommunityAssetTag } from '../../features/community/api';
import type { CommunityAuthorDisplay } from '../../features/community/authorDisplay';
import { formatCommunityCount } from '../../features/community/format';
import { getTierAccent } from '../home/tierPresentation';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import ActionPressable from '../../components/common/ActionPressable';
import CommunityIcon from '../../components/community/CommunityIcon';

/**
 * Pieces shared by the feed card, the post detail, the composer and Home's
 * rolling card. Plain style objects (no module-level StyleSheet): several
 * screen harnesses load these with minimal react-native mocks.
 */

/** A public author's photo; 익명 and 탈퇴계정 get the dark default head instead (no identity to show). */
export function CommunityAvatar({ display, size, testID }: { display: Pick<CommunityAuthorDisplay, 'kind' | 'profileImageUrl'>; size: number; testID?: string }) {
  if (display.kind === 'public') return <ProfileAvatar profileImageUrl={display.profileImageUrl} size={size} testID={testID} />;
  const dark = display.kind === 'anonymous';
  return (
    <View testID={testID} accessible={false} style={{
      width: size, height: size, borderRadius: size / 2, overflow: 'hidden', flexShrink: 0,
      backgroundColor: dark ? semantic.inverse : semantic.raised, borderWidth: 1, borderColor: dark ? semantic.inverse : semantic.border,
    }}>
      <View style={{ position: 'absolute', width: '32%', height: '32%', left: '34%', top: '20%', borderRadius: 999,
        backgroundColor: dark ? semantic.muted : semantic.border }} />
      <View style={{ position: 'absolute', width: '66%', height: '50%', left: '17%', top: '60%', borderRadius: 999,
        backgroundColor: dark ? semantic.muted : semantic.border }} />
    </View>
  );
}

/** ◆ Gold: an 8px diamond in the tier's color and its 11px name; nothing without a tier. */
export function TierMark({ tier, name }: { tier: string | null; name: string | null }) {
  const { mode } = useAppearance();
  const accent = getTierAccent(tier, mode);
  if (!accent || !name) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }} accessible={false}>
      <View style={{ width: 7, height: 7, backgroundColor: accent, transform: [{ rotate: '45deg' }] }} />
      <Text style={{ fontSize: 11, lineHeight: 15, color: semantic.secondary }} maxFontSizeMultiplier={1.6}>{name}</Text>
    </View>
  );
}

/** 글쓴이: the anonymous post's author commenting on it. */
export function PostAuthorTag() {
  return (
    <View style={{ borderWidth: 1, borderColor: semantic.border, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1, flexShrink: 0 }}>
      <Text style={{ fontSize: 10, lineHeight: 14, fontWeight: '700', color: semantic.secondary }} maxFontSizeMultiplier={1.6}>글쓴이</Text>
    </View>
  );
}

/**
 * The asset tag: the app's display name and, when the shared asset detail
 * read has it, the day's change in the financial colors. The detail is the
 * one the asset and order screens already read (one cached request per asset).
 */
export function AssetTagChip({ asset, onPress, onRemove, testID }: {
  asset: CommunityAssetTag; onPress?: () => void; onRemove?: () => void; testID?: string;
}) {
  const { colors } = useAppearance();
  const detail = useQuery({
    queryKey: QUERY_KEYS.asset.detail(asset.id),
    queryFn: () => getAssetDetail(asset.id),
    staleTime: 60_000,
    retry: false,
  });
  const name = getAssetNameDisplay(asset).primary ?? asset.symbol;
  const price = detail.data?.asset?.price;
  const rate = price?.state === 'available' ? price.changeRate ?? null : null;
  const direction = getFinancialDirection(rate);
  const content = (
    <>
      <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: semantic.text, flexShrink: 1 }}
        maxFontSizeMultiplier={1.6}>{name}</Text>
      {rate !== null ? (
        <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '700', flexShrink: 0,
          color: direction === 'rise' ? financial.rise : direction === 'fall' ? financial.fall : semantic.secondary }}
          maxFontSizeMultiplier={1.6}>{formatSignedPercent(rate)}</Text>
      ) : null}
      {onRemove ? (
        <ActionPressable testID={testID ? `${testID}-remove` : undefined} accessibilityRole="button" accessibilityLabel={`${name} 태그 삭제`}
          onPress={onRemove} hitSlop={8} style={{ marginLeft: 2, minWidth: 20, minHeight: 20, alignItems: 'center', justifyContent: 'center' }}>
          <CommunityIcon name="close" size={14} color={colors.secondary} />
        </ActionPressable>
      ) : null}
    </>
  );
  const style: StyleProp<ViewStyle> = { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%',
    minHeight: 28, borderRadius: 8, paddingHorizontal: 10, backgroundColor: semantic.input };
  return onPress ? (
    <ActionPressable testID={testID} accessibilityRole="button" accessibilityLabel={`종목 ${name}`} onPress={onPress} style={style}>
      {content}
    </ActionPressable>
  ) : <View testID={testID} style={style}>{content}</View>;
}

/** One category chip (36dp, the selected one inverted); HOT carries the flame. */
export function CategoryChip({ category, label, selected, onPress, testID }: {
  category: string; label: string; selected: boolean; onPress: () => void; testID?: string;
}) {
  const { colors } = useAppearance();
  const hot = category === 'hot';
  return (
    <ActionPressable feedback="selection" testID={testID} accessibilityRole="tab" accessibilityLabel={label}
      accessibilityState={{ selected }} aria-selected={selected} onPress={onPress}
      style={{ minHeight: 36, borderRadius: 18, paddingLeft: hot ? 11 : 14, paddingRight: 14, flexDirection: 'row',
        alignItems: 'center', gap: 4, backgroundColor: selected ? semantic.inverse : semantic.input }}>
      {hot ? <CommunityIcon name="flame" size={14} color={selected ? colors.onInverse : colors.hot} /> : null}
      <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: selected ? '700' : '400', color: selected ? semantic.onInverse : semantic.text }}
        maxFontSizeMultiplier={1.6}>{label}</Text>
    </ActionPressable>
  );
}

/** A like or comment count button (40dp, icon 18 + count 13). */
export function CountButton({ icon, count, active = false, label, onPress, disabled, testID, height = 40 }: {
  icon: 'heart' | 'comment'; count: number; active?: boolean; label: string; onPress?: () => void;
  disabled?: boolean; testID?: string; height?: number;
}) {
  const { colors, financialColors, mode } = useAppearance();
  const tint = active ? financialColors.rise[mode] : colors.secondary;
  const content = (
    <>
      <CommunityIcon name={icon} size={18} color={tint} filled={active} />
      <Text style={{ fontSize: 13, lineHeight: 18, color: active ? financial.rise : semantic.secondary, fontVariant: ['tabular-nums'] }}
        maxFontSizeMultiplier={1.6}>{formatCommunityCount(count)}</Text>
    </>
  );
  const style: StyleProp<ViewStyle> = { minHeight: height, minWidth: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 };
  return onPress ? (
    <ActionPressable testID={testID} accessibilityRole="button" accessibilityLabel={`${label} ${count}`}
      accessibilityState={{ selected: active, disabled: !!disabled }} aria-selected={active} disabled={disabled}
      onPress={onPress} style={style}>{content}</ActionPressable>
  ) : <View testID={testID} style={style} accessible accessibilityLabel={`${label} ${count}`}>{content}</View>;
}

/** The translucent photo count chip in a photo's lower right. */
export function PhotoCountChip({ text, testID }: { text: string; testID?: string }) {
  const { colors } = useAppearance();
  return (
    <View testID={testID} pointerEvents="none" style={{ position: 'absolute', right: 8, bottom: 8, flexDirection: 'row', alignItems: 'center',
      gap: 4, paddingHorizontal: 8, minHeight: 24, borderRadius: 12, backgroundColor: semantic.scrim }}>
      <CommunityIcon name="photo" size={14} color={colors.onScrim} />
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '700', color: semantic.onScrim }} maxFontSizeMultiplier={1.4}>{text}</Text>
    </View>
  );
}
