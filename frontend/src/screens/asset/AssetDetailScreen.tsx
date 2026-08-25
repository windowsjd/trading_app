import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Pressable,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import type { AssetDetailScreenProps } from "../../app/navigation/types";
import { useRootNavigation } from "../../app/navigation/navigationHooks";
import {
  ASSET_CHART_TIMEFRAMES,
  DEFAULT_ASSET_CHART_TIMEFRAME,
  getAssetCandles,
  getAssetDetail,
  type AssetChartTimeframe,
  type AssetDetailPriceDto,
} from "../../features/asset/api";
import {
  findAccountPosition,
  getTradingAccountPositions,
} from "../../features/tradingAccount/api";
import { getPositionDisplay } from "../../features/position/display";
import { useTradingAccount } from "../../features/tradingAccount/TradingAccountContext";
import { CAPABILITY_BLOCK_MESSAGE } from "../../features/tradingAccount/capabilities";
import { getIntegrityErrorMessage } from "../../features/tradingAccount/integrityErrors";
import { getAccountDisplay } from "../../features/tradingAccount/accountDisplay";
import { useAssetTicker } from "../../features/asset/useAssetTicker";
import { selectDisplayPrice } from "../../features/asset/displayPricePolicy";
import { useAssetCandle } from "../../features/asset/useAssetCandle";
import { describeCandleError } from "../../features/asset/candleErrors";
import { mergeAssetCandleSnapshot } from "../../features/asset/liveCandle";
import { isTradableMarketStatus } from "../../features/asset/mapper";
import { QUERY_KEYS } from "../../constants/queryKeys";
import { TEST_IDS } from "../../constants/testIds";
import { buildWsUrl } from "../../constants/env";
import {
  formatAssetPrice,
  formatKrw,
  formatPercent,
  getAssetNameDisplay,
  getUnavailablePriceText,
} from "../../utils/format";

import FullPageLoading from "../../components/states/FullPageLoading";
import ErrorState from "../../components/states/ErrorState";
import InlineEmptyState from "../../components/states/InlineEmptyState";
import SectionSkeleton from "../../components/states/SectionSkeleton";
import CTAButton from "../../components/common/CTAButton";
import { CandlestickChart } from "../../components/charts";

type Props = AssetDetailScreenProps;

function isPriceAvailable(price?: AssetDetailPriceDto | null) {
  return price?.state === "available" && !!price.currentPrice;
}

