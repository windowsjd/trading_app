import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it } from 'node:test';
import { createHomeHarness, elements } from '../../../test/homeTestHarness.cjs';
import { getCapabilityBlockMessage } from '../../features/tradingAccount/capabilities.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { TEST_IDS } from '../../constants/testIds.ts';
import type { TradingAccountPortfolioDto } from '../../features/tradingAccount/api';
import {
  assertDailyEquity,
  DailyEquityContractError,
} from '../../features/tradingAccount/dailyEquity.ts';
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../backend/docs/fixtures/home-daily-equity.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const texts = (node) =>
  elements(node, 'Text')
    .flatMap((node) => node.props.children)
    .join(' ');

describe('Home asset hierarchy and real portfolio/ranking/me sources', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} puts total assets and performance before details, with competition only in season`, (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      h.client.setQueryData(QUERY_KEYS.me, { id: 'user-1', nickname: '김재민', profileImageUrl: 'https://example.test/me.png' });
      const { tree } = h.render();
      const textNodes = elements(tree, 'Text');
      const total = textNodes.find((node) => node.props.testID === TEST_IDS.home.totalAsset);
      assert.equal(total.props.children.join(''), '10,001,000원');
      assert.ok(total.props.style.fontSize > 26);
      assert.ok(texts(tree).includes('-2,345'));
      const detail = textNodes.find((node) => texts(node) === '보유 종목');
      assert.ok(textNodes.indexOf(total) < textNodes.indexOf(detail));
      assert.equal(detail.props.style.fontSize, 18);
      assert.equal(detail.props.style.lineHeight, 27);
      assert.equal(detail.props.style.fontWeight, '700');
      assert.equal(detail.props.accessibilityRole, 'header');
      const nickname = textNodes.find((node) => node.props.testID === TEST_IDS.home.nickname);
      const rank = textNodes.find((node) => node.props.testID === TEST_IDS.home.rank);
      const tier = textNodes.find((node) => node.props.testID === TEST_IDS.home.tier);
      if (mode === 'season') {
        assert.equal(texts(nickname), '김재민');
        const avatar = elements(tree, 'ProfileAvatar')[0];
        assert.equal(avatar.props.profileImageUrl, 'https://example.test/me.png');
        assert.equal(avatar.props.size, 36);
        assert.equal(texts(rank), '#2');
        assert.equal(texts(tier), 'Silver');
        assert.ok(textNodes.indexOf(nickname) < textNodes.indexOf(total));
        assert.ok(textNodes.indexOf(tier) < textNodes.indexOf(detail));
        assert.ok(total.props.style.fontSize > rank.props.style.fontSize);
        assert.ok(h.queries.some((query) => query.queryKey === QUERY_KEYS.me));
      } else {
        assert.equal(texts(nickname), '김재민');
        assert.equal(elements(tree, 'ProfileAvatar').length, 1);
        assert.equal(rank, undefined);
        assert.equal(tier, undefined);
      }
      for (const normal of ['진행 중', '참가 중', '운영 중']) assert.ok(!texts(tree).includes(normal));
    });

    it(`${mode} keeps unknown performance and unavailable summaries explicit`, (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      const key = QUERY_KEYS.tradingAccount.portfolio(h.account.id);
      const portfolio = h.client.getQueryData<TradingAccountPortfolioDto>(key);
      assert.ok(portfolio);
      h.client.setQueryData(key, { ...portfolio, summary: { ...portfolio.summary, returnRate: null } });
      assert.ok(texts(h.render().tree).includes('알 수 없음'));
      h.client.setQueryData(key, { ...portfolio, summary: null });
      const tree = h.render().tree;
      assert.equal(elements(tree, 'Text').filter((node) => node.props.testID === TEST_IDS.home.totalAsset).length, 0);
      assert.ok(elements(tree, 'InlineEmptyState').some((node) => node.props.title === '수익률을 계산할 수 없습니다.'));
    });

    it(`${mode} Hero uses compact labels from the response method, independently of account mode`, (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      const key = QUERY_KEYS.tradingAccount.portfolio(h.account.id);
      const portfolio = h.client.getQueryData<TradingAccountPortfolioDto>(key);
      assert.ok(portfolio?.summary);
      for (const [method, expected] of [
        ['initial_capital', '시즌 수익률'],
        ['time_weighted', '시간가중 수익률'],
      ] as const) {
        h.client.setQueryData(key, {
          ...portfolio,
          summary: { ...portfolio.summary, returnRateMethod: method, returnRate: '-3.52' },
        });
        const hero = elements(h.render().tree, 'View').find(
          (node) => node.props.testID === TEST_IDS.home.summaryCard,
        );
        assert.ok(hero);
        const metric = elements(hero, 'Text').find(
          (node) => Array.isArray(node.props.children) && node.props.children[0] === expected,
        );
        assert.ok(metric, expected);
        assert.equal(elements(metric, 'Text')[1].props.children, '-3.52%');
        assert.doesNotMatch(texts(hero), /초기자본 대비/);
      }
    });
  }

  it('settled season uses final labels and the existing final tier source', (t) => {
    const h = createHomeHarness('season');
    t.after(h.close);
    h.account.season.seasonStatus = 'settled';
    h.seed(h.account, fixture.season.data);
    const tree = h.render().tree;
    for (const text of ['최종 자산', '최종 순위', '최종 등급', 'Gold']) assert.ok(texts(tree).includes(text));
    const rankingQuery = h.queries.find((query) => query.queryKey[0] === 'ranking');
    assert.ok(rankingQuery.queryKey.includes(h.account.season.seasonId));
    assert.ok(rankingQuery.queryKey.includes('final'));
  });
});

describe('home exchange shortcut', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} offers only exchange and opens WalletFx for the selected account`, async (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      const { tree } = h.render();
      const actions = elements(tree, 'CTAButton');
      assert.deepEqual(actions.map((node) => node.props.label), ['환전하기']);
      const button = h.renderCta(actions[0]);
      assert.equal(button.props.disabled, false);
      button.props.onPress();
      assert.deepEqual(h.navigation, [['MainTabs', { screen: 'WalletTab', params: { screen: 'WalletFx', initial: false } }]]);

      h.renderFx();
      const queries = h.fxQueries.filter(
        (query) => query.queryKey[0] === 'tradingAccount',
      );
      assert.equal(queries.length, 2);
      for (const query of queries) {
        assert.equal(query.enabled, true);
        assert.ok(query.queryKey.includes(h.account.id));
        h.response = {
          success: true,
          data: { tradingAccountId: h.account.id, wallets: [] },
        };
        await query.queryFn();
      }
      assert.deepEqual(h.requests.map((request) => request.path), [
        `/trading-accounts/${h.account.id}`,
        `/trading-accounts/${h.account.id}/wallets`,
      ]);
    });

    it(`${mode} keeps exchange full width in scroll content with unrestricted label growth`, (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      const { tree } = h.render();
      const action = elements(tree, 'CTAButton')[0];
      assert.equal(tree.type, 'ScrollView');
      assert.ok(tree.props.children.includes(action));
      const button = h.renderCta(action);
      const style = Object.assign({}, ...button.props.style.filter(Boolean));
      // ActionPressable animates only its internal layers (tested separately).
      assert.equal(style.opacity, undefined);
      const label = elements(button, 'Text')[0];
      assert.equal(texts(button), '환전하기');
      for (const key of ['width', 'height', 'maxWidth', 'maxHeight', 'flex']) {
        assert.equal(style[key], undefined, key);
      }
      assert.notEqual(tree.props.contentContainerStyle.alignItems, 'center');
      assert.ok(tree.props.contentContainerStyle.paddingBottom > 0);
      assert.equal(label.props.numberOfLines, undefined);
      assert.notEqual(label.props.allowFontScaling, false);
      assert.equal(label.props.style.textAlign, 'center');
    });

    for (const status of ['suspended', 'closed']) {
      it(`${mode} ${status} keeps the exchange gate, notice and read actions`, (t) => {
        const h = createHomeHarness(mode);
        t.after(h.close);
        h.account = { ...h.account, status };
        h.seed(h.account, fixture[mode].data);
        const { tree } = h.render();
        assert.deepEqual(elements(tree, 'CTAButton'), []);
        const caps = h.getCapabilities();
        assert.ok(texts(tree).includes(
          getCapabilityBlockMessage(caps, caps.exchangeBlockReason),
        ));
        const walletTree = h.renderWallet().tree;
        for (const label of ['원장 보기', '주문 내역 보기']) {
          const button = elements(walletTree, 'Pressable').find(
            (node) => texts(node) === label,
          );
          assert.ok(button);
          button.props.onPress();
        }
        assert.equal(h.navigation[0][0], 'WalletTransactions');
        assert.equal(h.navigation[1][1].params.params.params.accountId, h.account.id);
      });
    }

    it(`${mode} does not offer exchange before capabilities are available`, (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      h.capabilities = null;
      assert.deepEqual(elements(h.render().tree, 'CTAButton'), []);
    });

    it(`${mode} gates the shortcut on canExchange independently of canTrade`, (t) => {
      const h = createHomeHarness(mode);
      t.after(h.close);
      h.seed(h.account, fixture[mode].data);
      h.capabilities = { ...h.getCapabilities(), canExchange: false, canTrade: true };
      assert.deepEqual(elements(h.render().tree, 'CTAButton'), []);
      h.capabilities = { ...h.getCapabilities(), canExchange: true, canTrade: false };
      assert.deepEqual(
        elements(h.render().tree, 'CTAButton').map((node) => node.props.label),
        ['환전하기'],
      );
    });
  }

  for (const change of [
    { seasonStatus: 'ended' },
    { seasonStatus: 'settled' },
    { participantStatus: 'excluded' },
    { participantStatus: 'finished' },
    { endAt: '2026-09-09T00:00:00Z' },
  ]) {
    it(`season restrictions still gate exchange: ${JSON.stringify(change)}`, (t) => {
      const h = createHomeHarness('season');
      t.after(h.close);
      h.account.season = { ...h.account.season, ...change };
      h.seed(h.account, fixture.season.data);
      const { tree } = h.render();
      const actions = elements(tree, 'CTAButton');
      assert.deepEqual(
        actions.map((node) => node.props.label),
        change.seasonStatus === 'settled' ? ['보상 확인'] : [],
      );
      const caps = h.getCapabilities();
      assert.ok(texts(tree).includes(
        getCapabilityBlockMessage(caps, caps.exchangeBlockReason),
      ));
      if (change.seasonStatus === 'settled') {
        h.renderCta(actions[0]).props.onPress();
        assert.deepEqual(h.navigation, [
          ['MainTabs', { screen: 'MyTab', params: { screen: 'Reward' } }],
        ]);
      }
    });
  }

  it('general ↔ season switches immediately render the current capability and FX account', async (t) => {
    const h = createHomeHarness('season');
    t.after(h.close);
    const season = h.account;
    const general = { ...season, id: 'general-1', mode: 'general', season: null };
    for (const account of [
      general, season, general, { ...season, status: 'suspended' }, general,
    ]) {
      h.account = account;
      h.seed(account, fixture[account.mode].data);
      const { tree, branch } = h.render();
      assert.equal(branch.key, account.id);
      const actions = elements(tree, 'CTAButton');
      assert.deepEqual(
        actions.map((node) => node.props.label),
        account.status === 'active' ? ['환전하기'] : [],
      );
      if (actions.length) {
        h.renderCta(actions[0]).props.onPress();
        assert.deepEqual(h.navigation.at(-1), ['MainTabs', { screen: 'WalletTab', params: { screen: 'WalletFx', initial: false } }]);
        h.renderFx();
        const wallets = h.fxQueries.find(
          (query) => query.queryKey.includes('wallets'),
        );
        h.response = {
          success: true,
          data: { tradingAccountId: account.id, wallets: [] },
        };
        await wallets.queryFn();
        assert.equal(h.requests.at(-1).path, `/trading-accounts/${account.id}/wallets`);
      }
    }
  });
});

