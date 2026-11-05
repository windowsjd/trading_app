import { getErrorMessageFromCode } from '../../services/api/errorMapper.ts';

export const COLLATERAL_SHORT = "사용 가능한 담보가 부족합니다. 주문 금액이나 레버리지를 조정해주세요.";
export const MAINTENANCE_SHORT = "현재 평가 기준가로는 유지 증거금을 충족하지 못합니다. 레버리지를 낮춰주세요.";

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
    return "평가 기준가를 확인할 수 없습니다. 잠시 후 다시 시도해주세요.";
  if (code === "FUTURES_MAINTENANCE_UNSAFE") return MAINTENANCE_SHORT;
  if (code?.includes("COLLATERAL")) return COLLATERAL_SHORT;
  if (code === "FUTURES_VALUE_TOO_SMALL")
    return "주문 금액이 너무 작습니다. 금액을 늘려주세요.";
  if (code === "INVALID_FUTURES_REDUCE_QUANTITY")
    return "보유 수량을 초과할 수 없습니다. 최신 포지션을 확인해주세요.";
  if (code === "FUTURES_POSITION_NOT_FOUND")
    return "포지션이 이미 종료되었거나 변경되었습니다. 최신 상태를 확인해주세요.";
  // Two-way (2026-11-06): one position per contract AND direction; its
  // margin mode stays, and a leverage change needs the user's confirmation
  // (a stale screen meets the server's answer).
  if (code === "FUTURES_POSITION_ALREADY_OPEN")
    return "같은 방향의 포지션이 이미 열려 있습니다. 최신 포지션을 확인한 뒤 수량을 추가해주세요.";
  if (code === "FUTURES_ONE_WAY_VIOLATION")
    return "선택한 포지션과 방향이 다릅니다. 최신 포지션을 확인해주세요.";
  if (code === "FUTURES_LEVERAGE_MISMATCH")
    return "보유 포지션과 레버리지가 다릅니다. 레버리지 변경을 확인한 뒤 다시 주문해주세요.";
  if (code === "FUTURES_POSITION_CHANGED")
    return "포지션이 그사이 바뀌었습니다. 최신 레버리지와 수량을 확인한 뒤 다시 시도해주세요.";
  if (code === "FUTURES_MARGIN_MODE_MISMATCH")
    return "같은 방향의 보유 포지션과 증거금 방식이 다릅니다. 보유 포지션의 방식으로 주문해주세요.";
  if (code === "FUTURES_ENTRY_PENDING")
    return "같은 방향의 대기 중인 지정가 주문이 있습니다. 대기 주문을 확인해주세요.";
  // A beginner learning lock, not a rejected input (the server's staged rule).
  if (code === "BEGINNER_FEATURE_LOCKED") return getErrorMessageFromCode(code);
  return "주문이 접수되지 않았습니다. 입력값과 거래 가능 상태를 확인해주세요.";
}
