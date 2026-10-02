import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider, useQuery } = require('@tanstack/react-query');
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };

it('uses a themed native control, coalesces duplicate pulls and always settles failures', async () => {
  const h = interactionHarness();
  const { usePullToRefresh } = h.load('src/hooks/usePullToRefresh.tsx');
  const calls: unknown[] = [];
  let release;
  function Screen() {
    const refresh = usePullToRefresh([
      { isFetching: false, refetch: options => { calls.push(options); return new Promise(resolve => { release = resolve; }); } },
      { isFetching: false, refetch: () => Promise.reject(new Error('offline')) },
      { enabled: false, isFetching: false, refetch: () => { throw new Error('hidden query must not run'); } },
    ]);
    return React.createElement('ScrollView', { refreshControl: refresh.refreshControl });
  }
  const renderer = h.render(React.createElement(Screen));
  const control = () => renderer.root.findByType('ScrollView').props.refreshControl;
  try {
    assert.equal(control().type, 'RefreshControl');
    assert.equal(control().props.tintColor, '#111');
    assert.deepEqual(control().props.colors, ['#111']);
    let pending;
    act(() => { pending = control().props.onRefresh(); void control().props.onRefresh(); });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cancelRefetch: false });
    assert.equal(control().props.refreshing, true);
    await act(async () => { release(); await pending; });
    assert.equal(control().props.refreshing, false);
    act(() => { pending = control().props.onRefresh(); });
    assert.equal(calls.length, 2);
    await act(async () => { release(); await pending; });
  } finally { act(() => renderer.unmount()); }
});

it('does not start extra work during background/pagination fetch or disabled search', async () => {
  const h = interactionHarness();
  const { usePullToRefresh } = h.load('src/hooks/usePullToRefresh.tsx');
  let calls = 0;
  function Screen({ enabled, isFetching }) {
    const refresh = usePullToRefresh([{ enabled, isFetching, refetch: async () => { calls++; } }]);
    return React.createElement('ScrollView', { refreshControl: refresh.refreshControl });
  }
  const renderer = h.render(React.createElement(Screen, { enabled: true, isFetching: true }));
  try {
    await act(async () => renderer.root.findByType('ScrollView').props.refreshControl.props.onRefresh());
    assert.equal(calls, 0);
    act(() => renderer.update(React.createElement(Screen, { enabled: false, isFetching: false })));
    const control = renderer.root.findByType('ScrollView').props.refreshControl;
    assert.equal(control.props.enabled, false);
    await act(async () => control.props.onRefresh());
    assert.equal(calls, 0);
  } finally { act(() => renderer.unmount()); }
});

it('preserves query data and local disclosure/range on failure, isolating late account responses', async () => {
  const h = interactionHarness();
  const { usePullToRefresh } = h.load('src/hooks/usePullToRefresh.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  let release;
  let fail = false;
  const calls: string[] = [];
  for (const account of ['general', 'season']) client.setQueryData(['portfolio', account], `${account}-good`);
  function Screen({ account }) {
    const [expanded, setExpanded] = React.useState(true);
    const [range] = React.useState('90d');
    const query = useQuery({ queryKey: ['portfolio', account], queryFn: async () => {
      calls.push(account);
      if (fail) throw new Error('offline');
      return new Promise(resolve => { release = () => resolve(`${account}-late`); });
    } });
    const refresh = usePullToRefresh([query]);
    return React.createElement('ScrollView', { refreshControl: refresh.refreshControl, data: query.data, expanded, range, setExpanded });
  }
  const render = account => React.createElement(QueryClientProvider, { client }, React.createElement(Screen, { account }));
  const renderer = h.render(render('general'));
  const scroll = () => renderer.root.findByType('ScrollView');
  try {
    let pending;
    act(() => { pending = scroll().props.refreshControl.props.onRefresh(); });
    act(() => renderer.update(render('season')));
    assert.equal(scroll().props.data, 'season-good');
    await act(async () => { release(); await pending; }); await flush();
    assert.equal(scroll().props.data, 'season-good');
    assert.equal(client.getQueryData(['portfolio', 'general']), 'general-late');
    fail = true;
    await act(async () => scroll().props.refreshControl.props.onRefresh()); await flush();
    assert.equal(scroll().props.data, 'season-good');
    assert.equal(scroll().props.expanded, true);
    assert.equal(scroll().props.range, '90d');
    assert.equal(scroll().props.refreshControl.props.refreshing, false);
    assert.deepEqual(calls, ['general', 'season']);
  } finally { act(() => renderer.unmount()); client.clear(); }
});
