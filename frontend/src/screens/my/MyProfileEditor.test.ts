import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { TEST_IDS } from '../../constants/testIds.ts';
import type { MeDto, UpdateMeRequestDto } from '../../features/me/api.ts';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';
import { ProfileImageSelectionError, type ProfileImageUpload } from '../../features/me/profileImageTypes.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { QueryClient, QueryClientProvider, QueryObserver, useQuery } = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
// One session-ownership instance for the editor, the photo cache and this test.
const ownership = require(resolve('src/services/api/sessionOwnership.ts'));
const photoCache = load(resolve('src/features/me/profileImageCache.ts'), {
  '../../constants/queryKeys': { QUERY_KEYS },
  '../../services/api/sessionOwnership': ownership,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const baseMe: MeDto = {
  id: 'my-user',
  email: 'my@example.test',
  nickname: '기존 이름',
  profileImageUrl: null,
  role: 'user',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  portfolioPublic: true,
};
const selectedPhoto: ProfileImageUpload = { uri: 'file:///normalized.jpg', name: 'profile.jpg', type: 'image/jpeg' };

/** MY's profile card as MyScreen draws it: its avatar and nickname over the editor, from the /me cache. */
function editorHarness() {
  const h = {
    serverMe: { ...baseMe },
    patchGate: null as ReturnType<typeof deferred> | null,
    patchFailure: false,
    patches: [] as UpdateMeRequestDto[],
    alerts: [] as string[][],
    meReads: 0,
    renderer: null as any,
    selection: null as ProfileImageUpload | null,
    selectionError: null as Error | null,
    selections: 0,
    pickerGate: null as ReturnType<typeof deferred> | null,
    photoGate: null as ReturnType<typeof deferred> | null,
    photoFailure: false,
    photoRequests: [] as string[],
    invalidated: [] as unknown[],
  };
  const client: QueryClientType = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } },
  });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters: any, options: any) => {
    h.invalidated.push(filters?.queryKey);
    return invalidate(filters, options);
  }) as typeof client.invalidateQueries;
  const api = {
    getMe: async () => { h.meReads++; return { ...h.serverMe }; },
    updateMe: async (payload: UpdateMeRequestDto) => {
      h.patches.push(payload);
      if (h.patchGate) await h.patchGate.promise;
      if (h.patchFailure) throw new Error('PATCH /me failed');
      h.serverMe = { ...h.serverMe, ...payload };
      return { ...h.serverMe };
    },
    uploadProfileImage: async () => {
      h.photoRequests.push('upload');
      if (h.photoGate) await h.photoGate.promise;
      if (h.photoFailure) throw new Error('private storage error');
      h.serverMe = { ...h.serverMe, profileImageUrl: 'https://cdn.example.test/new.jpg' };
      return { ...h.serverMe };
    },
    deleteProfileImage: async () => {
      h.photoRequests.push('delete');
      if (h.photoGate) await h.photoGate.promise;
      if (h.photoFailure) throw new Error('private storage error');
      h.serverMe = { ...h.serverMe, profileImageUrl: null };
      return { ...h.serverMe };
    },
  };
  const Editor = load(resolve('src/screens/my/MyProfileEditor.tsx'), {
    'react-native': {
      View: 'View',
      Text: 'Text',
      TextInput: 'TextInput',
      Platform: { OS: 'web' },
      Alert: { alert: (...args: string[]) => h.alerts.push(args) },
      StyleSheet: { create: (value: unknown) => value },
    },
    '../../features/me/api': api,
    '../../features/me/profileImage': { selectProfileImage: async () => {
      h.selections++;
      if (h.pickerGate) await h.pickerGate.promise;
      if (h.selectionError) throw h.selectionError;
      return h.selection;
    } },
    '../../features/me/profileImageCache': photoCache,
    '../../services/api/sessionOwnership': ownership,
  }).default;
  function Card() {
    const me = useQuery({ queryKey: QUERY_KEYS.me, queryFn: api.getMe }).data as MeDto | undefined;
    if (!me) return null;
    return React.createElement('View', null,
      React.createElement('ProfileAvatar', { profileImageUrl: me.profileImageUrl, testID: 'my-profile-avatar' }),
      React.createElement('Text', { testID: 'my-nickname-title' }, me.nickname),
      React.createElement(Editor, { key: me.id, me }));
  }
  const flush = async () => {
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  };
  const mount = async () => {
    await act(async () => { h.renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Card))); });
    await flush();
  };
  const node = (id: string) =>
    h.renderer.root.findAll((item: any) => typeof item.type === 'string' && item.props.testID === id)[0];
  const strings = (item: any): string[] =>
    (item.children ?? []).flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));
  const label = (id: string) => strings(node(id)).join('');
  const text = () => JSON.stringify(h.renderer.toJSON());
  const press = async (id: string) => {
    await act(async () => node(id).props.onPress());
    await flush();
  };
  const unmount = async () => { await act(async () => h.renderer.unmount()); };
  const close = async () => {
    if (h.renderer) await unmount();
    client.clear();
  };
  return { h, client, mount, flush, node, label, text, press, unmount, close };
}

