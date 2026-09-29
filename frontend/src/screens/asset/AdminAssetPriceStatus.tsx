import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAdminDiagnostics } from '../../features/auth/useAdminDiagnostics';
import {
  isPositiveInput,
  isPreviewPriceAvailable,
} from '../../features/tradingAccount/indicativePreview';
import type { AssetDetailPriceDto } from '../../features/asset/api';
import type { AssetTickerMessage } from '../../features/asset/assetTickerPolicy';
import {
  STALE_FRESHNESS_THRESHOLD_SECONDS,
  parseTickerTimestamp,
} from '../../features/asset/assetTickerPolicy';
import type { DisplayPrice } from '../../features/asset/displayPricePolicy';
import { useStaleRecheck } from '../../features/asset/useStaleRecheck';
import type { AssetPriceErrorDto } from '../../features/market/api';

type Props = {
  assetId: string;
  restPrice?: AssetDetailPriceDto | null;
  priceErrors?: AssetPriceErrorDto[];
  ticker?: AssetTickerMessage | null;
  displayPrice: DisplayPrice;
  connectionState?: string;
  reconnecting?: boolean;
  tickerStale?: boolean;
};

/** Actual screen/preview facts, separate from backend AdminDiagnosticDto. */
export default function AdminAssetPriceStatus({
  assetId,
  restPrice,
  priceErrors,
  ticker,
  displayPrice,
  connectionState,
  reconnecting = false,
  tickerStale = false,
}: Props) {
  const isAdmin = useAdminDiagnostics();
  const [now, setNow] = useState(() => Date.now());
  useStaleRecheck(isAdmin && !!displayPrice.priceLocal, () =>
    setNow(Date.now()),
  );

  const previewAvailable = isPreviewPriceAvailable(displayPrice, now);
  const krwUnavailable = displayPrice.priceKrwState === 'unavailable';
  const restUnavailable = !!restPrice && restPrice.state !== 'available';
  if (
    !isAdmin ||
    (previewAvailable && !restUnavailable && !krwUnavailable && !reconnecting && !tickerStale)
  )
    return null;

  const timestamp = parseTickerTimestamp(
    displayPrice.priceCapturedAt ?? displayPrice.priceEffectiveAt,
  );
  const ageSeconds =
    timestamp === null ? null : Math.floor(Math.max(0, now - timestamp) / 1000);
  const previewReason = !displayPrice.priceLocal
    ? '선택된 시세에 현재가가 없습니다.'
    : !isPositiveInput(displayPrice.priceLocal, 8)
      ? '선택된 현재가의 값 또는 형식이 유효하지 않습니다.'
      : timestamp === null
        ? '선택된 시세의 시각이 없습니다.'
        : !previewAvailable
          ? `선택된 시세가 preview 기준 ${STALE_FRESHNESS_THRESHOLD_SECONDS}초를 초과했습니다.`
          : null;
  const restErrors =
    priceErrors?.filter((error) => error.assetId === assetId) ?? [];
  const basis =
    displayPrice.basis === 'realtime'
      ? 'WebSocket 실시간'
      : displayPrice.basis === 'snapshot'
        ? 'WebSocket snapshot'
        : displayPrice.basis === 'rest'
          ? 'REST'
          : '없음';

  return (
    <View style={styles.container} testID="admin-asset-price-status">
      <Text style={styles.title}>관리자 시세 상태</Text>
      <Text style={styles.line}>화면 시세 기준: {basis}</Text>
      <Text style={styles.line}>
        REST 가격 상태: {restPrice?.state ?? '없음'}
      </Text>
      <Text style={styles.line}>
        REST 가격 오류:{' '}
        {restErrors.map((error) => error.code ?? 'code 없음').join(', ') ||
          '없음'}
      </Text>
      <Text style={styles.line}>
        시장가 참고 시세: {previewAvailable ? '사용 가능' : '사용 불가'}
      </Text>
      {previewReason ? (
        <Text style={styles.line}>제한 이유: {previewReason}</Text>
      ) : null}
      {krwUnavailable ? (
        <Text style={styles.line}>
          KRW 환산: 사용 불가
          {displayPrice.priceKrwReason
            ? ` · ${displayPrice.priceKrwReason}`
            : ''}
          {displayPrice.priceKrwMessage
            ? ` · ${displayPrice.priceKrwMessage}`
            : ''}
        </Text>
      ) : null}
      {displayPrice.priceCapturedAt || displayPrice.priceEffectiveAt ? (
        <Text style={styles.line}>
          선택 시세 시각:{' '}
          {displayPrice.priceCapturedAt ?? displayPrice.priceEffectiveAt}
          {ageSeconds !== null ? ` · 경과 ${ageSeconds}초` : ''}
        </Text>
      ) : null}
      {restPrice?.reason || restPrice?.message ? (
        <Text style={styles.line}>
          REST 사유:{' '}
          {[restPrice.reason, restPrice.message].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      {ticker ? (
        <Text style={styles.line}>
          WebSocket 현재가: {ticker.priceLocal === null ? '없음' : '있음'}
          {ticker.reason ? ` · ${ticker.reason}` : ''}
          {ticker.message ? ` · ${ticker.message}` : ''}
        </Text>
      ) : null}
      {reconnecting || tickerStale ? (
        <Text style={styles.line}>
          WebSocket 상태: {connectionState ?? '미확인'}
          {reconnecting ? ' · 재연결 중' : ''}
          {tickerStale ? ' · 최신성 저하' : ''}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 10,
    backgroundColor: '#fff9e8',
    borderRadius: 6,
    gap: 4,
  },
  title: { color: '#725400', fontSize: 12, fontWeight: '700' },
  line: { color: '#725400', fontSize: 11 },
});
