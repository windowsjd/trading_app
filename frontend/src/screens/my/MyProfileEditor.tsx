import { semantic } from '../../theme/tokens';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TextInput, View } from '../../theme/native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import ActionPressable from '../../components/common/ActionPressable';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { deleteProfileImage, updateMe, uploadProfileImage, type MeDto } from '../../features/me/api';
import { selectProfileImage } from '../../features/me/profileImage';
import { ProfileImageSelectionError } from '../../features/me/profileImageTypes';
import { applyProfileImageResponse, invalidateIdentityViews } from '../../features/me/profileImageCache';
import { getSessionGeneration, isCurrentSession } from '../../services/api/sessionOwnership';

/**
 * The profile photo and nickname, edited on MY under the avatar and nickname
 * it already shows (moved from Settings): the same APIs, picker, image checks
 * and session guards. One photo action at a time; a failure keeps the current
 * photo. The nickname is edited in place (`닉네임 변경` → field, 취소/저장), so
 * it is not shown twice while nothing is being changed.
 */
export default function MyProfileEditor({ me }: { me: MeDto }) {
  const queryClient = useQueryClient();
  const photoRequestInFlight = useRef(false);
  const nicknameRequestInFlight = useRef(false);
  const [photoAction, setPhotoAction] = useState<'select' | 'upload' | 'delete' | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoFailure, setPhotoFailure] = useState<unknown>(null);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nickname, setNickname] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const photoMutation = useMutation({
    mutationFn: (image: Awaited<ReturnType<typeof selectProfileImage>>) =>
      image ? uploadProfileImage(image) : deleteProfileImage(),
  });

  const runPhotoAction = async (remove: boolean) => {
    if (photoRequestInFlight.current) return;
    photoRequestInFlight.current = true;
    const owner = getSessionGeneration();
    const userId = me.id;
    const ownsUser = () => isCurrentSession(owner) && queryClient.getQueryData<MeDto>(QUERY_KEYS.me)?.id === userId;
    const current = () => mounted.current && ownsUser();
    setPhotoError(null);
    setPhotoFailure(null);
    setPhotoAction(remove ? 'delete' : 'select');
    let image: Awaited<ReturnType<typeof selectProfileImage>> = null;
    try {
      image = remove ? null : await selectProfileImage();
      if (!current() || (!remove && !image)) return;
      setPhotoAction(remove ? 'delete' : 'upload');
      const saved = await photoMutation.mutateAsync(image);
      if (ownsUser()) await applyProfileImageResponse(queryClient, saved, owner);
    } catch (error) {
      if (current()) {
        if (!(error instanceof ProfileImageSelectionError)) setPhotoFailure(error);
        setPhotoError(error instanceof ProfileImageSelectionError && error.reason === 'permission'
          ? '사진 접근 권한이 필요합니다. 기기 설정에서 사진 접근을 허용해주세요.'
          : error instanceof ProfileImageSelectionError && error.reason === 'too_large'
            ? '사진이 너무 큽니다. 더 작은 사진을 선택해주세요.'
            : error instanceof ProfileImageSelectionError && error.reason === 'processing'
              ? '사진을 처리하지 못했습니다. 다른 사진을 선택해주세요.'
              : remove ? '사진을 삭제하지 못했습니다. 다시 시도해주세요.'
                : '사진을 업로드하지 못했습니다. 다시 시도해주세요.');
      }
    } finally {
      if (Platform.OS === 'web' && image?.uri.startsWith('blob:')) URL.revokeObjectURL(image.uri);
      photoRequestInFlight.current = false;
      if (mounted.current) setPhotoAction(null);
    }
  };

  const updateMutation = useMutation({
    mutationFn: updateMe,
    onMutate: () => ({ userId: me.id, generation: getSessionGeneration() }),
    onSuccess: async (saved, _payload, context) => {
      // A late answer after logout or another login belongs to no one on screen.
      if (!context || !isCurrentSession(context.generation) || saved.id !== context.userId) return;
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
      // Ranking rows and this user's season summary show the nickname too.
      invalidateIdentityViews(queryClient, saved.id);
      Alert.alert('저장 완료', '닉네임이 변경되었습니다.');
    },
    onError: (_error, _payload, context) => {
      if (context && !isCurrentSession(context.generation)) return;
      Alert.alert('저장 실패', '닉네임 변경에 실패했습니다.');
    },
    onSettled: () => {
      nicknameRequestInFlight.current = false;
    },
  });
  const saving = updateMutation.isPending;

  const startEditing = () => {
    updateMutation.reset();
    setNickname(me.nickname);
    setEditingNickname(true);
  };
  const cancelEditing = () => {
    updateMutation.reset();
    setEditingNickname(false);
  };
  const onSaveNickname = () => {
    if (nicknameRequestInFlight.current) return;
    if (!nickname.trim()) {
      Alert.alert('입력 확인', '닉네임을 입력해주세요.');
      return;
    }
    nicknameRequestInFlight.current = true;
    updateMutation.mutate({ nickname: nickname.trim() }, { onSuccess: () => setEditingNickname(false) });
  };

  const photoBusy = photoAction !== null;
  return (
    <View style={styles.editor}>
      <View style={styles.actions}>
        <ActionPressable feedback="button" testID={TEST_IDS.my.profileImageSelect} accessibilityRole="button"
          style={[styles.secondaryButton, styles.action]}
          disabled={photoBusy} accessibilityState={{ disabled: photoBusy, busy: photoBusy }}
          onPress={() => void runPhotoAction(false)}>
          <Text style={styles.secondaryButtonText}>
            {photoAction === 'upload' ? '업로드 중...' : photoAction === 'select' ? '사진 준비 중...' : '프로필 사진 변경'}
          </Text>
        </ActionPressable>
        {editingNickname ? null : (
          <ActionPressable feedback="button" testID={TEST_IDS.my.nicknameEdit} accessibilityRole="button"
            style={[styles.secondaryButton, styles.action]} onPress={startEditing}>
            <Text style={styles.secondaryButtonText}>닉네임 변경</Text>
          </ActionPressable>
        )}
        {me.profileImageUrl ? (
          <ActionPressable feedback="button" testID={TEST_IDS.my.profileImageDelete} accessibilityRole="button"
            style={[styles.deleteButton, styles.action]}
            disabled={photoBusy} accessibilityState={{ disabled: photoBusy, busy: photoAction === 'delete' }}
            onPress={() => void runPhotoAction(true)}>
            <Text style={styles.deleteText}>{photoAction === 'delete' ? '삭제 중...' : '사진 삭제'}</Text>
          </ActionPressable>
        ) : null}
      </View>
      {photoError ? <Text testID={TEST_IDS.my.profileImageError} accessibilityRole="alert" style={styles.error}>{photoError}</Text> : null}
      {photoFailure ? <AdminDiagnosticPanel error={photoFailure} /> : null}

      {editingNickname ? (
        <View style={styles.nicknameForm}>
          <TextInput
            testID={TEST_IDS.my.nicknameInput}
            accessibilityLabel="새 닉네임"
            style={styles.input}
            value={nickname}
            onChangeText={setNickname}
            placeholder="닉네임 입력"
            autoFocus
            editable={!saving}
            returnKeyType="done"
            onSubmitEditing={onSaveNickname}
          />
          <View style={styles.actions}>
            <ActionPressable feedback="button" testID={TEST_IDS.my.nicknameCancel} accessibilityRole="button"
              style={[styles.secondaryButton, styles.action]}
              disabled={saving} accessibilityState={{ disabled: saving }} onPress={cancelEditing}>
              <Text style={styles.secondaryButtonText}>취소</Text>
            </ActionPressable>
            <ActionPressable primary testID={TEST_IDS.my.saveNickname} accessibilityRole="button"
              style={[styles.primaryButton, styles.action]}
              disabled={saving} accessibilityState={{ disabled: saving, busy: saving }} onPress={onSaveNickname}>
              <Text style={styles.primaryButtonText}>{saving ? '저장 중...' : '저장'}</Text>
            </ActionPressable>
          </View>
          {updateMutation.isError && updateMutation.context?.userId === me.id && isCurrentSession(updateMutation.context.generation)
            ? <AdminDiagnosticPanel error={updateMutation.error} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { gap: 10 },
  // Two buttons a row from 360 dp; each takes a full row below that or at large text.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  action: { flexGrow: 1, flexBasis: 130, minHeight: 48, paddingHorizontal: 12 },
  secondaryButton: {
    backgroundColor: semantic.secondaryActionSurface,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: semantic.secondaryActionForeground, fontWeight: '700', textAlign: 'center' },
  primaryButton: {
    backgroundColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: semantic.onAccent, fontWeight: '700', textAlign: 'center' },
  deleteButton: {
    backgroundColor: semantic.errorSurface,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { color: semantic.error, fontWeight: '700', textAlign: 'center' },
  error: { fontSize: 14, color: semantic.error, lineHeight: 21 },
  nicknameForm: { gap: 10 },
  input: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: semantic.input,
    fontSize: 16,
  },
});
