import AdminDiagnosticPanel from "../../components/states/AdminDiagnosticPanel";
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "../../theme/native";
import { useIsFocused } from "@react-navigation/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTradingAccount } from "../../features/tradingAccount/TradingAccountContext";
import { QUERY_KEYS } from "../../constants/queryKeys";
import {
  getSessionGeneration,
  isCurrentSession,
} from "../../services/api/sessionOwnership";
import { getApiErrorInfo } from "../../services/api/errorMapper";
import { createIdempotencyKey } from "../../utils/idempotency";
import { formatDisplayDecimal } from "../../utils/format";
import { semantic } from "../../theme/tokens";
import CTAButton from "../../components/common/CTAButton";
import ActionPressable from "../../components/common/ActionPressable";
import {
  cancelProtection,
  createProtection,
  getProtections,
  type ProtectionCreate,
} from "./api";
import {
  draftLegs,
  emptyProtection,
  ProtectionEditor,
  protectionInputError,
  protectionLabel,
} from "./ProtectionEditor";
import { invalidateAfterOrderCreate } from "../tradingAccount/invalidation";

type Props = {
  accountId: string;
  assetId: string;
  domain: "spot" | "futures";
  positionId?: string;
  currency?: string;
  onInputFocus?: (input: View | null) => void;
  onInputBlur?: () => void;
};
export default function ProtectionPanel(props: Props) {
  const { selectedAccountId } = useTradingAccount();
  return (
    <BoundProtectionPanel
      key={`${props.accountId}:${props.domain}:${props.assetId}:${props.positionId ?? ""}:${selectedAccountId}:${getSessionGeneration()}`}
      {...props}
    />
  );
}
export function BoundProtectionPanel({
  accountId,
  assetId,
  domain,
  positionId,
  currency,
  onInputFocus,
  onInputBlur,
}: Props) {
  const { selectedAccountId } = useTradingAccount();
  const focused = useIsFocused(),
    client = useQueryClient();
  const bound = selectedAccountId === accountId;
  const [history, setHistory] = useState(false),
    [draft, setDraft] = useState(emptyProtection),
    [message, setMessage] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const scope = useRef({ key: "", epoch: 0, mounted: true });
  const key = `${accountId}:${selectedAccountId}:${getSessionGeneration()}`;
  if (scope.current.key !== key)
    scope.current = { key, epoch: scope.current.epoch + 1, mounted: true };
  useEffect(() => {
    scope.current.mounted = true;
    return () => {
      scope.current.mounted = false;
    };
  }, []);
  const action = useRef<{
    epoch: number;
    session: number;
    key: string;
    body?: ProtectionCreate;
    groupId?: string;
  } | null>(null);
  const lock = useRef(false);
  const [failure, setFailure] = useState<unknown>(null);
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.protections.list(
      accountId,
      domain,
      assetId,
      true,
    ),
    queryFn: ({ signal }) =>
      getProtections(accountId, domain, assetId, true, signal),
    enabled: bound && focused,
    refetchInterval: 2000,
    retry: false,
  });
  const data =
    !query.isError && query.data?.tradingAccountId === accountId
      ? query.data
      : undefined;
  const active = data?.groups.find(
    (g) => g.status === "active" || g.status === "holding",
  );
  const validScope = (request: NonNullable<typeof action.current>) =>
    scope.current.mounted &&
    request.epoch === scope.current.epoch &&
    isCurrentSession(request.session);
  const submit = async (groupId?: string) => {
    if (!bound || lock.current) return;
    if (!uncertain) {
      if (
        !groupId &&
        (protectionInputError(draft) || !draftLegs(draft).length || !positionId)
      ) {
        setMessage(
          protectionInputError(draft) ?? "익절 또는 손절 조건을 선택해주세요.",
        );
        return;
      }
      const idempotencyKey = createIdempotencyKey("protection");
      action.current = {
        epoch: scope.current.epoch,
        session: getSessionGeneration(),
        key: idempotencyKey,
        ...(groupId
          ? { groupId }
          : {
              body: {
                domain,
                assetId,
                positionId: positionId,
                legs: draftLegs(draft),
                idempotencyKey,
              },
            }),
      };
    }
    const request = action.current;
    if (!request || !validScope(request)) return;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      if (request.groupId)
        await cancelProtection(accountId, request.groupId, request.key);
      else if (request.body) await createProtection(accountId, request.body);
      else return;
      if (isCurrentSession(request.session)) {
        await invalidateAfterOrderCreate(client, accountId, { seasonUi: true });
        await client.invalidateQueries({
          queryKey: QUERY_KEYS.tradingAccount.futures.all(accountId),
        });
      }
      if (validScope(request)) {
        setDraft(emptyProtection());
        setUncertain(false);
        action.current = null;
        setMessage(
          request.groupId
            ? "보호 조건을 취소했습니다."
            : "익절·손절 보호를 등록했습니다.",
        );
      }
    } catch (error) {
      if (validScope(request)) {
        const info = getApiErrorInfo(error);
        setFailure(error);
        setUncertain(!info.hasResponse || (info.status ?? 0) >= 500);
        setMessage(
          info.serverCode === "PROTECTION_ALREADY_TRIGGERED"
            ? "현재 거래 기준가의 반대쪽에 있는 조건 가격을 확인해주세요."
            : info.serverCode === "CONDITIONAL_PRICE_UNAVAILABLE"
              ? "최신 거래 기준가를 확인할 수 없습니다. 잠시 후 다시 시도해주세요."
              : "보호 조건을 처리하지 못했습니다. 상태를 확인하고 다시 시도해주세요.",
        );
      }
    } finally {
      lock.current = false;
      if (validScope(request)) setBusy(false);
    }
  };
  if (!bound) return null;
  if (query.isPending)
    return <Text style={styles.hint}>익절·손절 상태 확인 중…</Text>;
  if (query.isError)
    return (
      <View style={styles.card}>
        <Text style={styles.text}>익절·손절 정보를 불러오지 못했습니다.</Text>
        <AdminDiagnosticPanel error={query.error} />
        <CTAButton label="다시 조회" onPress={() => void query.refetch()} />
      </View>
    );
  if (!data || (!data.capabilities.enabled && !data.groups.length)) return null;
  const canCreate =
    domain === "spot"
      ? data.capabilities.canCreateSpot
      : data.capabilities.canCreateFutures;
  return (
    <View style={styles.card} testID="protection-panel">
      <Text style={styles.heading}>
        익절·손절 보호
        {(active?.currencyCode ?? currency)
          ? ` · ${active?.currencyCode ?? currency}`
          : ""}
      </Text>
      <Text style={styles.hint}>
        {domain === "futures"
          ? "현재가 / Spot 거래 기준으로 조건을 확인합니다. Mark 청산과는 별개입니다."
          : "해당 계정의 남은 보유 수량 전체를 보호합니다."}
      </Text>
      {active && !canCreate ? (
        <Text style={styles.hint}>
          현재 운영 상태에서는 조건 실행이 일시 중지됩니다. 보호 조건 조회와
          취소는 가능합니다.
        </Text>
      ) : null}
      {active ? (
        <View style={styles.stack}>
          {active.status === "holding" ? (
            <Text style={styles.text}>
              진입 주문 체결 대기 · 익절/손절은 체결 후 활성화
            </Text>
          ) : (
            <Text style={styles.text}>
              남은 수량 {formatDisplayDecimal(active.remainingQuantity ?? "0")}{" "}
              보호 중
            </Text>
          )}
          {active.legs.map((leg) => (
            <View key={leg.id} style={styles.leg}>
              <Text style={styles.heading}>{protectionLabel[leg.kind]}</Text>
              <Text style={styles.text}>
                조건 {formatDisplayDecimal(leg.triggerPrice)}
              </Text>
              <Text style={styles.text}>
                실행{" "}
                {leg.childOrderType === "market"
                  ? "시장가"
                  : `지정가 ${formatDisplayDecimal(leg.childLimitPrice ?? "0")}`}
              </Text>
              <Text style={styles.hint}>
                {leg.state === "triggered"
                  ? "조건 충족 · 실행/체결 대기"
                  : leg.state === "holding"
                    ? "진입 체결 후 감시 시작"
                    : !canCreate
                      ? "조건 실행 일시 중지"
                      : "계속 감시 중"}
              </Text>
            </View>
          ))}
          {active.legs.length === 2 ? (
            <Text style={styles.hint}>
              OCO · 실제 종료 전까지 반대 조건도 유지합니다. 반대 조건 충족 시
              미체결 주문을 교체합니다.
            </Text>
          ) : null}
          <CTAButton
            label="보호 조건 취소"
            state={busy || uncertain ? "disabled" : "enabled"}
            onPress={() => void submit(active.id)}
          />
        </View>
      ) : positionId && canCreate ? (
        <>
          <ProtectionEditor
            value={draft}
            onChange={setDraft}
            disabled={busy || uncertain}
            canLimit={domain === "futures" || data.capabilities.canUseSpotLimit}
            onInputFocus={onInputFocus}
            onInputBlur={onInputBlur}
          />
          <CTAButton
            label="보호 조건 등록"
            state={busy || uncertain ? "disabled" : "enabled"}
            onPress={() => void submit()}
          />
        </>
      ) : (
        <Text style={styles.hint}>
          {positionId
            ? "현재 운영 상태에서는 새 보호 조건을 등록할 수 없습니다."
            : "열린 Position에서 익절·손절을 등록할 수 있습니다."}
        </Text>
      )}
      {message ? (
        <Text style={styles.text} accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      <AdminDiagnosticPanel error={failure} />
      {uncertain ? (
        <CTAButton
          label="동일 요청 결과 다시 확인"
          state={busy ? "disabled" : "enabled"}
          onPress={() => void submit()}
        />
      ) : null}
      <ActionPressable
        accessibilityRole="button"
        testID="protection-history-toggle"
        onPress={() => setHistory(!history)}
        style={styles.history}
      >
        <Text style={styles.text}>
          {history ? "현재 보호만 보기" : "최근 보호 이력 보기"}
        </Text>
      </ActionPressable>
      {history ? (
        <Text style={styles.hint}>
          최근 보호 최대 30건 · 각 보호의 최근 조건 충족 최대 20건
        </Text>
      ) : null}
      {history
        ? data.groups.map((g) => (
            <View key={g.id} style={styles.leg}>
              <Text style={styles.text}>
                {g.status === "completed"
                  ? "보호 완료"
                  : g.status === "canceled"
                    ? "보호 취소"
                    : g.status === "holding"
                      ? "진입 체결 대기"
                      : "보호 중"}{" "}
                · {g.createdAt.slice(0, 10)}
              </Text>
              {g.children.map((c) => (
                <Text key={c.id} style={styles.hint}>
                  조건 충족 {formatDisplayDecimal(c.triggerEvidence.price)} ·{" "}
                  {c.status === "filled"
                    ? "실행됨"
                    : c.status === "canceled"
                      ? "취소/교체됨"
                      : "체결 대기"}
                </Text>
              ))}
            </View>
          ))
        : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    padding: 14,
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    minWidth: 0,
  },
  stack: { gap: 10, minWidth: 0 },
  leg: { gap: 6, paddingVertical: 8, minWidth: 0 },
  heading: {
    color: semantic.text,
    fontSize: 15,
    fontWeight: "700",
    flexShrink: 1,
  },
  text: { color: semantic.text, fontSize: 14, flexShrink: 1 },
  hint: { color: semantic.secondary, fontSize: 12, flexShrink: 1 },
  history: { minHeight: 44, justifyContent: "center" },
});