describe('general/season home API, queries, rendering and navigation integration', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} opens daily trend above positions and reachable wallet history and its unique features`, async () => {
      const h = createHomeHarness(mode);
      h.seed(h.account, fixture[mode].data);
      const { tree, chart, branch } = h.openTrend();
      const text = texts(tree) + texts(chart);
      for (const label of [
        '자산 추이',
        '보유 종목',
      ])
        assert.ok(text.includes(label), label);
      if (mode === 'general') {
        for (const label of [
          '시간가중 수익률',
          '자금 구성',
          '최초 지급 자본',
          '누적 외부 자금 유입',
          '누적 광고 보상',
          '투자 손익',
        ])
          assert.ok(text.includes(label));
        assert.ok(!text.includes('현재 순위'));
      } else {
        for (const label of ['김재민', '현재 순위', '현재 등급'])
          assert.ok(text.includes(label));
        assert.ok(!text.includes('자금 구성'));
      }
      const line = elements(chart, 'LineChart')[0];
      assert.deepEqual(
        line.props.points.map((p) => p.y),
        fixture[mode].data.points.map((p) => p.totalAssetKrw),
      );
      assert.deepEqual(
        line.props.points.map((p) => p.x),
        ['2026-09-07', '2026-09-08', '2026-09-09'],
      );
      assert.equal(
        line.props.pointValueFormatter(line.props.points[1]),
        '10,001,000원',
      );
      const homeQueries = h.queries;
      const button = elements(h.renderWallet().tree, 'Pressable').find(
        (node) => texts(node) === '주문 내역 보기',
      );
      button.props.onPress();
      assert.deepEqual(h.navigation.at(-1), [
        'MainTabs',
        {
          screen: 'MyTab',
          params: { screen: 'Record', initial: false, params: {
            screen: 'RecordOrderList', initial: false,
            params: { accountId: h.account.id },
          } },
        },
      ]);
      assert.equal(branch.key, h.account.id);
      const query = homeQueries.find((query) =>
        query.queryKey.includes('equity'),
      );
      h.response = fixture[mode];
      assert.deepEqual(await query.queryFn(), fixture[mode].data);
      assert.deepEqual(h.requests.at(-1), {
        path: `/trading-accounts/${h.account.id}/portfolio/equity`,
        params: { range: '30d', granularity: 'daily' },
      });
      h.close();
    });
    it(`${mode} equity integrity failure gates the entire home, while a transient failure stays local`, () => {
      const h = createHomeHarness(mode);
      h.seed(h.account, fixture[mode].data);
      h.render();
      h.failEquity({
        response: {
          status: 500,
          data: { error: { code: 'TRADING_ACCOUNT_INTEGRITY' } },
        },
      });
      const failed = h.render();
      assert.equal(elements(failed.tree, 'ErrorState').length, 1);
      assert.equal(failed.chart, null);
      h.failEquity(new Error('network unavailable'));
      const transient = h.openTrend();
      assert.ok(texts(transient.tree).includes('총 자산'));
      assert.ok(
        elements(transient.chart, 'InlineEmptyState').some(
          (node) => node.props.message === '자산 추이를 불러오지 못했습니다.',
        ),
      );
      h.close();
    });
    it(`${mode} switches never keep previous query data beneath another account name`, () => {
      const h = createHomeHarness(mode);
      h.seed(h.account, fixture[mode].data);
      h.render();
      for (const nextMode of [
        mode,
        mode === 'general' ? 'season' : 'general',
      ]) {
        h.account = { ...h.account, id: nextMode + '-new', mode: nextMode };
        const next = h.render();
        assert.equal(next.chart, null);
        assert.equal(elements(next.tree, 'SectionSkeleton').length, 1);
        assert.ok(
          h.queries
            .filter((query) => query.queryKey[0] === 'tradingAccount')
            .every((query) => query.queryKey.includes(h.account.id)),
        );
      }
      h.close();
    });
  }
  it('rejects malformed/duplicate/out-of-order daily data instead of repairing or showing zero', () => {
    for (const mutate of [
      (data) => {
        delete data.granularity;
      },
      (data) => {
        delete data.points[0].snapshotDate;
      },
      (data) => {
        data.points[0].snapshotDate = '2026-02-31';
      },
      (data) => {
        data.points[1].snapshotDate = data.points[0].snapshotDate;
      },
      (data) => {
        data.points.reverse();
      },
      (data) => {
        data.points[0].totalAssetKrw = 'NaN';
      },
    ]) {
      const data = structuredClone(fixture.general.data);
      mutate(data);
      assert.throws(
        () => assertDailyEquity(data, '30d', 'general-1'),
        DailyEquityContractError,
      );
    }
    const gap = structuredClone(fixture.general.data);
    gap.points.splice(1, 1);
    assert.equal(assertDailyEquity(gap, '30d', 'general-1'), gap);
  });
  for (const mode of ['general', 'season']) {
    it(`${mode} refuses malformed daily envelopes at the API boundary and closes the whole home`, async () => {
      for (const mutate of [
        (data) => {
          delete data.tradingAccountId;
        },
        (data) => {
          data.state = 'empty';
        },
        (data) => {
          data.state = 'unavailable';
        },
        (data) => {
          data.mode = 'unknown';
        },
        (data) => {
          data.returnRateMethod = 'wrong';
          data.points.forEach((point) => {
            point.returnRateMethod = 'wrong';
          });
        },
        (data) => {
          data.points[0] = null;
        },
        (data) => {
          delete data.points[0].time;
        },
        (data) => {
          data.points[0].totalAssetKrw = '9'.repeat(400);
        },
        (data) => {
          data.points[0].returnRate = 'NaN';
        },
        (data) => {
          data.points[0].snapshotReason = 'external_funding_before';
        },
        (data) => {
          delete data.points[0].cumulativeExternalFundingKrw;
        },
      ]) {
        const h = createHomeHarness(mode);
        h.seed(h.account, fixture[mode].data);
        h.render();
        const data = structuredClone(fixture[mode].data);
        mutate(data);
        h.response = { success: true, data };
        const equityQuery = h.queries.find((query) =>
          query.queryKey.includes('equity'),
        );
        let error;
        try {
          await equityQuery.queryFn();
        } catch (caught) {
          error = caught;
        }
        assert.ok(error instanceof DailyEquityContractError);
        h.failEquity(error);
        const result = h.render();
        assert.equal(result.chart, null);
        assert.equal(elements(result.tree, 'ErrorState').length, 1);
        h.close();
      }
    });
    it(`${mode} accepts only an explicit empty history, never an unavailable response as empty`, () => {
      const empty = structuredClone(fixture[mode].data);
      empty.state = 'empty';
      empty.points = [];
      assert.equal(
        assertDailyEquity(empty, '30d', empty.tradingAccountId),
        empty,
      );
      empty.state = 'unavailable';
      assert.throws(
        () => assertDailyEquity(empty, '30d', empty.tradingAccountId),
        DailyEquityContractError,
      );
      assert.throws(
        () => assertDailyEquity(null, '30d', empty.tradingAccountId),
        DailyEquityContractError,
      );
      assert.throws(
        () => assertDailyEquity(empty, '30d', 'other-account'),
        DailyEquityContractError,
      );
    });
  }
});

describe('wallet button through destination RecordOrderList account lookup and API', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} can actually load the explicitly selected account orders at the destination`, async () => {
      const h = createHomeHarness(mode);
      h.seed(h.account, fixture[mode].data);
      const wallet = h.renderWallet();
      const orderButton = elements(wallet.tree, 'Pressable').find(
        (node) => texts(node) === '주문 내역 보기',
      );
      orderButton.props.onPress();
      const scope = h.navigation.at(-1)[1].params.params.params;
      h.renderOrders(scope, [h.account, { ...h.account, id: 'other-account' }]);
      assert.equal(h.orderQuery.enabled, true);
      assert.ok(h.orderQuery.queryKey.includes(h.account.id));
      h.response = {
        success: true,
        data: {
          tradingAccountId: h.account.id,
          orders: [],
          pagination: { nextOffset: null },
        },
      };
      await h.orderQuery.queryFn({ pageParam: 0 });
      assert.equal(
        h.requests.at(-1).path,
        `/trading-accounts/${h.account.id}/orders`,
      );
      h.renderOrders({ accountId: 'foreign' }, [h.account]);
      assert.equal(h.orderQuery.enabled, false);
      h.close();
    });
  }
});

