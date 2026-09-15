import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { QueryClient, hashKey } from '@tanstack/react-query';
import { QUERY_KEYS } from './queryKeys.ts';
import { invalidateAfterOrderCreate } from '../features/tradingAccount/invalidation.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) ? [file] : [];
  });
}

it('no production key factory is shared by normal and infinite query hooks', (t) => {
  const usage = new Map<string, Set<string>>();
  const counts = { useQuery: 0, useInfiniteQuery: 0 };
  for (const file of sourceFiles(src)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const variables = new Map<string, ts.Expression>();
    function collect(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        variables.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    }
    collect(source);
    function keyFactory(node: ts.Node): string | undefined {
      if (ts.isIdentifier(node) && variables.has(node.text)) return keyFactory(variables.get(node.text)!);
      if (ts.isPropertyAccessExpression(node) && /^QUERY_KEYS\./.test(node.getText(source))) {
        return node.getText(source);
      }
      return ts.forEachChild(node, keyFactory);
    }
    function inspect(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const hook = node.expression.getText(source);
        if (hook === 'useQuery' || hook === 'useInfiniteQuery') {
          counts[hook]++;
          const options = node.arguments[0];
          assert.ok(options && ts.isObjectLiteralExpression(options), `Audit query options in ${file}`);
          const key = options.properties.find(p => p.name?.getText(source) === 'queryKey');
          assert.ok(key && ts.isPropertyAssignment(key), `Audit query key in ${file}`);
          const factory = keyFactory(key.initializer);
          assert.ok(factory, `Resolve query key in ${file}`);
          const hooks = usage.get(factory) ?? new Set();
          hooks.add(hook); usage.set(factory, hooks);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  assert.ok(counts.useQuery > 0 && counts.useInfiniteQuery > 0);
  for (const [key, hooks] of usage) {
    assert.equal(hooks.size, 1, `${key} is used by both normal and infinite queries`);
  }
  t.diagnostic(`Audited ${counts.useQuery} useQuery + ${counts.useInfiniteQuery} useInfiniteQuery across ${usage.size} key factories`);
});

describe('mixed-shape resource keys', () => {
  it('separates shapes with identical filters while retaining season/account identity', () => {
    const rank = { scope: 'near_me', seasonId: 'season-a', limit: 50, offset: 0 };
    const filters = { assetType: 'domestic_stock', limit: 20 };
    const pairs = [
      [QUERY_KEYS.record.seasons({ limit: 20 }), QUERY_KEYS.record.infiniteSeasons({ limit: 20 })],
      [QUERY_KEYS.ranking.list(rank), QUERY_KEYS.ranking.infiniteList(rank)],
      [QUERY_KEYS.tradingAccount.positions('a', filters), QUERY_KEYS.tradingAccount.infinitePositions('a', filters)],
    ];
    for (const [page, infinite] of pairs) assert.notEqual(hashKey(page), hashKey(infinite));
    assert.notEqual(hashKey(QUERY_KEYS.ranking.infiniteList(rank)),
      hashKey(QUERY_KEYS.ranking.infiniteList({ ...rank, seasonId: 'season-b' })));
    assert.notEqual(hashKey(QUERY_KEYS.ranking.infiniteList(rank)),
      hashKey(QUERY_KEYS.ranking.infiniteList({ ...rank, seasonId: null })));
    assert.notEqual(hashKey(QUERY_KEYS.tradingAccount.infinitePositions('a', filters)),
      hashKey(QUERY_KEYS.tradingAccount.infinitePositions('b', filters)));
  });

  it('existing mutation prefixes invalidate both shapes and only the intended account', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const keys = [
      QUERY_KEYS.record.seasons(), QUERY_KEYS.record.infiniteSeasons(),
      QUERY_KEYS.ranking.list({ scope: 'all' }), QUERY_KEYS.ranking.infiniteList({ scope: 'all' }),
      QUERY_KEYS.tradingAccount.positions('a'), QUERY_KEYS.tradingAccount.infinitePositions('a'),
    ];
    const other = QUERY_KEYS.tradingAccount.infinitePositions('b');
    try {
      for (const key of [...keys, other]) client.setQueryData(key, {});
      await invalidateAfterOrderCreate(client, 'a', { seasonUi: true });
      for (const key of keys) assert.equal(client.getQueryState(key)?.isInvalidated, true);
      assert.equal(client.getQueryState(other)?.isInvalidated, false);
      // Ranking snapshot recovery targets only the infinite leaderboard.
      await client.resetQueries({ queryKey: QUERY_KEYS.ranking.infiniteList({ scope: 'all' }), exact: true });
      assert.equal(client.getQueryData(QUERY_KEYS.ranking.infiniteList({ scope: 'all' })), undefined);
      assert.deepEqual(client.getQueryData(QUERY_KEYS.ranking.list({ scope: 'all' })), {});
    } finally { client.clear(); }
  });
});
