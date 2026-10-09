import type { FuturesPosition, FuturesHolding } from './api';
import { freshFuturesEvaluation, freshFuturesEvidence } from './policy.ts';
import { formatMoneyDecimal, formatSignedPercent, getFinancialDirection, getAssetNameDisplay } from '../../utils/format.ts';

export function futuresHolding(position: FuturesPosition): FuturesHolding {
  return { ...position.instrument.underlying, direction: position.direction,
    marginMode: position.marginMode, leverage: position.leverage,
    markNotional: position.markNotional,
    roi: position.roi, markUnrealizedPnl: position.markUnrealizedPnl,
    markState: position.markState, markEvidence: position.markEvidence };
}

export function getFuturesPositionDisplay(position: FuturesHolding, evaluatedAt: string | undefined, now: number) {
  const fresh = position.markState === 'fresh' && freshFuturesEvaluation(evaluatedAt, now)
    && freshFuturesEvidence(position.markEvidence, now);
  const pnl = fresh ? formatMoneyDecimal(position.markUnrealizedPnl, 'USD', true) : '-';
  const roi = fresh ? formatSignedPercent(position.roi) : '-';
  return {
    name: getAssetNameDisplay(position).primary,
    direction: position.direction === 'long' ? 'LONG' : 'SHORT',
    margin: `${position.marginMode === 'cross' ? '교차' : '격리'} · ${position.leverage}x`,
    notional: fresh ? formatMoneyDecimal(position.markNotional, 'USD') : '-',
    pnl, roi, performance: fresh ? `${pnl} (${roi})` : '-',
    pnlDirection: fresh ? getFinancialDirection(position.markUnrealizedPnl) : 'neutral',
    fresh, notice: fresh ? null : 'Mark 확인 불가 · 평가 대기',
  };
}
