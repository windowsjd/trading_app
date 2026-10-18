import { getErrorMessageFromCode } from '../../services/api/errorMapper.ts';

export const COLLATERAL_SHORT = "사용 가능한 담보가 부족합니다. 주문 금액이나 레버리지를 조정해주세요.";
export const MAINTENANCE_SHORT = "현재 Mark 기준으로 유지 증거금을 충족하지 못합니다. 레버리지를 낮춰주세요.";

/**
 * A lost or failed response may have executed: it keeps its key and asks for
 * the same-request check. A clear refusal (4xx) did not fill and says why.
 */
export function futuresErrorMessage(code: string | null, uncertain: boolean) {
  if (uncertain)
    return "체결을 확인하지 못했습니다. 같은 요청을 다시 누르면 중복 체결 없이 결과를 확인합니다.";
  if (code === "FUTURES_INSTRUMENT_UNVERIFIED")
    return "현재 이 상품은 신규 진입할 수 없습니다. 보유 포지션의 Reduce/Close는 가능합니다.";
  if (code === "FUTURES_PRICE_UNAVAILABLE" || code === "FUTURES_PRICE_STALE")
    return "현재 거래 기준 시세를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.";
  if (code === "FUTURES_LIQUIDATION_REQUIRED")
    return "현재 손실과 수수료가 담보 범위를 초과합니다. 위험 관리 시스템의 전량 청산이 필요합니다.";
  if (code === "FUTURES_REDUCE_ONLY") return "현재 Reduce/Close만 가능합니다.";
  if (code === "FUTURES_TRADING_DISABLED")
    return "현재 선물 거래가 비활성 상태입니다.";
  if (code?.includes("MARK"))
    return "Mark 정보를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.";
  if (code === "FUTURES_MAINTENANCE_UNSAFE") return MAINTENANCE_SHORT;
  if (code?.includes("COLLATERAL")) return COLLATERAL_SHORT;
  if (code === "FUTURES_VALUE_TOO_SMALL")
    return "주문 금액이 너무 작습니다. 금액을 늘려주세요.";
  if (code === "INVALID_FUTURES_REDUCE_QUANTITY")
    return "보유 수량을 초과할 수 없습니다. 최신 포지션을 확인해주세요.";
  if (code === "FUTURES_POSITION_NOT_FOUND")
    return "포지션이 이미 종료되었거나 변경되었습니다. 최신 상태를 확인해주세요.";
  // A beginner learning lock, not a rejected input (the server's staged rule).
  if (code === "BEGINNER_FEATURE_LOCKED") return getErrorMessageFromCode(code);
  return "주문이 접수되지 않았습니다. 입력값과 거래 가능 상태를 확인해주세요.";
}