export default function AssetDetailScreen({ route, navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const { assetId } = route.params;
  const [selectedTimeframe, setSelectedTimeframe] =
    useState<AssetChartTimeframe>(DEFAULT_ASSET_CHART_TIMEFRAME);
  const assetTickerWsUrl = useMemo(() => buildWsUrl("/api/v1/ws"), []);

  // Market data is PUBLIC and shared by every account and every user, so asset
  // detail, price and candles keep their account-free cache keys (작업 10 §A-3).
  // Only the two user-owned facts below — what I hold and what I may do — are
  // account-scoped.
  const {
    selectedAccountId,
    selectedAccount,
    capabilities,
    isLoading: accountsLoading,
    isEmpty: noAccounts,
  } = useTradingAccount();
  const accountId = selectedAccountId ?? "";
  const hasAccount = !!selectedAccountId;

  const detailQuery = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId),
    queryFn: () => getAssetDetail(assetId),
  });

  const positionQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, {
      assetId,
      limit: 20,
    }),
    queryFn: () =>
      getTradingAccountPositions(accountId, { assetId, limit: 20, offset: 0 }),
    // No accountId, no financial request. An account-less call would either be
    // a legacy current-participant read or a 404 — both wrong here.
    enabled: hasAccount,
  });

  const candlesQuery = useQuery({
    queryKey: QUERY_KEYS.asset.candles(assetId, {
      range: selectedTimeframe.range,
      interval: selectedTimeframe.interval,
      limit: selectedTimeframe.limit,
    }),
    queryFn: () =>
      getAssetCandles(assetId, {
        range: selectedTimeframe.range,
        interval: selectedTimeframe.interval,
        limit: selectedTimeframe.limit,
      }),
  });

  const {
    latestTicker,
    showReconnectBanner,
    isStale: isTickerStale,
  } = useAssetTicker({
    assetId,
    wsUrl: assetTickerWsUrl ?? "",
    enabled: !!assetTickerWsUrl,
  });
  const {
    latestCandle,
    isStale: isCandleStale,
    resyncVersion: candleResyncVersion,
    liveEnabled: candleLiveEnabled,
  } = useAssetCandle({
    assetId,
    interval: selectedTimeframe.interval,
    wsUrl: assetTickerWsUrl ?? "",
    enabled: !!assetTickerWsUrl,
  });

  // `refetch` is identity-stable in react-query, so naming it as a dependency
  // states the real dependency without re-running on every render.
  const refetchCandles = candlesQuery.refetch;
  useEffect(() => {
    if (candleResyncVersion > 0) void refetchCandles();
  }, [candleResyncVersion, refetchCandles]);

  if (detailQuery.isLoading) {
    return <FullPageLoading message="종목 정보를 불러오는 중입니다." />;
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ErrorState
        title="종목 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const { asset } = detailQuery.data;
  const price = asset.price;
  // The quantity shown, and the quantity 매도 is gated on, both come from the
  // SELECTED account's position read. Because the query key carries the
  // accountId, a switch produces a different query with no data rather than the
  // previous account's holdings under the new account's heading.
  const position = findAccountPosition(positionQuery.data, assetId);
  const hasPosition = Number(position?.quantity ?? "0") > 0;
  const positionDisplay = position ? getPositionDisplay(position) : null;
  const accountDisplay = selectedAccount
    ? getAccountDisplay(selectedAccount)
    : null;
  const priceAvailable = isPriceAvailable(price);
  const livePriceAvailable = !!latestTicker?.priceLocal;
  const orderPriceAvailable = priceAvailable || livePriceAvailable;

  // ONE basis for the whole price block: while a realtime ticker is shown,
  // its local price and KRW state/reason are taken from that ticker — REST and
  // realtime values are never mixed (see displayPricePolicy).
  const displayPrice = selectDisplayPrice({
    latestTicker,
    restPrice: price,
    assetPriceCurrency: asset.priceCurrency,
    assetDisplayPriceDecimals: asset.displayPriceDecimals,
  });
  const displayPriceLocal = displayPrice.priceLocal;
  const displayPriceCurrency =
    displayPrice.priceCurrency ?? asset.priceCurrency;
  const displayPriceKrw = displayPrice.priceKrw;
  const displayPriceKrwState = displayPrice.priceKrwState;
  // Same basis as every other price field: a realtime ticker without a change
  // rate shows no change rate — the older REST one never fills in next to a
  // newer realtime price.
  const displayChangeRate = displayPrice.changeRate;
  const displayPriceDecimals = displayPrice.displayPriceDecimals;
  const displayPriceKrwMessage = displayPrice.priceKrwMessage;
  const assetNameDisplay = getAssetNameDisplay(asset);
  // Dev-only chart diagnostics (never rendered in production builds): how many
  // candles the API returned vs requested for the selected range/interval, and
  // whether the provider window was truncated (Binance single-call cap).
  const isDevBuild = (globalThis as { __DEV__?: boolean }).__DEV__ === true;
  const chartDebugInfo =
    isDevBuild && candlesQuery.data
      ? `dev · candles=${candlesQuery.data.candles.length} · req=${
          candlesQuery.data.source?.requestedCount ?? "-"
        } · ret=${candlesQuery.data.source?.returnedCount ?? "-"} · ${
          candlesQuery.data.range
        }/${candlesQuery.data.interval}${
          candlesQuery.data.source?.truncated ? " · truncated" : ""
        }`
      : null;
  const chartCandles = mergeAssetCandleSnapshot(
    candlesQuery.data,
    isCandleStale ? null : latestCandle,
    selectedTimeframe.limit,
  );

  /**
   * Trading permission comes from the SELECTED account, not from a global
   * `getCurrentSeason()` (작업 10 §A-3). Those are different questions: the app
   * can be in the middle of an active season while the account the user is
   * looking at is their general account, a settled season's account, or a
   * suspended one. The season fact that matters is the one attached to THIS
   * account, which `getTradingAccountCapabilities` already reads from
   * `account.season.seasonStatus`.
   */
  const accountBlockedReason = accountsLoading
    ? "계정 정보를 확인하는 중입니다."
    : noAccounts || !capabilities
      ? "거래 가능한 계정이 없습니다."
      : capabilities.tradeBlockReason
        ? CAPABILITY_BLOCK_MESSAGE[capabilities.tradeBlockReason]
        : null;

  // Server-detected damage is never presented as "you hold nothing".
  const positionIntegrityMessage = positionQuery.isError
    ? getIntegrityErrorMessage(positionQuery.error)
    : null;

  const assetHardBlockedReason = !asset.isActive ? "비활성 자산입니다." : null;

  const assetWarningReason = !asset.tradable
    ? (asset.tradeBlockedReason ??
      "거래 제한 가능성이 있습니다. 서버 견적에서 최종 확인됩니다.")
    : !isTradableMarketStatus(asset.marketStatus)
      ? "장 상태는 주문 견적에서 최종 확인됩니다."
      : isTickerStale
        ? "실시간 시세 최신성이 낮습니다. 서버 견적에서 최종 확인됩니다."
        : !orderPriceAvailable
          ? "현재 화면 시세가 없어도 서버 견적에서 최종 확인됩니다."
          : displayPriceKrwState && displayPriceKrwState !== "available"
            ? (displayPriceKrwMessage ??
              "KRW 환산 시세를 사용할 수 없습니다. 서버 견적에서 최종 확인됩니다.")
            : null;

  const buyBlockedReason = accountBlockedReason ?? assetHardBlockedReason;
  const sellBlockedReason =
    buyBlockedReason ??
    (positionQuery.isError
      ? "보유 수량을 확인할 수 없어 매도할 수 없습니다."
      : positionQuery.isLoading
        ? "보유 수량을 확인하는 중입니다."
        : // 매도 is gated on THIS account's real quantity — never on a cached
          // number from a previously selected account.
          !hasPosition
          ? "보유 수량이 없어 매도할 수 없습니다."
          : null);

  const openOrderScreen = (side: "buy" | "sell") => {
    if (!selectedAccountId) return;
    // The account is pinned into the route: the order flow targets the account
    // that was selected when the button was pressed, whatever happens to the
    // selection afterwards (작업 10 §A-2).
    navigation.navigate("Order", {
      assetId,
      side,
      accountId: selectedAccountId,
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        testID={TEST_IDS.assetDetail.screen}
        contentContainerStyle={styles.content}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{assetNameDisplay.primary}</Text>
          {assetNameDisplay.secondary ? (
            <Text style={styles.helper}>{assetNameDisplay.secondary}</Text>
          ) : null}
          <Text style={styles.value}>
            {orderPriceAvailable
              ? formatAssetPrice(
                  displayPriceLocal,
                  displayPriceCurrency,
                  displayPriceDecimals,
                )
              : getUnavailablePriceText(asset)}
          </Text>
          <Text style={styles.helper}>
            KRW 환산{" "}
            {displayPriceKrwState === "available"
              ? formatKrw(displayPriceKrw)
              : `사용 불가${
                  displayPrice.priceKrwReason
                    ? ` (${displayPrice.priceKrwReason})`
                    : ""
                }`}
          </Text>
          <Text style={styles.helper}>
            등락률 {formatPercent(displayChangeRate)}%
          </Text>
          <Text style={styles.helper}>시장 상태: {asset.marketStatus}</Text>
          <Text style={styles.helper}>
            거래 상태: {asset.tradable ? "거래 가능" : "거래 제한"}
          </Text>
          <Text style={styles.helper}>
            결제 통화 {asset.settlementCurrency}
          </Text>
          {asset.settlementCurrency === "USD" ? (
            <Text style={styles.helper}>USD Wallet으로 결제됩니다.</Text>
          ) : null}
          {buyBlockedReason ? (
            <View
              testID={TEST_IDS.tradingAccount.capabilityNotice}
              style={styles.inlineWarning}
            >
              <Text style={styles.inlineWarningText}>{buyBlockedReason}</Text>
              {capabilities?.isSeason &&
              capabilities.tradeBlockReason === "season_not_active" ? (
                <Pressable
                  style={styles.retryButton}
                  onPress={() => rootNavigation.navigate("SeasonJoin")}
                >
                  <Text style={styles.retryText}>시즌 안내 보기</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {assetWarningReason ? (
            <View style={styles.inlineWarning}>
              <Text style={styles.inlineWarningText}>{assetWarningReason}</Text>
            </View>
          ) : null}

          {showReconnectBanner ? (
            <View
              testID={TEST_IDS.assetDetail.reconnectBanner}
              style={styles.banner}
            >
              <Text style={styles.bannerText}>
                실시간 연결이 불안정합니다. 마지막 성공 데이터를 표시 중입니다.
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          {/* WHICH account these holdings belong to is stated on the card
              itself: a quantity with no account next to it is not an answer to
              "do I own this" when the user holds several accounts. */}
          <Text style={styles.label}>
            내 포지션
            {accountDisplay ? ` · ${accountDisplay.title}` : ""}
          </Text>
          {accountDisplay ? (
            <Text style={styles.accountBadge}>
              {accountDisplay.statusLabel}
            </Text>
          ) : null}
          {!hasAccount ? (
            <InlineEmptyState
              title="계정이 없습니다."
              message="계정을 개설하면 보유 현황을 볼 수 있습니다."
            />
          ) : positionQuery.isLoading ? (
            <SectionSkeleton lines={4} />
          ) : positionIntegrityMessage ? (
            <>
              <InlineEmptyState
                title="보유 내역을 안전하게 표시할 수 없습니다."
                message={positionIntegrityMessage}
              />
              <Pressable
                style={styles.retryButton}
                onPress={() => void positionQuery.refetch()}
              >
                <Text style={styles.retryText}>포지션 다시 시도</Text>
              </Pressable>
            </>
          ) : positionQuery.isError ? (
            <>
              <InlineEmptyState
                title="포지션을 불러오지 못했습니다."
                message="자산 정보는 계속 볼 수 있습니다."
              />
              <Pressable
                style={styles.retryButton}
                onPress={() => void positionQuery.refetch()}
              >
                <Text style={styles.retryText}>포지션 다시 시도</Text>
              </Pressable>
            </>
          ) : hasPosition && position ? (
            <>
              <Text style={styles.helper}>
                수량 {positionDisplay?.quantity ?? "-"}
              </Text>
              <Text style={styles.helper}>
                평균단가 {positionDisplay?.averageCost ?? "-"}
              </Text>
              <Text style={styles.helper}>
                현재가 {positionDisplay?.currentPrice ?? "시세 조회 불가"}
              </Text>
              <Text style={styles.helper}>
                평가금액 {positionDisplay?.positionValueKrw ?? "-"}
              </Text>
              <Text style={styles.helper}>
                평가손익 {positionDisplay?.unrealizedPnlKrw ?? "-"}
              </Text>
              <Text style={styles.helper}>
                수익률 {positionDisplay?.returnRate ?? "-"}
              </Text>
              {positionDisplay?.priceNotice ? (
                <Text style={styles.inlineWarningText}>
                  {positionDisplay.priceNotice}
                </Text>
              ) : null}
            </>
          ) : (
            <InlineEmptyState
              title="보유 없음"
              message="아직 이 자산을 보유하고 있지 않습니다."
            />
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>차트</Text>
          <View style={styles.row}>
            {ASSET_CHART_TIMEFRAMES.map((tab) => {
              const active = tab.interval === selectedTimeframe.interval;
              return (
                <Pressable
                  key={tab.interval}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setSelectedTimeframe(tab)}
                >
                  <Text
                    style={active ? styles.chipTextActive : styles.chipText}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {candlesQuery.isLoading ? (
            <SectionSkeleton lines={5} />
          ) : candlesQuery.isError ? (
            <>
              {/* A failed chart request must read as a failure with its
                  reason, not as a loading skeleton. The one exception is the
                  5m baseline still syncing, which is a "preparing" state. */}
              <InlineEmptyState
                title={describeCandleError(candlesQuery.error).title}
                message={describeCandleError(candlesQuery.error).message}
              />
              <Pressable
                testID={TEST_IDS.assetDetail.chartRetry}
                style={styles.retryButton}
                onPress={() => void candlesQuery.refetch()}
              >
                <Text style={styles.retryText}>차트 다시 시도</Text>
              </Pressable>
            </>
          ) : chartCandles.length ? (
            <CandlestickChart
              candles={chartCandles}
              currencyCode={displayPriceCurrency}
              displayPriceDecimals={displayPriceDecimals}
              currentPrice={latestTicker?.priceLocal ?? null}
              emptyMessage="가격 추이를 표시하려면 데이터가 더 필요합니다."
              viewportResetKey={`${assetId}:${selectedTimeframe.interval}`}
            />
          ) : (
            <InlineEmptyState message="표시할 차트 데이터가 없습니다." />
          )}
          {candleLiveEnabled && isCandleStale ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>
                실시간 캔들이 지연되어 HTTP 기준 데이터를 표시 중입니다.
              </Text>
            </View>
          ) : null}
          {candleLiveEnabled && latestCandle?.delayed ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>
                미국 캔들은 KIS 지연 체결 피드를 사용합니다.
              </Text>
            </View>
          ) : null}
          {chartDebugInfo ? (
            <Text style={styles.debug}>{chartDebugInfo}</Text>
          ) : null}
        </View>

        <View style={styles.row}>
          <CTAButton
            testID={TEST_IDS.assetDetail.buyButton}
            label="매수"
            state={buyBlockedReason ? "blocked" : "enabled"}
            style={styles.flex}
            onPress={() => openOrderScreen("buy")}
          />
          <CTAButton
            testID={TEST_IDS.assetDetail.sellButton}
            label="매도"
            state={sellBlockedReason ? "blocked" : "enabled"}
            style={styles.flex}
            onPress={() => openOrderScreen("sell")}
          />
        </View>

        {sellBlockedReason && !buyBlockedReason ? (
          <Text style={styles.errorText}>{sellBlockedReason}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  row: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  flex: { flex: 1 },
  card: {
    borderWidth: 1,
    borderColor: "#e8e8e8",
    borderRadius: 14,
    padding: 16,
    backgroundColor: "#fafafa",
    gap: 8,
  },
  title: { fontSize: 24, fontWeight: "700" },
  label: { fontSize: 13, color: "#666" },
  value: { fontSize: 20, fontWeight: "700" },
  helper: { fontSize: 14, color: "#444" },
  // Its own line and its own track: a status that can be shrunk away by a long
  // season name is a status that reads as "운영 중" when it is not.
  accountBadge: {
    alignSelf: "flex-start",
    flexShrink: 0,
    fontSize: 12,
    fontWeight: "700",
    color: "#333",
    backgroundColor: "#ececec",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    overflow: "hidden",
  },
  debug: { fontSize: 11, color: "#9aa0a6", marginTop: 6 },
  errorText: { fontSize: 14, color: "#c62828" },
  chip: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  chipActive: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  chipText: { color: "#111", fontWeight: "600" },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  retryButton: {
    marginTop: 8,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#111",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
  },
  retryText: { color: "#111", fontWeight: "600" },
  inlineWarning: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#F2D48B",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#FFF8E1",
    gap: 8,
  },
  inlineWarningText: { color: "#725400", fontSize: 13 },
  banner: {
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "#FFF3CD",
  },
  bannerText: {
    color: "#7A5D00",
    fontSize: 13,
  },
});
