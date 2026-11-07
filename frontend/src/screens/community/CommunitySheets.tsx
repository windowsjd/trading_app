import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView, Text, TextInput, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  COMMUNITY_LIMITS,
  createCommunitySanction,
  getOperatorCommunityUser,
  revokeCommunitySanction,
  type CommunityReason,
  type CommunityReasonCode,
  type CommunitySanctionDuration,
} from '../../features/community/api';
import { communityTextLength, formatKstDate } from '../../features/community/format';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineBottomSheet from '../../components/common/InlineBottomSheet';
import { SheetPortal } from '../../components/common/ScreenSheetHost';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import SegmentedControl from '../../components/common/SegmentedControl';
import CommunityIcon from '../../components/community/CommunityIcon';
import WhaleLoader from '../../components/states/WhaleLoader';
import { getHomeTierName } from '../home/tierPresentation';
import { CommunityAvatar, TierMark } from './CommunityParts';

/** The [관리자] tag of operator-only sheets and rows. */
export function AdminTag() {
  return (
    <View style={{ borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: semantic.inverse }}>
      <Text style={{ fontSize: 11, lineHeight: 15, fontWeight: '700', color: semantic.onInverse }} maxFontSizeMultiplier={1.4}>관리자</Text>
    </View>
  );
}

/** A bottom sheet in the tab layer with a title row (an optional [관리자] tag) and 닫기. */
export function CommunitySheet({ visible, onClose, title, admin = false, dismissible = true, testID, children }: {
  visible: boolean; onClose: () => void; title: string; admin?: boolean; dismissible?: boolean; testID: string; children: React.ReactNode;
}) {
  return (
    <SheetPortal>
      <InlineBottomSheet testID={testID} visible={visible} onClose={onClose} dismissible={dismissible}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 4 }}>
          <Text accessibilityRole="header" style={{ fontSize: 18, lineHeight: 26, fontWeight: '700', flexShrink: 1 }}>{title}</Text>
          {admin ? <AdminTag /> : null}
          <View style={{ flex: 1 }} />
          <ActionPressable testID={`${testID}-close`} accessibilityRole="button" accessibilityLabel="닫기" disabled={!dismissible}
            onPress={onClose} style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: semantic.secondary, opacity: dismissible ? 1 : 0.4 }}>닫기</Text>
          </ActionPressable>
        </View>
        {children}
      </InlineBottomSheet>
    </SheetPortal>
  );
}

export type SheetAction = { key: string; label: string; danger?: boolean; chevron?: boolean; admin?: boolean; onPress: () => void };

/** A list of actions (⋯ menus): one 52dp row each. */
export function ActionList({ actions, testID }: { actions: readonly SheetAction[]; testID: string }) {
  const { colors } = useAppearance();
  return (
    <View style={{ gap: 4, paddingBottom: 4 }}>
      {actions.map((action) => (
        <ActionPressable key={action.key} testID={`${testID}-${action.key}`} accessibilityRole="button" accessibilityLabel={action.label}
          onPress={action.onPress} style={{ minHeight: 52, borderRadius: 12, paddingHorizontal: 12, flexDirection: 'row',
            alignItems: 'center', gap: 8, backgroundColor: semantic.raised }}>
          <Text style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '600', color: action.danger ? semantic.error : semantic.text }}>
            {action.label}
          </Text>
          {action.admin ? <AdminTag /> : null}
          {action.chevron ? <CommunityIcon name="chevron" size={16} color={colors.muted} /> : null}
        </ActionPressable>
      ))}
    </View>
  );
}

/** One reason as a selectable row: label and the server's description. */
function ReasonRow({ reason, selected, onPress, testID }: { reason: CommunityReason; selected: boolean; onPress: () => void; testID: string }) {
  return (
    <ActionPressable feedback="selection" testID={testID} accessibilityRole="radio" accessibilityLabel={reason.label}
      accessibilityState={{ selected }} aria-checked={selected} onPress={onPress}
      style={{ borderRadius: 12, borderWidth: 1, borderColor: selected ? semantic.text : semantic.border, padding: 12, gap: 2,
        backgroundColor: selected ? semantic.raised : semantic.surface }}>
      <Text style={{ fontSize: 15, lineHeight: 21, fontWeight: '700' }}>{reason.label}</Text>
      {reason.description ? <Text style={{ fontSize: 12, lineHeight: 17, color: semantic.secondary }}>{reason.description}</Text> : null}
    </ActionPressable>
  );
}

// Failures arrive as the error itself (null when none): ErrorNotice keeps the admin diagnostic.
const WARNING_LINE = { fontSize: 13, lineHeight: 19, color: semantic.warning } as const;
const WARNING_TEXT = { fontSize: 14, lineHeight: 20, color: semantic.warning } as const;