describe('MY profile photo', () => {
  it('reads 프로필 사진 변경 with or without a photo; 사진 삭제 only with one; no second avatar', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    assert.equal(x.label(TEST_IDS.my.profileImageSelect), '프로필 사진 변경');
    assert.equal(x.node(TEST_IDS.my.profileImageDelete) === undefined, true);
    assert.doesNotMatch(x.text(), /사진 추가/);
    await act(async () => x.client.setQueryData<MeDto>(QUERY_KEYS.me, (me) => ({ ...me!, profileImageUrl: 'https://legacy.example.test/avatar.jpg' })));
    await x.flush();
    assert.equal(x.label(TEST_IDS.my.profileImageSelect), '프로필 사진 변경');
    assert.equal(x.label(TEST_IDS.my.profileImageDelete), '사진 삭제');
    // The card's one avatar is MY's own; the editor draws none.
    assert.equal(x.h.renderer.root.findAllByType('ProfileAvatar').length, 1);
  });

  it('registers a first photo from none and offers 사진 삭제 after it', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    x.h.selection = selectedPhoto;
    await x.press(TEST_IDS.my.profileImageSelect);
    assert.deepEqual(x.h.photoRequests, ['upload']);
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.h.renderer.root.findByType('ProfileAvatar').props.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.label(TEST_IDS.my.profileImageSelect), '프로필 사진 변경');
    assert.equal(x.node(TEST_IDS.my.profileImageDelete) === undefined, false);
    // Rankings and this user's summary carry the avatar.
    assert.deepEqual(x.h.invalidated, [['ranking', 'list'], QUERY_KEYS.ranking.userSeasonSummary(baseMe.id)]);
  });

  it('cancels selection without an upload or cache change', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    const before = x.client.getQueryData(QUERY_KEYS.me);
    await x.press(TEST_IDS.my.profileImageSelect);
    assert.equal(x.h.selections, 1); assert.deepEqual(x.h.photoRequests, []);
    assert.deepEqual(x.client.getQueryData(QUERY_KEYS.me), before);
    assert.equal(x.node(TEST_IDS.my.profileImageSelect).props.disabled, false);
  });

  it('shows safe permission/manipulation errors and keeps the prior photo', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    for (const [reason, copy] of [['permission', /사진 접근 권한/], ['processing', /사진을 처리하지 못했습니다/], ['too_large', /사진이 너무 큽니다/]] as const) {
      x.h.selectionError = new ProfileImageSelectionError(reason);
      await x.press(TEST_IDS.my.profileImageSelect);
      assert.match(x.label(TEST_IDS.my.profileImageError), copy); assert.deepEqual(x.h.photoRequests, []);
      assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, null);
    }
  });

  it('blocks rapid selection, replacement and deletion until upload completes', async (t) => {
    const x = editorHarness(); t.after(x.close); x.h.serverMe.profileImageUrl = 'https://legacy.example.test/avatar.jpg'; await x.mount();
    x.h.selection = selectedPhoto; x.h.pickerGate = deferred(); x.h.photoGate = deferred();
    await act(async () => {
      const add = x.node(TEST_IDS.my.profileImageSelect).props.onPress;
      add(); add(); x.node(TEST_IDS.my.profileImageDelete).props.onPress();
    }); await x.flush();
    assert.equal(x.h.selections, 1); assert.deepEqual(x.h.photoRequests, []);
    assert.equal(x.label(TEST_IDS.my.profileImageSelect), '사진 준비 중...');
    assert.equal(x.node(TEST_IDS.my.profileImageSelect).props.disabled, true);
    assert.equal(x.node(TEST_IDS.my.profileImageDelete).props.disabled, true);
    await act(async () => x.h.pickerGate!.resolve()); await x.flush();
    assert.equal(x.label(TEST_IDS.my.profileImageSelect), '업로드 중...'); assert.deepEqual(x.h.photoRequests, ['upload']);
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://legacy.example.test/avatar.jpg');
    await act(async () => x.h.photoGate!.resolve()); await x.flush();
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.h.renderer.root.findByType('ProfileAvatar').props.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.node(TEST_IDS.my.profileImageSelect).props.disabled, false);
  });

  it('keeps the current photo on upload/delete failure and allows retry', async (t) => {
    const x = editorHarness(); t.after(x.close); x.h.serverMe.profileImageUrl = 'https://legacy.example.test/avatar.jpg'; await x.mount();
    x.h.selection = selectedPhoto; x.h.photoFailure = true;
    for (const [id, copy] of [[TEST_IDS.my.profileImageSelect, /사진을 업로드하지 못했습니다/], [TEST_IDS.my.profileImageDelete, /사진을 삭제하지 못했습니다/]] as const) {
      await x.press(id);
      assert.match(x.label(TEST_IDS.my.profileImageError), copy); assert.doesNotMatch(x.text(), /private storage error/);
      assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://legacy.example.test/avatar.jpg');
    }
    x.h.photoFailure = false;
    await x.press(TEST_IDS.my.profileImageSelect);
    assert.equal(x.node(TEST_IDS.my.profileImageError) === undefined, true);
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
  });

  it('blocks concurrent delete actions then immediately restores the default avatar', async (t) => {
    const x = editorHarness(); t.after(x.close); x.h.serverMe.profileImageUrl = 'https://cdn.example.test/current.jpg'; await x.mount();
    x.h.photoGate = deferred();
    await act(async () => {
      const remove = x.node(TEST_IDS.my.profileImageDelete).props.onPress;
      remove(); remove(); x.node(TEST_IDS.my.profileImageSelect).props.onPress();
    }); await x.flush();
    assert.deepEqual(x.h.photoRequests, ['delete']); assert.equal(x.h.selections, 0);
    assert.equal(x.label(TEST_IDS.my.profileImageDelete), '삭제 중...');
    assert.equal(x.node(TEST_IDS.my.profileImageSelect).props.disabled, true);
    await act(async () => x.h.photoGate!.resolve()); await x.flush();
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, null);
    assert.equal(x.h.renderer.root.findByType('ProfileAvatar').props.profileImageUrl, null);
    assert.equal(x.label(TEST_IDS.my.profileImageSelect), '프로필 사진 변경');
    assert.equal(x.node(TEST_IDS.my.profileImageDelete) === undefined, true);
  });

  it('keeps a privacy choice saved meanwhile (Settings) when the upload lands later', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    x.h.selection = selectedPhoto; x.h.photoGate = deferred();
    await x.press(TEST_IDS.my.profileImageSelect);
    // Settings' switch applies only its own field to the same cache entry.
    await act(async () => x.client.setQueryData<MeDto>(QUERY_KEYS.me, (me) => ({ ...me!, portfolioPublic: false })));
    await act(async () => x.h.photoGate!.resolve()); await x.flush();
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.portfolioPublic, false);
  });

  it('updates the same session cache when MY is left during an upload', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount(); x.h.selection = selectedPhoto; x.h.photoGate = deferred();
    await x.press(TEST_IDS.my.profileImageSelect);
    await x.unmount();
    await act(async () => x.h.photoGate!.resolve()); await x.flush();
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
  });

  it('does not send a selected photo after unmount or restore a late response after logout', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount(); x.h.selection = selectedPhoto; x.h.pickerGate = deferred();
    await x.press(TEST_IDS.my.profileImageSelect);
    await x.unmount(); x.client.removeQueries({ queryKey: QUERY_KEYS.me, exact: true });
    await act(async () => x.h.pickerGate!.resolve()); await x.flush(); assert.deepEqual(x.h.photoRequests, []);
    x.h.pickerGate = null; await x.mount(); x.h.photoGate = deferred();
    await x.press(TEST_IDS.my.profileImageSelect);
    await x.unmount(); x.client.removeQueries({ queryKey: QUERY_KEYS.me, exact: true });
    await act(async () => x.h.photoGate!.resolve()); await x.flush();
    assert.equal(x.client.getQueryData(QUERY_KEYS.me), undefined);
  });
});

