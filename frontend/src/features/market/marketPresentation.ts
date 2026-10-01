import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';
import { formatPercent } from '../../utils/format.ts';
import { getAssetTradingWarning } from '../asset/tradingUx.ts';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy';
import type { AssetType, MarketAssetItemDto } from './api';
import { mergeMarketAssetTicker } from './mergeMarketAssetTicker.ts';

/** Presentation only: the paired price/changeRate has already passed ticker policy. */
export function getMarketChangeDisplay(item: MarketAssetItemDto) {
  const value = item.price?.state === 'available' ? item.price.changeRate : null;
  const rate = value?.trim() ? Number(value) : NaN;
  if (!Number.isFinite(rate)) return { text: '-', color: semantic.secondary };
  return {
    text: `${rate > 0 ? '+' : ''}${formatPercent(value)}%`,
    color: rate > 0 ? financial.rise : rate < 0 ? financial.fall : semantic.secondary,
  };
}

/** Keep exceptional restrictions visible without replacing the price or change. */
export function getMarketException(item: MarketAssetItemDto): string | null {
  if (item.isActive === false) return '비활성 종목';
  if (item.marketStatus === 'unknown') return '시장 상태 확인 불가';
  if (item.price?.state !== 'available') return '시세 확인 불가';
  const reason = item.tradeBlockedReason?.trim().toUpperCase();
  if (reason === 'MARKET_CLOSED' && item.marketStatus === 'closed') return null;
  if (!getAssetTradingWarning(item)) return null;
  if (reason === 'PRICE_UNAVAILABLE') return '시세 확인 불가';
  if (reason === 'PRICE_STALE') return '시세 지연';
  return '거래 제한';
}

/** Consensus of authoritative loaded rows, using the same accepted overlay as each row.
 * No clock/calendar inference, or assumption that one symbol speaks for the tab. */
export function getMarketSessionLabel(assetType: AssetType, items: readonly MarketAssetItemDto[], tickers: ReadonlyMap<string, AssetTickerMessage>): string {
  const states = new Set(items.filter((item) => item.assetType === assetType)
    .map((item) => mergeMarketAssetTicker(item, tickers.get(item.id)).marketStatus));
  if (!states.size) return '시장 상태 확인 중';
  if (states.has('unknown')) return '시장 상태 확인 불가';
  if (states.size !== 1) return '시장 상태 확인 중';
  if (assetType === 'crypto') return states.has('always_open') ? '24시간 거래' : '시장 상태 확인 불가';
  if (states.has('open')) return '정규장 · 거래 중';
  if (states.has('closed')) return '휴장 · 거래 종료';
  return '시장 상태 확인 불가';
}
