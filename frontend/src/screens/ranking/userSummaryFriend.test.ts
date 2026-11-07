import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { secondaryDiagnosticsHarness: harness, failure, act, QUERY_KEYS } = require('../../../test/secondaryDiagnosticsHarness.cjs');

/**
 * 유저 시즌 요약 (2026-11-06): the ranking tab's tier card for the SELECTED
 * user, and the friend action under it. The real screen, React Query, friends
 * API and cache over fixture transport. Assertions read strings/booleans only.
 */
const SUMMARY = '/users/friend/season-summary';
const RELATION = '/friends/relationships/friend';
const summary = (season: Record<string, unknown> | null, patch: Record<string, unknown> = {}) => ({
  state: 'available', user: { id: 'friend', nickname: '다른유저', profileImageUrl: null },
  season: season && {
    id: 'season-1', name: '시즌 1', status: 'active', rank: 3, provisionalTier: 'bronze', finalTier: null, percentile: '30',
    returnRate: '12.34000000', totalAssetKrw: '10450000.00000000', maxDrawdown: '0', totalFillCount: 4, ...season,
  },
  portfolioAccess: 'not_friend', portfolio: null, ...patch,
});
/** A refused command as the server answers it. */
const refused = (status: number, code: string) => ({ isAxiosError: true, response: { status, data: { success: false, error: { code, message: code } } } });
const ownText = (node: any): string => node === undefined ? '' : [node.props.children].flat(Infinity)
  .filter((value: unknown) => typeof value === 'string' || typeof value === 'number').join('');
const node = (h: any, id: string) => h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
const exists = (h: any, id: string) => node(h, id) !== undefined;
/** Every Text string under one node (never the instance itself). */
const texts = (h: any, id: string) => {
  const root = node(h, id);
  return root === undefined ? '' : root.findAllByType('Text').map(ownText).join(' ');
};
const press = async (h: any, id: string) => {
  const target = node(h, id);
  assert.equal(target === undefined, false, `missing ${id}`);
  act(() => target.props.onPress());
  await h.flush(); await h.flush();
};
const reads = (h: any, key: string) => h.requests.filter((request: string) => request === key).length;

describe('유저 시즌 요약: the tier card of the selected user', () => {
  it("shows the selected user's profile, 시즌 순위, figures and tier on 내 순위's card, never the member's own", async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({});
    await h.start();
    // The ranking tab's StandingCard on its tier art (TierCard), with this user's figures.
    assert.equal(exists(h, 'user-summary-card'), true);
    assert.deepEqual([ownText(node(h, 'user-summary-nickname')), ownText(node(h, 'user-summary-rank')),
      ownText(node(h, 'user-summary-return')), ownText(node(h, 'user-summary-total')), ownText(node(h, 'user-summary-tier'))],
    ['다른유저', '#3', '+12.34%', '10,450,000원', 'Bronze']);
    assert.match(texts(h, 'user-summary-card'), /시즌 순위/);
    assert.doesNotMatch(texts(h, 'user-summary-card'), /내 순위|사용자/, "no '내 순위' and not the signed-in member's nickname");
    assert.equal(exists(h, 'home-emblem-bronze'), true, 'the tier emblem (with the spotlight)');
    assert.equal(exists(h, 'user-summary-settled'), false, 'a daily standing');
    // The season it is about, as before.
    assert.match(h.text(), /시즌 1/);
    // The figures were moved, not repeated in a second card.
    assert.doesNotMatch(h.text(), /현재 시즌 요약|총 자산 10,450,000원/);
  });

  it('a final standing is marked 최종 랭킹 확정; an unknown tier or rank uses the plain card and invents no figure', async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({ provisionalTier: null, finalTier: 'master' });
    await h.start();
    assert.deepEqual([ownText(node(h, 'user-summary-tier')), exists(h, 'user-summary-settled')], ['Whale', true]);
    // Not joined: the server sends no rank, tier or figures.
    h.data[SUMMARY] = summary({ rank: null, provisionalTier: null, returnRate: null, totalAssetKrw: null, totalFillCount: 0 },
      { state: 'not_joined', portfolioAccess: 'unavailable' });
    await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.userSeasonSummary('friend') }); }); await h.flush();
    assert.equal(exists(h, 'user-summary-card'), true);
    assert.equal(exists(h, 'user-summary-tier'), false, 'plain card without a tier');
    assert.deepEqual([ownText(node(h, 'user-summary-rank')), ownText(node(h, 'user-summary-return')), ownText(node(h, 'user-summary-total'))], ['-', '-', '-']);
    assert.match(h.text(), /친구가 현재 시즌에 참가하지 않았습니다/);
    // No current season at all.
    h.data[SUMMARY] = summary(null, { state: 'unavailable', portfolioAccess: 'unavailable' });
    await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.userSeasonSummary('friend') }); }); await h.flush();
    assert.deepEqual([exists(h, 'user-summary-tier'), ownText(node(h, 'user-summary-rank')), ownText(node(h, 'user-summary-total'))], [false, '-', '-']);
  });
});