describe('MY nickname', () => {
  it('shows the nickname once until 닉네임 변경 opens a field with it; 취소 discards the draft', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    assert.equal(x.label('my-nickname-title'), '기존 이름');
    assert.equal(x.node(TEST_IDS.my.nicknameInput) === undefined, true);
    assert.equal(x.label(TEST_IDS.my.nicknameEdit), '닉네임 변경');
    await x.press(TEST_IDS.my.nicknameEdit);
    assert.equal(x.node(TEST_IDS.my.nicknameInput).props.value, '기존 이름');
    assert.equal(x.node(TEST_IDS.my.nicknameEdit) === undefined, true);
    await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText('버릴 이름'));
    await x.press(TEST_IDS.my.nicknameCancel);
    assert.equal(x.node(TEST_IDS.my.nicknameInput) === undefined, true);
    assert.deepEqual(x.h.patches, []);
    await x.press(TEST_IDS.my.nicknameEdit);
    assert.equal(x.node(TEST_IDS.my.nicknameInput).props.value, '기존 이름');
  });

  it('saves the trimmed nickname once, refreshes /me and the rankings, then closes the field', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    await x.press(TEST_IDS.my.nicknameEdit);
    await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText('  새 이름  '));
    x.h.patchGate = deferred();
    await act(async () => {
      const save = x.node(TEST_IDS.my.saveNickname).props.onPress;
      save(); save();
    }); await x.flush();
    assert.deepEqual(x.h.patches, [{ nickname: '새 이름' }]);
    assert.equal(x.label(TEST_IDS.my.saveNickname), '저장 중...');
    assert.deepEqual([x.node(TEST_IDS.my.saveNickname).props.disabled, x.node(TEST_IDS.my.nicknameCancel).props.disabled,
      x.node(TEST_IDS.my.nicknameInput).props.editable], [true, true, false]);
    const reads = x.h.meReads;
    await act(async () => x.h.patchGate!.resolve()); await x.flush();
    assert.deepEqual(x.h.alerts, [['저장 완료', '닉네임이 변경되었습니다.']]);
    assert.equal(x.h.meReads, reads + 1);
    assert.equal(x.label('my-nickname-title'), '새 이름');
    assert.equal(x.node(TEST_IDS.my.nicknameInput) === undefined, true);
    assert.deepEqual(x.h.invalidated, [QUERY_KEYS.me, ['ranking', 'list'], QUERY_KEYS.ranking.userSeasonSummary(baseMe.id)]);
  });

  it('refuses an empty nickname without a request and keeps the field open', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    await x.press(TEST_IDS.my.nicknameEdit);
    for (const value of ['', '   ']) {
      await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText(value));
      await x.press(TEST_IDS.my.saveNickname);
    }
    assert.deepEqual(x.h.alerts, [['입력 확인', '닉네임을 입력해주세요.'], ['입력 확인', '닉네임을 입력해주세요.']]);
    assert.deepEqual(x.h.patches, []);
    assert.equal(x.node(TEST_IDS.my.nicknameInput) === undefined, false);
  });

  it('keeps the field and draft on a failed save and saves on retry', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount();
    await x.press(TEST_IDS.my.nicknameEdit);
    await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText('중복 이름'));
    x.h.patchFailure = true;
    await x.press(TEST_IDS.my.saveNickname);
    assert.deepEqual(x.h.alerts, [['저장 실패', '닉네임 변경에 실패했습니다.']]);
    assert.equal(x.node(TEST_IDS.my.nicknameInput).props.value, '중복 이름');
    assert.equal(x.label('my-nickname-title'), '기존 이름');
    x.h.patchFailure = false;
    await x.press(TEST_IDS.my.saveNickname);
    assert.equal(x.label('my-nickname-title'), '중복 이름');
    assert.deepEqual(x.h.alerts.at(-1), ['저장 완료', '닉네임이 변경되었습니다.']);
  });

  it('keeps an unsaved nickname draft while a photo changes', async (t) => {
    const x = editorHarness(); t.after(x.close); await x.mount(); x.h.selection = selectedPhoto;
    await x.press(TEST_IDS.my.nicknameEdit);
    await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText('작성 중 이름'));
    await x.press(TEST_IDS.my.profileImageSelect);
    assert.equal(x.client.getQueryData<MeDto>(QUERY_KEYS.me)?.profileImageUrl, 'https://cdn.example.test/new.jpg');
    assert.equal(x.node(TEST_IDS.my.nicknameInput).props.value, '작성 중 이름');
  });

  it('re-reads ranking rows on screen after a nickname or photo change, never MY\'s own failed rank (MY stays, so does the editor)', async (t) => {
    const x = editorHarness(); t.after(x.close);
    const reads = { shown: 0, failed: 0 };
    const observe = (queryKey: readonly unknown[], queryFn: () => Promise<unknown>) => {
      const observer = new QueryObserver(x.client, { queryKey, queryFn, retry: false });
      t.after(observer.subscribe(() => {}));
    };
    observe(QUERY_KEYS.ranking.list({ scope: 'all', seasonId: 'season-1', rankType: 'daily', limit: 3, offset: 0 }),
      async () => { reads.shown++; return { rankings: [] }; });
    // MY's own rank read (limit 1), failing: re-reading it would put MY back on its full-page loader.
    const failed = QUERY_KEYS.ranking.list({ scope: 'all', seasonId: 'season-1', rankType: 'daily', limit: 1, offset: 0 });
    observe(failed, async () => { reads.failed++; throw new Error('ranking down'); });
    await x.mount(); await x.flush();
    assert.deepEqual(reads, { shown: 1, failed: 1 });
    await x.press(TEST_IDS.my.nicknameEdit);
    await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText('새 이름'));
    await x.press(TEST_IDS.my.saveNickname); await x.flush();
    assert.deepEqual(reads, { shown: 2, failed: 1 });
    x.h.selection = selectedPhoto;
    await x.press(TEST_IDS.my.profileImageSelect); await x.flush();
    assert.deepEqual(reads, { shown: 3, failed: 1 });
    assert.equal(x.client.getQueryState(failed)?.status, 'error');
  });

  it('a save answered after logout and another login changes nothing in the new session', async (t) => {
    for (const fail of [false, true]) {
      const x = editorHarness(); t.after(x.close); await x.mount();
      await x.press(TEST_IDS.my.nicknameEdit);
      await act(async () => x.node(TEST_IDS.my.nicknameInput).props.onChangeText('늦은 이름'));
      x.h.patchGate = deferred(); x.h.patchFailure = fail;
      await x.press(TEST_IDS.my.saveNickname);
      // Logout leaves MY and clears the cache; the next user signs in.
      await x.unmount(); x.client.removeQueries({ queryKey: QUERY_KEYS.me, exact: true });
      const next = ownership.startSessionInstall(ownership.invalidateSession(ownership.getSessionGeneration()));
      ownership.activateSession(next);
      const other: MeDto = { ...baseMe, id: 'next-user', nickname: '다음 사용자' };
      x.client.setQueryData(QUERY_KEYS.me, other);
      x.h.invalidated = [];
      await act(async () => x.h.patchGate!.resolve()); await x.flush();
      assert.deepEqual(x.h.alerts, [], fail ? 'late failure' : 'late success');
      assert.deepEqual(x.h.invalidated, []);
      assert.deepEqual(x.client.getQueryData(QUERY_KEYS.me), other);
    }
  });
});