/** A member's report: pick one of the server's reasons; nothing else to type. */
export function ReportSheet({ visible, reasons, busy, error, onSubmit, onClose }: {
  visible: boolean; reasons: readonly CommunityReason[]; busy: boolean; error: unknown;
  onSubmit: (reason: CommunityReasonCode) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState<CommunityReasonCode | null>(null);
  useEffect(() => { if (!visible) setReason(null); }, [visible]);
  return (
    <CommunitySheet testID="community-report-sheet" title="신고 사유" visible={visible} onClose={onClose} dismissible={!busy}>
      <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 8 }}>
        {reasons.map((item) => (
          <ReasonRow key={item.code} testID={`community-report-${item.code}`} reason={item} selected={reason === item.code}
            onPress={() => setReason(item.code)} />
        ))}
      </ScrollView>
      {error ? <ErrorNotice testID="community-report-error" error={error} style={WARNING_LINE} /> : null}
      <CTAButton testID="community-report-submit" label="신고하기" state={busy ? 'loading' : reason ? 'enabled' : 'disabled'}
        onPress={() => { if (reason && !busy) onSubmit(reason); }} />
    </CommunitySheet>
  );
}

const noteError = (reason: CommunityReason | undefined, note: string) => {
  const length = communityTextLength(note);
  if (length > COMMUNITY_LIMITS.note) return `메모는 ${COMMUNITY_LIMITS.note}자까지 입력할 수 있어요.`;
  return reason?.noteRequired && length < 1 ? '기타 사유는 메모를 입력해주세요.' : null;
};

/**
 * Operator removal of a post or comment (contract §9.1): a reason from the
 * single list is required (기타 also needs a note), then a final confirmation.
 * Nothing is sent without a reason.
 */
export function ModerationSheet({ visible, target, reasons, busy, error, onConfirm, onClose }: {
  visible: boolean; target: 'post' | 'comment'; reasons: readonly CommunityReason[]; busy: boolean; error: unknown;
  onConfirm: (reason: CommunityReasonCode, note: string | undefined) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState<CommunityReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!visible) { setReason(null); setNote(''); setConfirming(false); } }, [visible]);
  const selected = reasons.find((item) => item.code === reason);
  const problem = noteError(selected, note);
  const what = target === 'post' ? '글' : '댓글';
  return (
    <CommunitySheet testID="community-moderation-sheet" title={`${what} 삭제`} admin visible={visible} onClose={onClose} dismissible={!busy}>
      {confirming && selected ? (
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 15, lineHeight: 22 }}>삭제하면 모든 사용자에게 숨겨져요</Text>
          <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.secondary }}>사유: {selected.label}{note.trim() ? ` · ${note.trim()}` : ''}</Text>
          {error ? <ErrorNotice testID="community-moderation-error" error={error} style={WARNING_LINE} /> : null}
          <ActionPressable testID="community-moderation-confirm" accessibilityRole="button" accessibilityLabel="삭제"
            accessibilityState={{ disabled: busy, busy }} aria-busy={busy} disabled={busy}
            onPress={() => onConfirm(selected.code, note.trim() || undefined)}
            style={{ minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.alert, opacity: busy ? 0.6 : 1 }}>
            {busy ? <WhaleLoader size={22} tone="onAction" /> : <Text style={{ fontSize: 16, fontWeight: '700', color: semantic.onAlert }}>삭제</Text>}
          </ActionPressable>
          <CTAButton testID="community-moderation-back" variant="neutral" label="사유 다시 고르기" state={busy ? 'disabled' : 'enabled'}
            onPress={() => setConfirming(false)} />
        </View>
      ) : (
        <>
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 8 }}>
            {reasons.map((item) => (
              <ReasonRow key={item.code} testID={`community-moderation-${item.code}`} reason={item} selected={reason === item.code}
                onPress={() => setReason(item.code)} />
            ))}
          </ScrollView>
          <TextInput testID="community-moderation-note" accessibilityLabel="메모" value={note} onChangeText={setNote}
            placeholder={selected?.noteRequired ? '메모 (필수)' : '메모 (선택)'} maxLength={COMMUNITY_LIMITS.note}
            style={{ minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: semantic.border, paddingHorizontal: 12, fontSize: 15 }} />
          {reason && problem ? <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.warning }}>{problem}</Text> : null}
          <CTAButton testID="community-moderation-next" label="다음" state={reason && !problem ? 'enabled' : 'disabled'}
            onPress={() => { if (reason && !problem) setConfirming(true); }} />
        </>
      )}
    </CommunitySheet>
  );
}

const DURATIONS = [
  { key: '7d', label: '7일' },
  { key: '30d', label: '30일' },
  { key: 'permanent', label: '영구' },
] as const;

