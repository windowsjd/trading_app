import React, { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getMe, type MeDto } from '../../features/me/api';
import {
  acceptCommunityRules,
  canManageCommunity,
  getCommunityBootstrap,
  type CommunityBootstrapDto,
} from '../../features/community/api';
import { communityWriteGate } from '../../features/community/gates';
import { getApiErrorCode, getErrorMessageFromCode } from '../../services/api/errorMapper';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';

/** The signed-in member: every community key is theirs (mine, likedByMe, operator fields). */
export function useCommunityViewer() {
  const me = useQuery<MeDto>({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000 }).data;
  return { userId: me?.id ?? null, canModerate: canManageCommunity(me?.role) };
}

export function useCommunityBootstrap(userId: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.community.bootstrap(userId ?? ''),
    queryFn: ({ signal }) => getCommunityBootstrap(signal),
    enabled: !!userId,
    staleTime: 60_000,
  });
}

/**
 * The write gate of one community screen (contract §6.4–6.5): a write starts
 * only when the bootstrap says the rules are accepted and no restriction is
 * active. Before a first write the rules sheet opens; 동의하고 계속 records the
 * consent and then runs the write the member had started. A restricted member
 * gets the restriction notice instead. The server still decides every write:
 * a 403 for either reason re-reads the bootstrap and shows the same steps.
 */
export function useCommunityWrite(userId: string | null) {
  const queryClient = useQueryClient();
  const bootstrap = useCommunityBootstrap(userId);
  const gate = communityWriteGate(bootstrap.data, bootstrap.isError);
  const pending = useRef<(() => void) | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const bootstrapKey = QUERY_KEYS.community.bootstrap(userId ?? '');

  const consent = useMutation({
    mutationFn: (rulesVersion: string) => acceptCommunityRules(rulesVersion),
    retry: false,
    onSuccess: ({ rulesVersion }) => {
      queryClient.setQueryData<CommunityBootstrapDto>(bootstrapKey, (data) => data && data.rulesVersion === rulesVersion
        ? { ...data, rulesAccepted: true } : data);
      setRulesOpen(false);
      const action = pending.current;
      pending.current = null;
      action?.();
    },
    onError: (error) => {
      // A newer rules version: read it, the sheet shows the new list.
      if (getApiErrorCode(error) === 'INVALID_COMMUNITY_RULES_VERSION') void bootstrap.refetch();
    },
  });

  /** Runs `action` now, or after the rules sheet's consent; never while restricted. */
  const requireWrite = useCallback((action: () => void) => {
    setNotice(null);
    if (gate.kind === 'open') { action(); return; }
    if (gate.kind === 'restricted') { setNotice(gate.message); return; }
    if (gate.kind === 'rules') { pending.current = action; consent.reset(); setRulesOpen(true); return; }
    // Unknown: read it again; the member taps again once it is known.
    void bootstrap.refetch();
    setNotice(gate.kind === 'loading' ? '커뮤니티 정보를 확인하고 있어요. 잠시 후 다시 시도해주세요.'
      : '커뮤니티 정보를 불러오지 못했어요. 잠시 후 다시 시도해주세요.');
  }, [bootstrap, consent, gate]);

  /** A write refused for the rules or a restriction: refresh what the screen offers. */
  const handleWriteError = useCallback((error: unknown) => {
    const code = getApiErrorCode(error);
    if (code === 'COMMUNITY_RULES_NOT_ACCEPTED' || code === 'COMMUNITY_RESTRICTED') {
      void queryClient.invalidateQueries({ queryKey: bootstrapKey });
      return true;
    }
    return false;
  }, [bootstrapKey, queryClient]);

  const rulesSheet = bootstrap.data ? (
    <SheetPortal>
      <InlineBottomSheet testID="community-rules-sheet" title="커뮤니티 이용규칙" visible={rulesOpen}
        dismissible={!consent.isPending} onClose={() => { pending.current = null; setRulesOpen(false); }}>
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10, paddingBottom: 4 }}>
          {bootstrap.data.reasons.map((reason) => (
            <View key={reason.code} testID={`community-rule-${reason.code}`} style={{ gap: 2 }}>
              <Text style={{ fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{reason.label}</Text>
              <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.secondary }}>{reason.description}</Text>
            </View>
          ))}
          <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.text, marginTop: 4 }}>
            위 기준에 해당하는 글은 운영자가 삭제하고, 반복하면 커뮤니티 이용이 제한될 수 있어요
          </Text>
        </ScrollView>
        {consent.isError ? (
          <ErrorNotice testID="community-rules-error" error={consent.error}
            message={getErrorMessageFromCode(getApiErrorCode(consent.error))} style={{ fontSize: 13, color: semantic.warning }} />
        ) : null}
        <CTAButton testID="community-rules-accept" label="동의하고 계속" state={consent.isPending ? 'loading' : 'enabled'}
          onPress={() => { if (!consent.isPending && bootstrap.data) consent.mutate(bootstrap.data.rulesVersion); }} />
      </InlineBottomSheet>
    </SheetPortal>
  ) : null;

  return { bootstrap, gate, requireWrite, handleWriteError, notice, clearNotice: () => setNotice(null), rulesSheet };
}
