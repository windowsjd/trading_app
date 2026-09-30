import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  View,
} from '../../theme/native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { MyStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import {
  changeFriendship,
  getFriends,
  type FriendAction,
  type FriendUser,
} from '../../features/friends/api';
import { refreshFriendship } from '../../features/friends/cache';
import { getApiErrorCode } from '../../services/api/errorMapper';
import ActionPressable from '../../components/common/ActionPressable';
import InlineEmptyState from '../../components/states/InlineEmptyState';

type Props = NativeStackScreenProps<MyStackParamList, 'Friends'>;
const tabs = [
  { key: 'list', label: '친구 목록' },
  { key: 'requests', label: '받은 요청' },
  { key: 'search', label: '친구 찾기' },
] as const;
export default function FriendsScreen({ navigation }: Props) {
  const [tab, setTab] = useState<'list' | 'requests' | 'search'>('list');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey:
      tab === 'list'
        ? QUERY_KEYS.friends.list
        : tab === 'requests'
          ? QUERY_KEYS.friends.requests
          : QUERY_KEYS.friends.search(search),
    queryFn: ({ pageParam, signal }) =>
      getFriends(tab, search, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.pagination.nextOffset ?? undefined,
    enabled: tab !== 'search' || search.length > 0,
  });
  const { refetch } = query;
  useFocusEffect(
    useCallback(() => {
      if (tab !== 'search' || search) void refetch();
    }, [refetch, search, tab]),
  );
  const mutation = useMutation({
    mutationFn: changeFriendship,
    onSuccess: async (_data, change) => refreshFriendship(client, change),
    onError: async (error, change) => {
      await refreshFriendship(client, change);
      const code = getApiErrorCode(error);
      Alert.alert(
        '친구 관계 확인',
        code === 'FRIENDSHIP_EXISTS'
          ? '이미 친구이거나 대기 중인 요청이 있습니다.'
          : code === 'USER_NOT_FOUND'
            ? '현재 요청할 수 없는 사용자입니다.'
            : '관계가 변경되었거나 요청을 처리하지 못했습니다. 다시 확인해주세요.',
      );
    },
  });
  const rows = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.users)
        .map((user) => [user.userId, user]),
    ).values(),
  ];
  const act = (action: FriendAction['action'], user: FriendUser) => {
    if (action === 'remove')
      Alert.alert('친구 삭제', `${user.nickname}님을 친구에서 삭제할까요?`, [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: () => mutation.mutate({ action, user }),
        },
      ]);
    else mutation.mutate({ action, user });
  };
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={(user) => user.userId}
      refreshing={query.isRefetching}
      onRefresh={() => {
        if (tab !== 'search' || search) void refetch();
      }}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.actions}>
            {tabs.map((item) => (
              <ActionPressable
                key={item.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === item.key }}
                style={[styles.button, tab === item.key && styles.selected]}
                onPress={() => setTab(item.key)}
              >
                <Text style={styles.buttonText}>{item.label}</Text>
              </ActionPressable>
            ))}
          </View>
          {tab === 'search' ? (
            <View style={styles.header}>
              <TextInput
                accessibilityLabel="친구 닉네임"
                placeholder="닉네임으로 검색"
                maxLength={30}
                value={input}
                onChangeText={setInput}
                onSubmitEditing={() => setSearch(input.trim())}
                style={styles.input}
              />
              <ActionPressable
                style={styles.button}
                disabled={!input.trim()}
                onPress={() => setSearch(input.trim())}
              >
                <Text>검색</Text>
              </ActionPressable>
              <Text style={styles.helper}>
                닉네임의 시작 부분을 입력해주세요. 내 계정은 검색되지 않습니다.
              </Text>
            </View>
          ) : null}
          {query.isError ? (
            <ActionPressable
              style={styles.button}
              onPress={() => void refetch()}
            >
              <Text>목록을 불러오지 못했습니다. 다시 시도</Text>
            </ActionPressable>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        query.isError ? null : (
          <InlineEmptyState
            title={
              query.isLoading
                ? '불러오는 중입니다.'
                : tab === 'list'
                  ? '아직 친구가 없습니다.'
                  : tab === 'requests'
                    ? '받은 친구 요청이 없습니다.'
                    : search
                      ? '검색 결과가 없습니다.'
                      : '친구를 찾아보세요.'
            }
            message={
              tab === 'list'
                ? '친구 찾기에서 닉네임으로 요청을 보내세요.'
                : '요청을 수락하면 서로의 공개된 현재 시즌 포트폴리오를 볼 수 있습니다.'
            }
          />
        )
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <ActionPressable
            disabled={item.relationship !== 'friend' || item.active === false}
            onPress={() =>
              navigation.navigate('UserSeasonSummary', { userId: item.userId })
            }
            style={styles.profile}
          >
            {item.profileImageUrl ? (
              <Image
                source={{ uri: item.profileImageUrl }}
                style={styles.avatar}
              />
            ) : null}
            <Text style={styles.nickname}>{item.nickname}</Text>
          </ActionPressable>
          {item.active === false ? (
            <Text style={styles.helper}>현재 이용할 수 없는 사용자입니다.</Text>
          ) : null}
          <View style={styles.actions}>
            {item.relationship === 'none' ? (
              <FriendButton
                label="친구 요청"
                disabled={mutation.isPending}
                onPress={() => act('request', item)}
              />
            ) : null}
            {item.relationship === 'sent' ? (
              <Text>요청 보냄 · 수락 대기 중</Text>
            ) : null}
            {item.relationship === 'received' ? (
              <>
                <FriendButton
                  label="수락"
                  disabled={mutation.isPending}
                  onPress={() => act('accept', item)}
                />
                <FriendButton
                  label="거절"
                  disabled={mutation.isPending}
                  onPress={() => act('reject', item)}
                />
              </>
            ) : null}
            {item.relationship === 'friend' ? (
              <>
                <Text style={styles.helper}>친구</Text>
                <FriendButton
                  label="친구 삭제"
                  disabled={mutation.isPending}
                  onPress={() => act('remove', item)}
                />
              </>
            ) : null}
          </View>
        </View>
      )}
      ListFooterComponent={
        query.hasNextPage ? (
          <FriendButton
            label={query.isFetchingNextPage ? '불러오는 중...' : '더 보기'}
            disabled={query.isFetchingNextPage}
            onPress={() => void query.fetchNextPage()}
          />
        ) : null
      }
    />
  );
}
function FriendButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <ActionPressable
      accessibilityRole="button"
      style={styles.button}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </ActionPressable>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  header: { gap: 12 },
  card: {
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    backgroundColor: '#fafafa',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  },
  button: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    backgroundColor: '#fff',
    flexShrink: 1,
  },
  selected: { backgroundColor: '#e6eefb', borderColor: '#5076ad' },
  buttonText: { fontSize: 15, flexShrink: 1 },
  nickname: { fontSize: 18, fontWeight: '700', flex: 1, minWidth: 0 },
  helper: { fontSize: 14, color: '#555', flexShrink: 1 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    padding: 14,
    borderRadius: 12,
    fontSize: 16,
  },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
});
