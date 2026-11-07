import React, { useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import { Image, Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useCommunityNavigation } from '../../app/navigation/navigationHooks';
import { getAssetDetail } from '../../features/asset/api';
import {
  COMMUNITY_LIMITS,
  COMMUNITY_POST_CATEGORIES,
  CommunityResponseError,
  createCommunityPost,
  type CommunityAssetTag,
  type CommunityCategory,
  type CommunityPostDraft,
} from '../../features/community/api';
import { describePostAuthor } from '../../features/community/authorDisplay';
import { refreshCommunityLists } from '../../features/community/communityCache';
import { communityTextLength } from '../../features/community/format';
import { showAnonymousPhotoNotice } from '../../features/community/gates';
import { containsBlockedLink } from '../../features/community/linkCheck';
import { pickCommunityPhotos } from '../../features/community/photoPicker';
import { CommunityPhotoSelectionError, remainingPhotoSlots, type CommunityPhotoUpload } from '../../features/community/photoRules';
import { createIdempotencyKey } from '../../utils/idempotency';
import { getApiErrorInfo } from '../../services/api/errorMapper';
import ActionPressable from '../../components/common/ActionPressable';
import CommunityIcon from '../../components/community/CommunityIcon';
import WhaleLoader from '../../components/states/WhaleLoader';
import OrderAssetSheet from '../order/OrderAssetSheet';
import { AssetTagChip, CategoryChip, CommunityAvatar, TierMark } from './CommunityParts';
import { CommunityNoticeText, type CommunityNotice } from './CommunityNotice';
import { useCommunityViewer, useCommunityWrite } from './useCommunityWrite';

const PHOTO_ERRORS = {
  permission: '사진을 선택하려면 사진 접근을 허용해주세요.',
  too_large: '너무 큰 사진은 올릴 수 없어요. 다른 사진을 선택해주세요.',
  processing: '사진을 준비하지 못했어요. 다른 사진을 선택해주세요.',
} as const;

/**
 * 글쓰기 (contract §5.4): 자유 | 이론, the text (1–500), up to four photos
 * (normalized on the device, validated again by the server), one asset tag
 * and 공개 | 익명, previewed as "이렇게 표시돼요". 등록 waits for the rules
 * consent; a restricted member cannot post. A failed post keeps the text,
 * the photos and the request id, so sending again never posts twice.
 */
export default function PostComposeScreen({ route }: { route: { params?: { category?: CommunityCategory } } }) {
  const navigation = useCommunityNavigation();
  const client = useQueryClient();
  const { colors } = useAppearance();
  const headerHeight = useHeaderHeight();
  const viewer = useCommunityViewer();
  const { userId } = viewer;
  const write = useCommunityWrite(userId);
  const bootstrap = write.bootstrap.data;
  const maxLength = bootstrap?.postBodyMaxLength ?? COMMUNITY_LIMITS.postBody;
  const maxPhotos = bootstrap?.maxPhotos ?? COMMUNITY_LIMITS.photos;

  const [category, setCategory] = useState<CommunityCategory>(route.params?.category ?? 'free');
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [photos, setPhotos] = useState<CommunityPhotoUpload[]>([]);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [assetSheet, setAssetSheet] = useState(false);
  const [picking, setPicking] = useState(false);
  // Local copy, or a failed request kept whole for the admin diagnostic.
  const [notice, setNotice] = useState<CommunityNotice | null>(null);
  const attempt = useRef<{ key: string; signature: string } | null>(null);

  const assetDetail = useQuery({
    queryKey: QUERY_KEYS.asset.detail(assetId ?? ''),
    queryFn: () => getAssetDetail(assetId ?? ''),
    enabled: !!assetId,
    staleTime: 60_000,
  });
  const detailAsset = assetDetail.data?.asset;
  const tag: CommunityAssetTag | null = assetId && detailAsset?.id === assetId
    ? { id: detailAsset.id, symbol: detailAsset.symbol, name: detailAsset.name, market: detailAsset.market, assetType: detailAsset.assetType }
    : null;

  const post = useMutation({
    mutationFn: (draft: CommunityPostDraft) => createCommunityPost(draft),
    retry: false,
    onSuccess: () => {
      attempt.current = null;
      if (userId) refreshCommunityLists(client, userId);
      // The native back stays available while posting (2026-11-07 (3)): a
      // member who already left must not be sent back a second screen.
      if (navigation.isFocused()) navigation.goBack();
    },
    onError: (error) => {
      const info = getApiErrorInfo(error);
      // Unknown result (no answer, 5xx, unreadable): keep the id, a resend replays.
      const uncertain = error instanceof CommunityResponseError || !info.hasResponse || (info.status ?? 500) >= 500;
      if (!uncertain) attempt.current = null;
      write.handleWriteError(error);
      setNotice(uncertain ? { error, message: '등록 결과를 확인하지 못했어요. 그대로 다시 등록하면 중복 없이 확인해요.' } : { error });
    },
  });

  const restricted = write.gate.kind === 'restricted' ? write.gate.message : null;
  const busy = post.isPending || picking;
  // The server's count (JS trim, then code points): blank lines and spaces alone never enable 등록.
  const length = communityTextLength(body);
  const trimmed = body.trim();
  const valid = length >= 1 && length <= maxLength && !restricted && !!userId;
  const edit = (update: () => void) => { if (busy) return; update(); setNotice(null); };

  const submit = () => {
    if (!valid || busy || !userId) return;
    if (containsBlockedLink(trimmed)) { setNotice({ message: '링크나 오픈채팅·메신저 주소는 올릴 수 없어요.' }); return; }
    Keyboard.dismiss();
    write.requireWrite(() => {
      const signature = JSON.stringify([category, trimmed, anonymous, assetId, photos.map((photo) => photo.uri)]);
      const key = attempt.current?.signature === signature ? attempt.current.key : createIdempotencyKey('community_post');
      attempt.current = { key, signature };
      setNotice(null);
      post.mutate({ clientRequestId: key, category, body: trimmed, anonymous, assetId, photos });
    });
  };

  // The header's 등록 calls the latest submit (the header renders apart from this screen).
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const addPhotos = async () => {
    if (busy || restricted) return;
    const remaining = remainingPhotoSlots(photos.length, maxPhotos);
    if (!remaining) return;
    setPicking(true);
    setNotice(null);
    try {
      const picked = await pickCommunityPhotos(remaining);
      if (picked.length) setPhotos((current) => [...current, ...picked].slice(0, maxPhotos));
    } catch (error) {
      setNotice({ message: error instanceof CommunityPhotoSelectionError ? PHOTO_ERRORS[error.reason] : PHOTO_ERRORS.processing });
    } finally {
      setPicking(false);
    }
  };

  // The header's left is the stack's own back (2026-11-07 (3): the 취소 text
  // button is gone); Android back and the iOS swipe stay as they are.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <ActionPressable testID="community-compose-submit" accessibilityRole="button" accessibilityLabel="등록"
          accessibilityState={{ disabled: !valid || busy, busy: post.isPending }} aria-disabled={!valid || busy}
          disabled={!valid || busy} onPress={() => submitRef.current()}
          style={{ minHeight: 36, minWidth: 56, borderRadius: 18, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center',
            backgroundColor: semantic.inverse, opacity: !valid || busy ? 0.4 : 1 }}>
          {post.isPending ? <WhaleLoader size={18} tone="onAction" />
            : <Text style={{ fontSize: 15, fontWeight: '700', color: semantic.onInverse }} maxFontSizeMultiplier={1.4}>등록</Text>}
        </ActionPressable>
      ),
    });
  }, [busy, navigation, post.isPending, valid]);

  const preview = bootstrap ? describePostAuthor(anonymous ? { kind: 'anonymous', label: '익명' } : bootstrap.me) : null;
  // The author line cannot be read (the member or the bootstrap): offer a retry, not an endless loader.
  const authorFailed = viewer.failed || (!bootstrap && write.bootstrap.isError);
  const retryAuthor = () => { if (viewer.failed) viewer.retry(); else void write.bootstrap.refetch(); };
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: semantic.surface }}>
      <KeyboardAvoidingView style={{ flex: 1 }} keyboardVerticalOffset={headerHeight} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView testID="community-compose" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14 }}>
          <View testID="community-compose-preview" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
            {preview ? (
              <>
                <CommunityAvatar display={preview} size={36} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '700', flexShrink: 1, color: preview.kind === 'public' ? semantic.text : semantic.muted }}>
                    {preview.name}</Text>
                  <TierMark tier={preview.tier} name={preview.tierName} />
                </View>
              </>
            ) : authorFailed ? (
              <ActionPressable testID="community-compose-author-retry" accessibilityRole="button" onPress={retryAuthor}
                style={{ minHeight: 44, justifyContent: 'center', flexShrink: 1 }}>
                <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.secondaryActionForeground, fontWeight: '600' }}>
                  작성자 정보를 불러오지 못했어요. 다시 시도</Text>
              </ActionPressable>
            ) : <WhaleLoader size={22} accessibilityLabel="작성자 정보를 불러오는 중" />}
            <View style={{ flex: 1 }} />
            <Text style={{ fontSize: 12, color: semantic.muted }}>이렇게 표시돼요</Text>
          </View>
          <View accessibilityRole="tablist" accessibilityLabel="카테고리" style={{ flexDirection: 'row', gap: 6 }}>
            {COMMUNITY_POST_CATEGORIES.map((item) => (
              <CategoryChip key={item.key} testID={`community-compose-category-${item.key}`} category={item.key} label={item.label}
                selected={category === item.key} onPress={() => edit(() => setCategory(item.key))} />
            ))}
          </View>
          {restricted ? (
            <Text testID="community-compose-restricted" style={{ padding: 12, borderRadius: 12, backgroundColor: semantic.warningSurface,
              color: semantic.warning, fontSize: 13, lineHeight: 19 }}>{restricted}</Text>
          ) : null}
          <TextInput testID="community-compose-body" accessibilityLabel="본문" value={body} multiline editable={!busy && !restricted}
            onChangeText={(value) => edit(() => setBody(value))} placeholder="투자 이야기나 궁금한 점을 나눠보세요"
            maxLength={maxLength + 50} textAlignVertical="top"
            style={{ minHeight: 160, fontSize: 16, lineHeight: 25, padding: 0, backgroundColor: semantic.surface }} />
          {photos.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 6, paddingRight: 6 }}>
              {photos.map((photo, index) => (
                <View key={photo.uri} testID={`community-compose-photo-${index}`} style={{ width: 72, height: 72 }}>
                  <Image source={{ uri: photo.uri }} resizeMode="cover" accessible accessibilityLabel={`사진 ${index + 1}`}
                    style={{ width: 72, height: 72, borderRadius: 10, borderWidth: 1, borderColor: semantic.border }} />
                  <ActionPressable testID={`community-compose-photo-${index}-remove`} accessibilityRole="button" accessibilityLabel={`사진 ${index + 1} 삭제`}
                    disabled={busy} onPress={() => edit(() => setPhotos((current) => current.filter((item) => item.uri !== photo.uri)))}
                    style={{ position: 'absolute', top: -10, right: -10, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: semantic.inverse }}>
                      <CommunityIcon name="close" size={12} color={colors.onInverse} strokeWidth={2.4} />
                    </View>
                  </ActionPressable>
                </View>
              ))}
              {photos.length < maxPhotos ? (
                <ActionPressable testID="community-compose-photo-add" accessibilityRole="button" accessibilityLabel="사진 추가" disabled={busy || !!restricted}
                  onPress={() => void addPhotos()} style={{ width: 72, height: 72, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed',
                    borderColor: semantic.border, alignItems: 'center', justifyContent: 'center' }}>
                  <CommunityIcon name="plus" size={22} color={colors.muted} />
                </ActionPressable>
              ) : null}
            </ScrollView>
          ) : null}
          {showAnonymousPhotoNotice(anonymous, photos.length) ? (
            <View testID="community-compose-anonymous-photo" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <CommunityIcon name="info" size={14} color={colors.muted} />
              <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: semantic.muted }}>사진에 닉네임이나 프로필이 보이면 익명이 풀릴 수 있어요</Text>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {tag ? <AssetTagChip asset={tag} testID="community-compose-asset" onRemove={() => edit(() => setAssetId(null))} />
                : assetId ? <WhaleLoader size={20} accessibilityLabel="종목 정보를 불러오는 중" style={{ alignSelf: 'flex-start' }} /> : null}
            </View>
            <Text testID="community-compose-counter" style={{ fontSize: 12, fontVariant: ['tabular-nums'],
              color: length > maxLength ? semantic.warning : semantic.muted }}>{length} / {maxLength}</Text>
          </View>
          {notice ? <CommunityNoticeText testID="community-compose-error" notice={notice}
            style={{ fontSize: 13, lineHeight: 19, color: semantic.warning }} /> : null}
          {write.notice ? <Text style={{ fontSize: 13, lineHeight: 19, color: semantic.warning }}>{write.notice}</Text> : null}
        </ScrollView>
        <View style={{ minHeight: 64, borderTopWidth: 1, borderTopColor: semantic.border, flexDirection: 'row', alignItems: 'center',
          gap: 8, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: semantic.surface }}>
          <ActionPressable testID="community-compose-photos" accessibilityRole="button" accessibilityLabel={`사진 ${photos.length}/${maxPhotos}`}
            accessibilityState={{ disabled: busy || !!restricted || photos.length >= maxPhotos }} disabled={busy || !!restricted || photos.length >= maxPhotos}
            onPress={() => void addPhotos()} style={{ minHeight: 40, borderRadius: 20, paddingHorizontal: 12, flexDirection: 'row',
              alignItems: 'center', gap: 6, backgroundColor: semantic.input }}>
            {picking ? <WhaleLoader size={16} /> : <CommunityIcon name="photo" size={16} color={colors.secondary} />}
            <Text style={{ fontSize: 13, fontWeight: '600', color: semantic.text }} maxFontSizeMultiplier={1.4}>사진 {photos.length}/{maxPhotos}</Text>
          </ActionPressable>
          <ActionPressable testID="community-compose-asset-button" accessibilityRole="button" accessibilityLabel="종목 태그"
            disabled={busy || !!restricted} onPress={() => setAssetSheet(true)}
            style={{ minHeight: 40, borderRadius: 20, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: semantic.input, flexShrink: 1 }}>
            <CommunityIcon name="plus" size={16} color={colors.secondary} />
            <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: semantic.text }} maxFontSizeMultiplier={1.4}>종목 태그</Text>
          </ActionPressable>
          <View style={{ flex: 1 }} />
          <View accessibilityRole="tablist" accessibilityLabel="표시 방식" style={{ flexDirection: 'row', padding: 2, borderRadius: 12,
            backgroundColor: semantic.input }}>
            {([['public', '공개'], ['anonymous', '익명']] as const).map(([key, label]) => {
              const on = (key === 'anonymous') === anonymous;
              return (
                <ActionPressable key={key} feedback="selection" testID={`community-compose-${key}`} accessibilityRole="tab"
                  accessibilityLabel={label} accessibilityState={{ selected: on }} aria-selected={on} disabled={busy}
                  onPress={() => edit(() => setAnonymous(key === 'anonymous'))}
                  style={{ width: 60, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: on ? semantic.surface : semantic.input }}>
                  <Text style={{ fontSize: 14, fontWeight: on ? '700' : '400', color: on ? semantic.text : semantic.secondary }} maxFontSizeMultiplier={1.3}>{label}</Text>
                </ActionPressable>
              );
            })}
          </View>
        </View>
      </KeyboardAvoidingView>
      <OrderAssetSheet visible={assetSheet} onClose={() => setAssetSheet(false)}
        onSelect={(id) => { setAssetSheet(false); edit(() => setAssetId(id)); }} />
      {write.rulesSheet}
    </SafeAreaView>
  );
}
