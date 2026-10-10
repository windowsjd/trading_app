import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from '../../theme/native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from '../../theme/safeArea';
import { useAppearance } from '../../theme/appearance';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import MarketAssetRow from '../../features/market/MarketAssetRow';
import MarketSortControl from '../../features/market/MarketSortControl';
import type { MarketSort } from '../../features/market/marketSort';
import {
  MARKET_SEARCH_SCOPES,
  useMarketAssetSearch,
  type MarketSearchScope,
} from '../../features/market/useMarketAssetSearch';
import { useMarketTickers } from '../../features/market/useMarketTickers';
import { buildWsUrl } from '../../constants/env';

const OPEN_DURATION = 280;
const CLOSE_DURATION = 220;
const SHEET_TOP_GAP = 32;
const DISMISS_DISTANCE = 96;

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (assetId: string) => void;
};

/**
 * Asset picker over the order screen. The sheet slides up from the bottom and
 * back down on close; its content stays mounted for the closing motion only.
 * Selecting reports the asset id and leaves navigation to the order screen.
 */
export default function OrderAssetSheet({ visible, onClose, onSelect }: Props) {
  const reduced = useReducedMotion();
  const native = Platform.OS !== 'web';
  const [mounted, setMounted] = useState(visible);
  const openedRef = useRef(false);
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible && !openedRef.current) return;
    openedRef.current = visible;
    if (visible) {
      setMounted(true);
      drag.setValue(0);
    }
    if (reduced) {
      progress.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? OPEN_DURATION : CLOSE_DURATION,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: native,
      isInteraction: false,
    });
    // A reopen during the closing motion stops it unfinished and keeps the content.
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [drag, native, progress, reduced, visible]);

  if (!visible && !mounted) return null;
  return (
    <Modal
      testID="order-asset-sheet-modal"
      transparent
      visible
      statusBarTranslucent
      animationType="none"
      onRequestClose={() => {
        Keyboard.dismiss();
        onClose();
      }}
    >
      <SheetBody
        visible={visible}
        progress={progress}
        drag={drag}
        native={native}
        reduced={reduced}
        onClose={onClose}
        onSelect={onSelect}
      />
    </Modal>
  );
}

