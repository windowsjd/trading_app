/** Assets describe the market; selected-account permission is a separate gate. */
type AssetTradingState = {
  tradable?: boolean;
  tradeBlockedReason?: string | null;
};

const ASSET_BLOCK_MESSAGES: Record<string, string> = {
  ASSET_INACTIVE: '비활성 자산입니다.',
  MARKET_CLOSED: '현재 시장이 닫혀 있습니다.',
  PRICE_UNAVAILABLE: '현재 가격 데이터를 사용할 수 없습니다.',
  PRICE_STALE: '가격 데이터의 최신성이 낮습니다.',
  UNKNOWN: '시장 상태를 확인할 수 없습니다.',
};

// Compatibility for cached responses / a briefly older backend only. New
// Assets responses never emit these reasons. Ignore them in EVERY mode;
// account capability owns this decision, including for season accounts.
const LEGACY_ACCOUNT_REASONS = new Set([
  'SEASON_NOT_ACTIVE',
  'SEASON_NOT_JOINED',
  'PARTICIPANT_EXCLUDED',
  'PARTICIPANT_NOT_ACTIVE',
  'TRADING_ACCOUNT_NOT_ACTIVE',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_CLOSED',
]);

export function getAssetTradingWarning(
  asset: AssetTradingState,
): string | null {
  if (asset.tradable !== false) return null;
  const reason = asset.tradeBlockedReason?.trim().toUpperCase();
  if (reason && LEGACY_ACCOUNT_REASONS.has(reason)) return null;
  return (
    (reason && ASSET_BLOCK_MESSAGES[reason]) ||
    '거래 제한 가능성이 있습니다. 서버 견적에서 최종 확인됩니다.'
  );
}
