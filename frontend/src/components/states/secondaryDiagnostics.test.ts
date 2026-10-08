import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const { secondaryDiagnosticsHarness: harness, failure, privateText, act, QUERY_KEYS } = require('../../../test/secondaryDiagnosticsHarness.cjs');

for (const [screen, path] of [['ranking', '/ranking'], ['summary', '/users/friend/season-summary'], ['list', '/records/me/seasons'], ['detail', '/records/me/seasons/record-0'], ['profit', '/records/me/seasons/record-0'], ['friends', '/friends'], ['season', '/seasons/current'], ['reward', '/rewards/me'], ['my', '/records/me/seasons']]) {
  for (const role of ['user', 'operator', 'admin']) it(`${screen}: original HTTP error and ${role} role gate`, async t => {
    const h = harness(screen, role); t.after(h.close);
    h.failures[path] = failure(`${screen}-request`);
    await h.start(); await h.expand();
    assert.equal(h.panels().length, role === 'admin' ? 1 : 0);
    assert.equal(h.text().includes(`${screen}-request`), role === 'admin');
    assert.ok(!h.text().includes(privateText));
    if (screen !== 'friends') {
      delete h.failures[path]; await h.retry();
      assert.equal(h.panels().length, 0, 'successful retry removes the original diagnostic');
    }
  });
}

it('independent reward failures retain separate panels and clear independently', async t => {
  const h = harness('reward'); t.after(h.close);
  h.failures['/rewards/me'] = failure('reward-request'); h.failures['/badges/me'] = failure('badge-request');
  await h.start(); await h.expand(); assert.equal(h.panels().length, 2);
  assert.match(h.text(), /reward-request/); assert.match(h.text(), /badge-request/);
  delete h.failures['/rewards/me']; await h.retry(); await h.expand();
  assert.equal(h.panels().length, 1); assert.doesNotMatch(h.text(), /reward-request/);
});

it('records partial failures preserve healthy rows and clear after normalization', async t => {
  const h = harness('profit'); t.after(h.close);
  const detail = h.data['/records/me/seasons/record-0'];
  detail.profitAnalysis.state = 'partial_unavailable';
  detail.profitAnalysis.valuationErrors = [{ assetId: 'asset-a', code: 'ASSET_PRICE_UNAVAILABLE', diagnostic: failure('partial-row').response.data.error.diagnostic }];
  await h.start(); await h.expand();
  assert.equal(h.panels().length, 1); assert.match(h.text(), /partial-row/);
  assert.ok(h.renderer.root.findAllByType('LineChart').length);
  detail.profitAnalysis = { ...detail.profitAnalysis, state: 'available', valuationErrors: [] };
  await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.record.seasonDetail('record-0') }); }); await h.flush();
  assert.equal(h.panels().length, 0);
});

it('records equity failure is separate from available profit analysis', async t => {
  const h = harness('profit'); t.after(h.close);
  h.failures['/records/me/seasons/record-0/equity'] = failure('equity-request');
  await h.start(); await h.expand(); assert.equal(h.panels().length, 1); assert.match(h.text(), /equity-request/);
  await h.press(p => p.label === '다시 시도');
  assert.equal(h.requests.filter((path: string) => path.endsWith('/equity')).length, 2);
  assert.equal(h.requests.filter((path: string) => path === '/records/me/seasons/record-0').length, 1);
});

for (const screen of ['ranking','list','friends','reward','my']) it(`${screen}: normal empty/policy state creates no diagnostic`, async t => {
  const h = harness(screen); t.after(h.close); await h.start(); assert.equal(h.panels().length, 0);
});

it('season not configured creates no diagnostic', async t => {
  const h = harness('season'); t.after(h.close); h.failures['/seasons/current'] = failure('not-found', 'SEASON_NOT_FOUND');
  await h.start(); assert.equal(h.panels().length, 0);
});

it('Ranking season absence stays a policy state without querying a nonexistent publication', async t => {
  const h = harness('ranking'); t.after(h.close);
  h.failures['/seasons/current'] = failure('no-season', 'SEASON_NOT_FOUND');
  await h.start(); assert.equal(h.panels().length, 0); assert.match(h.text(), /현재 진행 중인 시즌이 없습니다/);
  assert.ok(!h.requests.includes('/ranking')); assert.doesNotMatch(h.text(), /no-season/);
});

for (const access of ['private', 'not_friend', 'unavailable']) it(`Profile ${access} is a normal policy state without diagnostics`, async t => {
  const h = harness('summary'); t.after(h.close);
  h.data['/users/friend/season-summary'].portfolioAccess = access;
  await h.start(); assert.equal(h.panels().length, 0);
});

it('missing season record is not presented as a technical failure', async t => {
  const h = harness('detail'); t.after(h.close);
  h.failures['/records/me/seasons/record-0'] = failure('missing-record', 'SEASON_NOT_FOUND');
  await h.start(); assert.equal(h.panels().length, 0); assert.match(h.text(), /해당 시즌 전적이 없습니다/);
});