describe('유저 시즌 요약: friend action by user id', () => {
  it('none → 친구 요청 (one request however fast it is tapped) → 요청 보냄 · 수락 대기 중', async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({});
    await h.start();
    // Cached 친구 목록 / 받은 요청 pages (the 친구 screen, the MY dot): refreshed by the command.
    const page = { pages: [{ users: [], pagination: { nextOffset: null } }], pageParams: [0] };
    for (const key of [QUERY_KEYS.friends.list, QUERY_KEYS.friends.requests]) h.client.setQueryData(key, page);
    assert.equal(reads(h, RELATION) > 0, true, 'read by the user id');
    const request = node(h, 'user-summary-friend-request');
    assert.deepEqual([texts(h, 'user-summary-friend-request'), request.props.accessibilityRole, request.props.accessibilityLabel], ['친구 요청', 'button', '다른유저님에게 친구 요청']);
    let release!: () => void;
    h.gates['POST /friends/requests'] = { promise: new Promise<void>((done) => { release = done; }) };
    act(() => { request.props.onPress(); request.props.onPress(); });
    await h.flush();
    assert.equal(reads(h, 'POST /friends/requests'), 1, 'a double tap sends once');
    const busy = node(h, 'user-summary-friend-request');
    assert.deepEqual([texts(h, 'user-summary-friend-request'), busy.props.disabled, busy.props['aria-busy']], ['요청 중...', true, true]);
    act(() => busy.props.onPress());
    // The server now holds the request.
    h.data[RELATION] = { userId: 'friend', relationship: 'sent', requestId: 'req-1' };
    release(); await h.flush(); await h.flush();
    assert.equal(reads(h, 'POST /friends/requests'), 1);
    assert.equal(texts(h, 'user-summary-friend-sent'), '요청 보냄 · 수락 대기 중');
    assert.equal(exists(h, 'user-summary-friend-request'), false);
    // The friend lists and 받은 요청 (the MY dot) were refreshed with it.
    for (const key of [QUERY_KEYS.friends.list, QUERY_KEYS.friends.requests])
      assert.equal(h.client.getQueryState(key)?.isInvalidated, true, key.join('/'));
  });

  it('received → 수락: friend, and the summary is read again so the server decides the portfolio', async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({});
    h.data[RELATION] = { userId: 'friend', relationship: 'received', requestId: 'req-9' };
    await h.start();
    assert.match(texts(h, 'user-summary-friend'), /다른유저님이 친구 요청을 보냈어요\./);
    assert.deepEqual([texts(h, 'user-summary-friend-accept'), texts(h, 'user-summary-friend-reject')], ['수락', '거절']);
    const before = reads(h, SUMMARY);
    h.data[RELATION] = { userId: 'friend', relationship: 'friend', requestId: 'req-9' };
    // A private portfolio stays private after the friendship.
    h.data[SUMMARY] = summary({}, { portfolioAccess: 'private' });
    await press(h, 'user-summary-friend-accept');
    assert.equal(reads(h, 'POST /friends/requests/req-9/accept'), 1);
    assert.equal(texts(h, 'user-summary-friend-friend'), '친구');
    assert.equal(reads(h, SUMMARY) > before, true, 'portfolio permission read again');
    assert.match(h.text(), /이 사용자는 포트폴리오를 비공개로 설정했습니다/);
    assert.doesNotMatch(h.text(), /자산 배분|보유종목/);
    for (const id of ['user-summary-friend-request', 'user-summary-friend-accept', 'user-summary-friend-reject']) assert.equal(exists(h, id), false, id);
  });

  it('received → 거절: none again, with 친구 요청', async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({});
    h.data[RELATION] = { userId: 'friend', relationship: 'received', requestId: 'req-9' };
    await h.start();
    h.data[RELATION] = { userId: 'friend', relationship: 'none', requestId: null };
    await press(h, 'user-summary-friend-reject');
    assert.equal(reads(h, 'POST /friends/requests/req-9/reject'), 1);
    assert.equal(texts(h, 'user-summary-friend-request'), '친구 요청');
  });

  it('a refused command re-reads the server state and says why (an existing request, a request gone meanwhile)', async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({});
    await h.start();
    // The other member asked first: the request is refused and their request shows.
    h.failures['POST /friends/requests'] = refused(409, 'FRIENDSHIP_EXISTS');
    h.data[RELATION] = { userId: 'friend', relationship: 'received', requestId: 'req-2' };
    await press(h, 'user-summary-friend-request');
    assert.match(texts(h, 'user-summary-friend'), /이미 친구이거나 대기 중인 요청이 있어요/);
    assert.equal(exists(h, 'user-summary-friend-accept'), true, 'the latest relationship');
    // Their request was withdrawn by a rejection elsewhere before this accept.
    h.failures['POST /friends/requests/req-2/accept'] = refused(404, 'FRIEND_REQUEST_NOT_FOUND');
    h.data[RELATION] = { userId: 'friend', relationship: 'none', requestId: null };
    await press(h, 'user-summary-friend-accept');
    assert.match(texts(h, 'user-summary-friend'), /이미 처리되었거나 취소된 요청이에요/);
    assert.equal(exists(h, 'user-summary-friend-request'), true);
  });

  it('friend shows 친구; the member\'s own summary has no friend action and no relationship read', async (t) => {
    const friend = harness('summary', 'user'); t.after(friend.close);
    friend.data[SUMMARY] = summary({});
    friend.data[RELATION] = { userId: 'friend', relationship: 'friend', requestId: 'f-1' };
    await friend.start();
    assert.equal(texts(friend, 'user-summary-friend-friend'), '친구');
    const self = harness('summary', 'user'); t.after(self.close);
    // `user-1` is the signed-in member (the /me cache).
    self.route = { userId: 'user-1' };
    self.data['/users/user-1/season-summary'] = { ...summary({}), user: { id: 'user-1', nickname: '사용자', profileImageUrl: null } };
    await self.start();
    assert.equal(exists(self, 'user-summary-card'), true);
    assert.equal(exists(self, 'user-summary-friend'), false);
    assert.equal(self.requests.some((request: string) => request.startsWith('/friends/relationships/')), false);
  });

  it("the member's own summary shows the portfolio the server authorizes and never upgrades a refusal", async (t) => {
    const portfolio = { valuationState: 'available', holdings: [], history: [],
      allocation: { cashKrwValue: '7654321.00000000', domesticStockValueKrw: '0', usStockValueKrw: '0', cryptoValueKrw: '0' },
      futures: { evaluatedAt: new Date().toISOString(), positions: [] } };
    const own = (patch: Record<string, unknown>) =>
      ({ ...summary({}, patch), user: { id: 'user-1', nickname: '사용자', profileImageUrl: null } });
    // 2026-11-06 server: the owner's own read is authorized without a friendship.
    const self = harness('summary', 'user'); t.after(self.close);
    self.route = { userId: 'user-1' };
    self.data['/users/user-1/season-summary'] = own({ portfolioAccess: 'available', portfolio });
    await self.start();
    assert.equal(self.text().includes('자산 배분'), true);
    assert.equal(self.text().includes('7,654,321'), true);
    assert.equal(self.text().includes('친구 요청을 수락한 사용자만'), false);
    // An older server still says not_friend: the client shows nothing in its place.
    const older = harness('summary', 'user'); t.after(older.close);
    older.route = { userId: 'user-1' };
    older.data['/users/user-1/season-summary'] = own({ portfolioAccess: 'not_friend', portfolio });
    await older.start();
    assert.equal(older.text().includes('자산 배분') || older.text().includes('7,654,321'), false);
    assert.equal(older.text().includes('친구 요청을 수락한 사용자만 포트폴리오를 볼 수 있습니다.'), true);
  });

  it('a failed relationship read is never "none": it offers 다시 시도; an inactive user says so without a request button', async (t) => {
    for (const role of ['user', 'admin'] as const) {
      const h = harness('summary', role); t.after(h.close);
      h.data[SUMMARY] = summary({});
      h.failures[RELATION] = failure('relationship-request');
      await h.start();
      assert.match(texts(h, 'user-summary-friend'), /친구 관계를 확인하지 못했어요/);
      assert.equal(exists(h, 'user-summary-friend-request'), false, role);
      // The card and the rest of the summary still show; the diagnostic only for an admin.
      assert.equal(ownText(node(h, 'user-summary-total')), '10,450,000원');
      assert.equal(h.panels().length, role === 'admin' ? 1 : 0, role);
      delete h.failures[RELATION];
      await press(h, 'user-summary-friend-retry');
      assert.equal(texts(h, 'user-summary-friend-request'), '친구 요청', role);
      assert.equal(h.panels().length, 0, role);
    }
    const gone = harness('summary', 'user'); t.after(gone.close);
    gone.data[SUMMARY] = summary({});
    gone.failures[RELATION] = refused(404, 'USER_NOT_FOUND');
    await gone.start();
    assert.match(texts(gone, 'user-summary-friend'), /현재 친구 요청을 할 수 없는 사용자예요/);
    assert.deepEqual([exists(gone, 'user-summary-friend-retry'), exists(gone, 'user-summary-friend-request')], [false, false]);
  });

  it("an answer for another user id is an error, never that user's relationship", async (t) => {
    const h = harness('summary', 'user'); t.after(h.close);
    h.data[SUMMARY] = summary({});
    h.data[RELATION] = { userId: 'someone-else', relationship: 'friend', requestId: 'x' };
    await h.start();
    assert.equal(exists(h, 'user-summary-friend-friend'), false);
    assert.match(texts(h, 'user-summary-friend'), /친구 관계를 확인하지 못했어요/);
  });
});
