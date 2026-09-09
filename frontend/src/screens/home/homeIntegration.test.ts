import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, it } from 'node:test';
import { createHomeHarness, elements } from '../../../test/homeTestHarness.cjs';
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

describe('general/season home API, queries, rendering and navigation integration', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} has both charts, wallet ledger, orders, positions and its unique features`, async () => {
      const h = createHomeHarness(mode);
      h.seed(h.account, fixture[mode].data);
      const { tree, chart, branch } = h.render();
      const text = texts(tree) + texts(chart);
      for (const label of [
        '자산 배분',
        '자산 추이',
        '지갑 요약',
        '원장 보기',
        '주문 내역 보기',
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
        for (const label of ['9월 시즌', '현재 순위', '현재 등급'])
          assert.ok(text.includes(label));
        assert.ok(!text.includes('자금 구성'));
      }
      const donut = elements(chart, 'DonutChart')[0];
      assert.deepEqual(
        donut.props.segments.map((s) => s.value),
        ['10000', '1000', '9900000', '90000'],
      );
      assert.equal(donut.props.totalLabel, '10,001,000원');
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
      const button = elements(tree, 'Pressable').find(
        (node) => texts(node) === '주문 내역 보기',
      );
      button.props.onPress();
      assert.deepEqual(h.navigation.at(-1), [
        'MainTabs',
        {
          screen: 'RecordTab',
          params: {
            screen: 'RecordOrderList',
            params: { accountId: h.account.id },
          },
        },
      ]);
      assert.equal(branch.key, h.account.id);
      const query = h.queries.find((query) =>
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
      const transient = h.render();
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
        next.branch.props.onOpenOrders();
        assert.equal(
          h.navigation.at(-1)[1].params.params.accountId,
          h.account.id,
        );
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

describe('home button through destination RecordOrderList account lookup and API', () => {
  for (const mode of ['general', 'season']) {
    it(`${mode} can actually load the explicitly selected account orders at the destination`, async () => {
      const h = createHomeHarness(mode);
      h.seed(h.account, fixture[mode].data);
      const home = h.render();
      const orderButton = elements(home.tree, 'Pressable').find(
        (node) => texts(node) === '주문 내역 보기',
      );
      orderButton.props.onPress();
      const scope = h.navigation.at(-1)[1].params.params;
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