it('a late record response stays attached to its requested season', async t => {
  const h = harness('detail'); t.after(h.close);
  let resolve!: () => void;
  h.gates['/records/me/seasons/record-0'] = { promise: new Promise<void>(r => { resolve = r; }) };
  h.failures['/records/me/seasons/record-0'] = failure('old-record-request');
  h.data['/records/me/seasons/record-1'] = h.data['/records/me/seasons/record-0'];
  await h.start(); h.route = { seasonId: 'record-1' }; await h.update();
  resolve(); await h.flush(); await h.expand();
  assert.equal(h.panels().length, 0); assert.doesNotMatch(h.text(), /old-record-request/);
});

it('Settings hides details if its /me query fails, including cached admin role', async t => {
  const h = harness('settings'); t.after(h.close); h.failures['/me'] = failure('me-request');
  await h.start(); assert.equal(h.panels().length, 0);
});

for (const role of ['user','operator','admin']) it(`Settings nickname and privacy mutations: ${role}, recovery and separate errors`, async t => {
  const h = harness('settings', role); t.after(h.close); await h.start();
  h.failures['PATCH /me'] = failure('nickname-request');
  const nickname = h.renderer.root.findAllByType('TextInput')[0]; act(() => nickname.props.onChangeText('새닉네임'));
  await h.press(p => String(p.testID).includes('save-nickname')); await h.expand();
  assert.equal(h.panels().length, role === 'admin' ? 1 : 0);
  assert.ok(h.alerts.some((alert: string[]) => alert[0] === '저장 실패'));
  delete h.failures['PATCH /me']; await h.press(p => String(p.testID).includes('save-nickname'));
  assert.equal(h.panels().length, 0);
  h.failures['PATCH /me'] = failure('privacy-request');
  act(() => h.renderer.root.findAllByType('Switch').find((n: any) => n.props.testID === 'settings-portfolio-public').props.onValueChange(true)); await h.flush(); await h.expand();
  assert.equal(h.panels().length, role === 'admin' ? 1 : 0);
});

for (const role of ['user', 'operator', 'admin']) it(`Friends mutation preserves Alert and clears diagnostic on success for ${role}`, async t => {
  const h = harness('friends', role); t.after(h.close);
  h.data['/friends/requests'].users = [{ userId: 'friend', nickname: '친구', relationship: 'received', requestId: 'request-1' }];
  await h.start(); await h.press(p => p.accessibilityLabel === '받은 요청');
  h.failures['POST /friends/requests/request-1/accept'] = failure('accept-request');
  const accept = async () => {
    const button = h.renderer.root.findAll((n: any) => n.type.name === 'FriendButton' && n.props.label === '수락')[0];
    act(() => button.props.onPress()); await h.flush(); await h.flush();
  };
  await accept(); await h.expand();
  assert.equal(h.panels().length, role === 'admin' ? 1 : 0);
  assert.equal(h.text().includes('accept-request'), role === 'admin');
  assert.equal(h.alerts.at(-1)[0], '친구 관계 확인');
  delete h.failures['POST /friends/requests/request-1/accept']; await accept();
  assert.equal(h.panels().length, 0);
});

it('Friends late mutation failure is detached after a tab change', async t => {
  const h = harness('friends'); t.after(h.close);
  h.data['/friends/requests'].users = [{ userId: 'friend', nickname: '친구', relationship: 'received', requestId: 'request-1' }];
  const path = 'POST /friends/requests/request-1/accept';
  let resolve!: () => void;
  h.gates[path] = { promise: new Promise<void>(r => { resolve = r; }) };
  h.failures[path] = failure('late-friend-request');
  await h.start(); await h.press(p => p.accessibilityLabel === '받은 요청');
  act(() => h.renderer.root.findAll((n: any) => n.type.name === 'FriendButton' && n.props.label === '수락')[0].props.onPress());
  await h.flush(); await h.press(p => p.accessibilityLabel === '친구 목록');
  resolve(); await h.flush(); await h.flush();
  assert.equal(h.panels().length, 0);
  await h.press(p => p.accessibilityLabel === '받은 요청'); assert.equal(h.panels().length, 0);
});

for (const role of ['user', 'operator', 'admin']) it(`Season join failure retries the original mutation and clears on success for ${role}`, async t => {
  const h = harness('season', role); t.after(h.close);
  h.failures['POST /seasons/season-1/join'] = failure('join-request');
  await h.start(); await h.press(p => p.label === '시즌 참가하기'); await h.expand();
  assert.equal(h.panels().length, role === 'admin' ? 1 : 0);
  assert.equal(h.text().includes('join-request'), role === 'admin');
  delete h.failures['POST /seasons/season-1/join']; await h.retry();
  assert.equal(h.panels().length, 0);
  assert.equal(h.requests.filter((p: string) => p === 'POST /seasons/season-1/join').length, 2);
});

it('Season change hides the previous join failure without submitting another mutation', async t => {
  const h = harness('season'); t.after(h.close);
  h.failures['POST /seasons/season-1/join'] = failure('old-season-request');
  await h.start(); await h.press(p => p.label === '시즌 참가하기'); await h.expand();
  assert.equal(h.panels().length, 1);
  h.season = { ...h.season, id: 'season-2' };
  await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.season.current }); }); await h.flush();
  assert.equal(h.panels().length, 0); assert.doesNotMatch(h.text(), /old-season-request/);
  assert.equal(h.requests.filter((p: string) => p.startsWith('POST ')).length, 1);
});