function SheetBody({ visible, progress, drag, native, reduced, onClose, onSelect }: Props & {
  progress: Animated.Value;
  drag: Animated.Value;
  native: boolean;
  reduced: boolean;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppearance();
  const wsUrl = useMemo(() => buildWsUrl('/api/v1/ws'), []);
  const [scope, setScope] = useState<MarketSearchScope>('all');
  const [searchText, setSearchText] = useState('');
  const [sort, setSort] = useState<MarketSort>('turnover_desc');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Unlike the search screen, an empty search lists assets right away.
  const { searchQuery, items, hasPriceErrors, trimmedSearchText } = useMarketAssetSearch({
    scope,
    searchText,
    sort,
    enabled: visible,
  });
  const assetIds = useMemo(() => items.map((item) => item.id), [items]);
  const { tickersByAssetId, staleAssetIds } = useMarketTickers({
    assetIds,
    wsUrl: wsUrl ?? '',
    enabled: visible && !!wsUrl,
  });

  // The list only gains bottom room for the keyboard; the header never moves,
  // whether or not the platform also resizes the modal window.
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (event) =>
      setKeyboardHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const close = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);
  const select = useCallback((assetId: string) => {
    Keyboard.dismiss();
    onSelect(assetId);
  }, [onSelect]);

  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) =>
      gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > DISMISS_DISTANCE || gesture.vy > 1.2) {
        close();
        return;
      }
      if (reduced) {
        drag.setValue(0);
        return;
      }
      Animated.timing(drag, {
        toValue: 0,
        duration: 160,
        easing: Easing.out(Easing.quad),
        useNativeDriver: native,
        isInteraction: false,
      }).start();
    },
    onPanResponderTerminate: () => drag.setValue(0),
  }), [close, drag, native, reduced]);

  const translateY = useMemo(
    () => Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }), drag),
    [drag, height, progress],
  );

  const loadingCopy = trimmedSearchText ? '검색 결과를 불러오는 중입니다.' : '종목 목록을 불러오는 중입니다.';
  return (
    <View style={styles.root}>
      <Animated.View pointerEvents="none" style={[styles.dim, { opacity: progress }]} />
      <ActionPressable
        testID="order-asset-sheet-backdrop"
        accessible={false}
        importantForAccessibility="no"
        style={styles.backdrop}
        onPress={close}
      />
      <Animated.View
        style={[styles.frame, { marginTop: insets.top + SHEET_TOP_GAP, transform: [{ translateY }] }]}
      >
        <View testID="order-asset-sheet" accessibilityViewIsModal aria-modal style={styles.sheet}>
          <View {...pan.panHandlers} style={styles.handleArea}>
            <View style={styles.grabber} />
            <View style={styles.titleRow}>
              <Text accessibilityRole="header" style={styles.title}>종목 선택</Text>
              <ActionPressable
                testID="order-asset-sheet-close"
                accessibilityRole="button"
                accessibilityLabel="종목 검색 닫기"
                style={styles.closeButton}
                onPress={close}
              >
                <Svg width={20} height={20} viewBox="0 0 24 24" aria-hidden>
                  <Path
                    d="M6 6l12 12M18 6L6 18"
                    fill="none"
                    stroke={colors.secondary}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                </Svg>
              </ActionPressable>
            </View>
          </View>
          <View style={styles.controls}>
            <TextInput
              testID="order-asset-search-input"
              accessibilityLabel="종목 검색"
              style={styles.searchInput}
              value={searchText}
              onChangeText={setSearchText}
              placeholder="종목명 또는 심볼 검색"
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
            <View style={styles.scopeRow}>
              {MARKET_SEARCH_SCOPES.map((option) => {
                const active = option.key === scope;
                return (
                  <ActionPressable
                    key={option.key}
                    testID={`order-asset-scope-${option.key}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${option.label} 시장`}
                    accessibilityState={{ selected: active }}
                    aria-selected={active}
                    style={[styles.scopeChip, active && styles.scopeChipActive]}
                    onPress={() => setScope(option.key)}
                  >
                    <Text style={active ? styles.scopeChipTextActive : styles.scopeChipText}>
                      {option.label}
                    </Text>
                  </ActionPressable>
                );
              })}
            </View>
            <View style={styles.sortRow}>
              <MarketSortControl value={sort} onChange={setSort} />
            </View>
          </View>
          <FlatList
            testID="order-asset-sheet-list"
            style={styles.list}
            data={items}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={[
              styles.listContent,
              { paddingBottom: Math.max(insets.bottom, keyboardHeight) + 16 },
            ]}
            onEndReached={() => {
              if (searchQuery.hasNextPage && !searchQuery.isFetching && !searchQuery.isError) {
                void searchQuery.fetchNextPage();
              }
            }}
            onEndReachedThreshold={0.4}
            ListHeaderComponent={hasPriceErrors ? (
              <View style={styles.inlineWarning}>
                <Text style={styles.inlineWarningText}>
                  일부 종목의 시세를 아직 불러오지 못했습니다.
                </Text>
                {searchQuery.data?.pages.flatMap((page) => page.priceErrors ?? [])
                  .map((error, index) => (
                    <AdminDiagnosticPanel key={index} diagnostic={error.diagnostic} />
                  ))}
              </View>
            ) : null}
            ListEmptyComponent={
              searchQuery.isLoading ? (
                <View testID="order-asset-sheet-loading" style={styles.state}>
                  <ActivityIndicator />
                  <Text style={styles.stateText}>{loadingCopy}</Text>
                </View>
              ) : searchQuery.isError ? (
                <View testID="order-asset-sheet-error" style={styles.state}>
                  <ErrorNotice
                    error={searchQuery.error}
                    message={trimmedSearchText ? '검색 결과를 불러오지 못했습니다.' : '종목 목록을 불러오지 못했습니다.'}
                    style={styles.errorText}
                  />
                  <CTAButton
                    variant="neutral"
                    label="다시 시도"
                    onPress={() => void searchQuery.refetch()}
                  />
                </View>
              ) : (
                <View testID="order-asset-sheet-empty" style={styles.state}>
                  <InlineEmptyState
                    title={trimmedSearchText ? '검색 결과가 없습니다.' : '표시할 종목이 없습니다.'}
                    message={trimmedSearchText
                      ? '다른 종목명 또는 심볼로 다시 검색해주세요.'
                      : '다른 시장을 선택해주세요.'}
                  />
                </View>
              )
            }
            renderItem={({ item }) => (
              <MarketAssetRow
                item={item}
                ticker={tickersByAssetId.get(item.id)}
                isStale={staleAssetIds.has(item.id)}
                onPress={select}
              />
            )}
            ListFooterComponent={
              searchQuery.isFetchNextPageError ? (
                <ActionPressable
                  accessibilityRole="button"
                  style={styles.footerRetry}
                  onPress={() => void searchQuery.refetch()}
                >
                  <Text style={styles.footerRetryText}>목록을 새로고침해 계속 보기</Text>
                </ActionPressable>
              ) : searchQuery.isFetchingNextPage ? (
                <View style={styles.footerLoader}>
                  <ActivityIndicator />
                </View>
              ) : null
            }
          />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  backdrop: { ...StyleSheet.absoluteFillObject },
  frame: { flex: 1 },
  sheet: {
    flex: 1,
    overflow: 'hidden',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: semantic.surface,
  },
  handleArea: { paddingTop: 8, paddingHorizontal: 16 },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: semantic.border,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    minHeight: 48,
  },
  title: { flexShrink: 1, fontSize: 18, fontWeight: '700', color: semantic.text },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    marginRight: -8,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controls: { paddingHorizontal: 16, paddingBottom: 8, gap: 10 },
  searchInput: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: semantic.input,
    fontSize: 16,
  },
  scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  scopeChip: {
    minHeight: 40,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: semantic.raised,
  },
  scopeChipActive: {
    backgroundColor: semantic.selected,
    borderColor: semantic.selected,
  },
  scopeChipText: { color: semantic.text, fontWeight: '600' },
  scopeChipTextActive: { color: semantic.onAccent, fontWeight: '600' },
  sortRow: { alignItems: 'flex-end' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 12, paddingTop: 4 },
  inlineWarning: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    backgroundColor: semantic.warningSurface,
  },
  inlineWarningText: { fontSize: 13, color: semantic.warning },
  state: { paddingVertical: 24, paddingHorizontal: 4, gap: 12, alignItems: 'stretch' },
  stateText: { fontSize: 14, color: semantic.secondary, textAlign: 'center' },
  errorText: { fontSize: 14, color: semantic.error, textAlign: 'center' },
  footerRetry: { minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  footerRetryText: { fontSize: 14, color: semantic.secondary },
  footerLoader: { paddingVertical: 16 },
});
