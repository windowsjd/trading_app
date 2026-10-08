import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";
import { QUERY_KEYS } from "../../constants/queryKeys";
import {
  findAccountPosition,
  getTradingAccountPositions,
} from "../../features/tradingAccount/api";
import { useTradingAccount } from "../../features/tradingAccount/TradingAccountContext";
import ProtectionPanel from "./ProtectionPanel";
export default function SpotProtectionPanel({
  accountId,
  assetId,
  onInputFocus,
  onInputBlur,
}: {
  accountId: string;
  assetId: string;
  onInputFocus?: (input: import("../../theme/native").View | null) => void;
  onInputBlur?: () => void;
}) {
  const { selectedAccountId } = useTradingAccount(),
    focused = useIsFocused();
  const positions = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, { assetId }),
    queryFn: () => getTradingAccountPositions(accountId, { assetId }),
    enabled: selectedAccountId === accountId && focused,
    refetchInterval: 4000,
  });
  const position =
    !positions.isError && positions.data?.tradingAccountId === accountId
      ? findAccountPosition(positions.data, assetId)
      : undefined;
  return (
    <ProtectionPanel
      accountId={accountId}
      assetId={assetId}
      domain="spot"
      positionId={
        Number(position?.quantity ?? "0") > 0 ? position?.positionId : undefined
      }
      currency={position?.currencyCode}
      onInputFocus={onInputFocus}
      onInputBlur={onInputBlur}
    />
  );
}