/**
 * 계정 관리 (operators): the member's card from `GET /operator/community/
 * users/:id`, then either the active restriction with 제한 해제, or the
 * restriction form (사유, 7일 | 30일 | 영구, hide their posts and comments)
 * with a final confirmation. This restricts the COMMUNITY only, never the app.
 */
export function AccountManageSheet({ visible, viewerId, targetUserId, reasons, onClose, onChanged }: {
  visible: boolean; viewerId: string; targetUserId: string | null; reasons: readonly CommunityReason[];
  onClose: () => void; onChanged: () => void;
}) {
  const client = useQueryClient();
  const { colors } = useAppearance();
  const key = QUERY_KEYS.community.operatorUser(viewerId, targetUserId ?? '');
  const summary = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getOperatorCommunityUser(targetUserId ?? '', signal),
    enabled: visible && !!targetUserId,
    staleTime: 0,
  });
  const [reason, setReason] = useState<CommunityReasonCode | null>(null);
  const [duration, setDuration] = useState<CommunitySanctionDuration>('30d');
  const [hideContent, setHideContent] = useState(true);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  // The failed request's error itself, so operators keep the admin diagnostic.
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    if (!visible) { setReason(null); setDuration('30d'); setHideContent(true); setNote(''); setConfirming(false); setFailure(null); }
  }, [visible]);
  const settled = () => { void client.invalidateQueries({ queryKey: key }); onChanged(); };
  const restrict = useMutation({
    mutationFn: (code: CommunityReasonCode) => createCommunitySanction(targetUserId ?? '', {
      reason: code, duration, hideContent, ...(note.trim() ? { note: note.trim() } : {}),
    }),
    retry: false,
    onSuccess: () => { setConfirming(false); setFailure(null); settled(); },
    // 409 (already restricted): read the card again, it shows that restriction.
    onError: (cause) => { setFailure(cause); void client.invalidateQueries({ queryKey: key }); },
  });
  const revoke = useMutation({
    mutationFn: (sanctionId: string) => revokeCommunitySanction(sanctionId),
    retry: false,
    onSuccess: () => { setFailure(null); settled(); },
    onError: (cause) => setFailure(cause),
  });
  const busy = restrict.isPending || revoke.isPending;
  const selected = reasons.find((item) => item.code === reason);
  const problem = noteError(selected, note);
  const data = summary.data;
  return (
    <CommunitySheet testID="community-account-sheet" title="계정 관리" admin visible={visible} onClose={onClose} dismissible={!busy}>
      {summary.isLoading || !targetUserId ? <WhaleLoader size={28} accessibilityLabel="계정 정보를 불러오는 중" />
        : !data ? (
          <View style={{ gap: 8 }}>
            {summary.isError ? <ErrorNotice testID="community-account-error" error={summary.error} style={WARNING_TEXT} />
              : <Text testID="community-account-error" style={WARNING_TEXT}>계정 정보를 불러오지 못했어요.</Text>}
            <CTAButton variant="neutral" label="다시 시도" onPress={() => void summary.refetch()} />
          </View>
        ) : (
          <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 12, paddingBottom: 4 }}>
            <View testID="community-account-card" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12,
              borderRadius: 14, backgroundColor: semantic.raised }}>
              <CommunityAvatar display={{ kind: 'public', profileImageUrl: data.user.profileImageUrl }} size={44} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '700', flexShrink: 1 }}>{data.user.nickname}</Text>
                  <TierMark tier={data.user.tier} name={getHomeTierName(data.user.tier)} />
                </View>
                <Text testID="community-account-stats" style={{ fontSize: 12, lineHeight: 17, color: semantic.secondary }}>
                  가입 {formatKstDate(data.user.joinedAt)} · 작성글 {data.stats.postCount} · 신고 {data.stats.reportCount}
                </Text>
              </View>
            </View>
            {data.activeSanction ? (
              <View testID="community-account-restricted" style={{ gap: 10 }}>
                <Text style={{ fontSize: 15, lineHeight: 22, fontWeight: '700' }}>커뮤니티 이용 제한 중</Text>
                <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.secondary }}>
                  {reasons.find((item) => item.code === data.activeSanction?.reason)?.label ?? '기타'} ·{' '}
                  {data.activeSanction.until ? `${formatKstDate(data.activeSanction.until)}까지` : '영구'}
                  {data.activeSanction.carriedOver ? ' · 탈퇴 전 제한 승계' : ''}
                </Text>
                {failure ? <ErrorNotice testID="community-account-failure" error={failure} style={WARNING_LINE} /> : null}
                <CTAButton testID="community-account-revoke" label="제한 해제" state={revoke.isPending ? 'loading' : 'enabled'}
                  onPress={() => { if (!busy && data.activeSanction) revoke.mutate(data.activeSanction.id); }} />
              </View>
            ) : !data.sanctionable ? (
              <Text testID="community-account-not-sanctionable" style={{ fontSize: 13, lineHeight: 19, color: semantic.secondary }}>
                운영자·관리자 계정이나 내 계정은 이용을 제한할 수 없어요.
              </Text>
            ) : confirming && selected ? (
              <View style={{ gap: 12 }}>
                <Text style={{ fontSize: 15, lineHeight: 22 }}>
                  {data.user.nickname}님의 커뮤니티 이용이 제한됩니다{duration === 'permanent' ? ' (영구)' : ` (${duration === '7d' ? '7일' : '30일'})`}.
                  {hideContent ? ' 지금까지 쓴 글·댓글도 모두 숨겨요.' : ''}
                </Text>
                {failure ? <ErrorNotice testID="community-account-failure" error={failure} style={WARNING_LINE} /> : null}
                <ActionPressable testID="community-account-confirm" accessibilityRole="button" accessibilityLabel="계정 차단"
                  accessibilityState={{ disabled: busy, busy }} aria-busy={busy} disabled={busy} onPress={() => restrict.mutate(selected.code)}
                  style={{ minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.alert, opacity: busy ? 0.6 : 1 }}>
                  {busy ? <WhaleLoader size={22} tone="onAction" /> : <Text style={{ fontSize: 16, fontWeight: '700', color: semantic.onAlert }}>계정 차단</Text>}
                </ActionPressable>
                <CTAButton variant="neutral" label="취소" state={busy ? 'disabled' : 'enabled'} onPress={() => setConfirming(false)} />
              </View>
            ) : (
              <View testID="community-account-form" style={{ gap: 12 }}>
                <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '700' }}>차단 사유</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {reasons.map((item) => {
                    const on = item.code === reason;
                    return (
                      <ActionPressable key={item.code} feedback="selection" testID={`community-account-reason-${item.code}`}
                        accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ selected: on }} aria-checked={on}
                        onPress={() => setReason(item.code)} style={{ minHeight: 36, borderRadius: 18, paddingHorizontal: 12, justifyContent: 'center',
                          backgroundColor: on ? semantic.inverse : semantic.input }}>
                        <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: on ? '700' : '400', color: on ? semantic.onInverse : semantic.text }}>
                          {item.label}
                        </Text>
                      </ActionPressable>
                    );
                  })}
                </View>
                <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '700' }}>차단 기간</Text>
                <SegmentedControl testID="community-account-duration" accessibilityLabel="차단 기간" value={duration} onChange={setDuration}
                  options={DURATIONS.map((item) => ({ key: item.key, label: item.label, testID: `community-account-duration-${item.key}` }))} />
                <ActionPressable feedback="selection" testID="community-account-hide" accessibilityRole="checkbox"
                  accessibilityLabel="이 계정이 쓴 글·댓글 모두 숨기기" accessibilityState={{ checked: hideContent }} aria-checked={hideContent}
                  onPress={() => setHideContent((value) => !value)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center',
                    borderColor: hideContent ? semantic.inverse : semantic.border, backgroundColor: hideContent ? semantic.inverse : semantic.surface }}>
                    {hideContent ? <CommunityIcon name="check" size={14} color={colors.onInverse} strokeWidth={2.4} /> : null}
                  </View>
                  <Text style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>이 계정이 쓴 글·댓글 모두 숨기기</Text>
                </ActionPressable>
                <TextInput testID="community-account-note" accessibilityLabel="메모" value={note} onChangeText={setNote}
                  placeholder={selected?.noteRequired ? '메모 (필수)' : '메모 (선택)'} maxLength={COMMUNITY_LIMITS.note}
                  style={{ minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: semantic.border, paddingHorizontal: 12, fontSize: 15 }} />
                {reason && problem ? <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.warning }}>{problem}</Text> : null}
                <Text style={{ fontSize: 12, lineHeight: 17, color: semantic.secondary }}>
                  커뮤니티 이용이 제한됩니다. 앱의 다른 기능과 거래는 그대로 쓸 수 있어요.
                </Text>
                <ActionPressable testID="community-account-block" accessibilityRole="button" accessibilityLabel="계정 차단"
                  accessibilityState={{ disabled: !reason || !!problem }} aria-disabled={!reason || !!problem} disabled={!reason || !!problem}
                  onPress={() => { setFailure(null); setConfirming(true); }}
                  style={{ minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.alert,
                    opacity: !reason || problem ? 0.45 : 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: semantic.onAlert }}>계정 차단</Text>
                </ActionPressable>
                <CTAButton variant="neutral" label="취소" onPress={onClose} />
              </View>
            )}
          </ScrollView>
        )}
    </CommunitySheet>
  );
}
