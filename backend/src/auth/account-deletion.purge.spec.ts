jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<Record<string, unknown>>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class {},
    Prisma: { sql: runtime.sqltag, raw: runtime.raw, join: runtime.join },
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma } from '../generated/prisma/client';
import {
  ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN,
  isAccountDeletionPlaceholderEmail,
  purgeDeletionScope,
} from './account-deletion.purge';

type Edge = { child: string; parent: string; onDelete: string };

/** Foreign keys as declared in schema.prisma (table names via @@map). */
function schemaEdges() {
  const schema = readFileSync(
    join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );
  const models = new Map<string, { table: string; body: string }>();
  for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const table = /@@map\("([^"]+)"\)/.exec(match[2])?.[1] ?? match[1];
    models.set(match[1], { table, body: match[2] });
  }
  const edges: Edge[] = [];
  for (const { table, body } of models.values()) {
    for (const line of body.split('\n')) {
      const relation = /^\s*\w+\s+(\w+)(\??)\s+@relation\(([^)]*)\)/.exec(line);
      if (!relation || !relation[3].includes('fields:')) continue;
      const parent = models.get(relation[1]);
      if (!parent) throw new Error(`Unknown model ${relation[1]}`);
      edges.push({
        child: table,
        parent: parent.table,
        onDelete:
          /onDelete:\s*(\w+)/.exec(relation[3])?.[1] ??
          (relation[2] ? 'SetNull' : 'Restrict'),
      });
    }
  }
  return edges;
}

/** The DELETE statements, in execution order, against a recording client. */
async function purgeOrder() {
  const statements: string[] = [];
  const tx = {
    $executeRaw: (sql: Prisma.Sql) => {
      statements.push(sql.text);
      return Promise.resolve(0);
    },
  };
  await purgeDeletionScope(tx as unknown as Prisma.TransactionClient, {
    userId: 'member-id',
    email: 'member@example.com',
    scope: {
      accountIds: ['account-id'],
      participants: [
        { id: 'participant-id', seasonId: 's', tradingAccountId: 'a' },
      ],
      seasonStatus: new Map(),
    },
  });
  return { statements, tables: statements.map(tableOf) };
}
function tableOf(sql: string) {
  const match = /^DELETE FROM (\w+) WHERE/.exec(sql);
  if (!match) throw new Error(`Unexpected purge statement: ${sql}`);
  return match[1];
}

/** Rows that reference a member but are handled without a named DELETE. */
const EXEMPT: Record<string, string> = {
  // Operators/admins and former operators are refused (hasOperatorFootprint).
  operator_audit_logs: 'refused',
  // ON DELETE CASCADE from push_notifications (and SET NULL from devices).
  push_deliveries: 'cascade',
};

describe('account deletion purge plan', () => {
  const edges = schemaEdges();

  it('covers every table that references a member or a trading account', async () => {
    const owned = new Set(['users', 'trading_accounts']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const edge of edges)
        if (owned.has(edge.parent) && !owned.has(edge.child)) {
          owned.add(edge.child);
          grew = true;
        }
    }
    const { tables } = await purgeOrder();
    const missing = [...owned]
      .filter((table) => !tables.includes(table) && !(table in EXEMPT))
      .sort();
    expect(missing).toEqual([]);
    // Exemptions must still be real member references.
    for (const table of Object.keys(EXEMPT))
      expect(owned.has(table)).toBe(true);
  });

  it('deletes every child before a RESTRICT parent and the member last', async () => {
    const { tables } = await purgeOrder();
    const violations = edges
      .filter(
        (edge) =>
          edge.child !== edge.parent &&
          ['Restrict', 'NoAction'].includes(edge.onDelete) &&
          tables.includes(edge.child) &&
          tables.includes(edge.parent),
      )
      .filter(
        (edge) => tables.lastIndexOf(edge.child) > tables.indexOf(edge.parent),
      )
      .map((edge) => `${edge.child} -> ${edge.parent}`);
    expect(violations).toEqual([]);
    expect(tables.at(-1)).toBe('users');
  });

  it('only ever deletes rows selected by the member, its accounts or participants', async () => {
    const { statements } = await purgeOrder();
    for (const sql of statements)
      expect(
        /user_id = \$\d|trading_account_id = ANY\(\$\d\)|season_participant_id = ANY\(\$\d\)|low_user_id = \$\d|email = \$\d|WHERE id = \$\d/.test(
          sql,
        ),
      ).toBe(true);
    // Shared market data and season definitions are never named.
    const shared = [
      'assets',
      'asset_price_snapshots',
      'market_candles',
      'futures_instruments',
      'futures_last_price_snapshots',
      'futures_mark_snapshots',
      'fx_rate_snapshots',
      'seasons',
      'futures_season_prices',
      'badges',
      'limit_order_candle_evidences',
      'session_close_price_evidences',
    ];
    const { tables } = await purgeOrder();
    expect(tables.filter((table) => shared.includes(table))).toEqual([]);
  });

  it('recognizes only the reserved placeholder domain', () => {
    expect(
      isAccountDeletionPlaceholderEmail(
        `ghost-x@${ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN}`,
      ),
    ).toBe(true);
    expect(
      isAccountDeletionPlaceholderEmail(
        `GHOST@${ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN.toUpperCase()}`,
      ),
    ).toBe(true);
    for (const email of [
      'member@example.com',
      `member@x${ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN}`,
      `member@${ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN}.example.com`,
    ])
      expect(isAccountDeletionPlaceholderEmail(email)).toBe(false);
  });
});