for (const mode of ['general', 'season']) it(`${mode} disclosure, ranges and account switches keep adjacent scoped daily content`, (t) => {
  const h = createHomeHarness(mode);
  t.after(h.close);
  h.seed(h.account, fixture[mode].data);
  let rendered = h.render();
  const toggle = () => elements(rendered.tree, 'Pressable').find(node => node.props.testID === 'home-trend-toggle')!;
  assert.equal(toggle().props.accessibilityState.expanded, false);
  assert.equal(elements(rendered.tree, 'LineChart').length, 0);
  assert.equal(h.queries.find(query => query.queryKey.includes('equity')).enabled, false);
  rendered = h.openTrend();
  assert.equal(toggle().props.accessibilityState.expanded, true);
  const nodes = elements(rendered.tree);
  const at = id => nodes.findIndex(node => node.props.testID === id);
  assert.ok(at('home-summary-card') < at('home-trend-toggle'));
  assert.ok(at('home-trend-toggle') < at('home-trend-chart'));
  assert.ok(at('home-trend-chart') < at('home-holdings'));
  assert.equal(at('home-competition'), -1);
  assert.ok(at('home-holdings') < at('home-hot'));
  for (const range of ['7d', '30d', '90d', '180d', '360d']) {
    rendered = h.selectRange(range);
    const query = h.queries.find(query => query.queryKey.includes('equity'));
    assert.deepEqual(query.queryKey, QUERY_KEYS.tradingAccount.portfolioEquity(h.account.id, range, 'daily'));
    assert.equal(query.enabled, true);
    if (range !== '30d') assert.equal(elements(rendered.tree, 'LineChart').length, 0, 'no previous range data while loading');
  }
  const oldId = h.account.id;
  h.account = { ...h.account, id: 'next-account' };
  h.seed(h.account, { ...fixture[mode].data, tradingAccountId: h.account.id });
  rendered = h.render();
  assert.equal(toggle().props.accessibilityState.expanded, false);
  assert.equal(elements(rendered.tree, 'LineChart').length, 0);
  const query = h.queries.find(query => query.queryKey.includes('equity'));
  assert.ok(!query.queryKey.includes(oldId));
  assert.ok(query.queryKey.includes('30d'));
});
