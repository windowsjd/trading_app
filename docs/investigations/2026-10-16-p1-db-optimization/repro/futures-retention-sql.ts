// Futures Mark/Last retention batch statements for the P0-A1 measurements.
// `fixed` is the production builder itself; `p0` is the 70f51455 statement,
// derived from it by swapping only the DELETE step back to the CTE join.
import { futuresLastPriceRetentionBatchSql } from '../../../../backend/src/futures/futures-last-price-retention.service';
import { futuresMarkRetentionBatchSql } from '../../../../backend/src/futures/futures-mark-retention.service';

export type Table = 'mark' | 'last';
export type Variant = 'p0' | 'fixed';
export const TABLE = {
  mark: 'futures_mark_snapshots',
  last: 'futures_last_price_snapshots',
} as const;

export function retentionStatement(
  table: Table,
  variant: Variant,
  cutoff: Date,
  limit: number,
  returning = false,
) {
  const sql =
    table === 'mark'
      ? futuresMarkRetentionBatchSql(cutoff, limit)
      : futuresLastPriceRetentionBatchSql(cutoff, limit);
  let text = sql.text;
  if (variant === 'p0') {
    const swapped = text.replace(
      /DELETE FROM (\w+) m\s+WHERE m\.id = ANY \(ARRAY\(SELECT c\.id FROM candidates c\)\)\s+AND/,
      'DELETE FROM $1 m USING candidates c\n        WHERE m.id = c.id AND',
    );
    if (swapped === text) throw new Error('P0 DELETE step not found');
    text = swapped;
  }
  if (returning) text += '\nRETURNING m.id';
  return { text, values: sql.values as unknown[] };
}

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  Plans?: PlanNode[];
};
/** DELETE-step access path, candidate scan and hazards of one plan. */
export function summarizePlan(root: PlanNode, table: Table) {
  const t = TABLE[table];
  let temp = 0;
  let seqOrBitmapOnTable = false;
  let hashOrSortOverTable = false;
  const reads = (n: PlanNode): boolean =>
    n['Relation Name'] === t || (n.Plans ?? []).some(reads);
  const walk = (n: PlanNode) => {
    temp += (n['Temp Read Blocks'] ?? 0) + (n['Temp Written Blocks'] ?? 0);
    if (n['Relation Name'] === t && ['Seq Scan', 'Bitmap Heap Scan'].includes(n['Node Type']))
      seqOrBitmapOnTable = true;
    if (['Hash', 'Sort'].includes(n['Node Type']) && reads(n)) hashOrSortOverTable = true;
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
  const target = (root.Plans ?? []).find((n) => n['Relation Name'] === t);
  const deleteStep = target
    ? `${target['Node Type']}:${(target['Index Name'] ?? '').replace(`${t}_`, '')}`
    : (root.Plans ?? []).map((n) => n['Node Type']).join('+');
  return {
    deleteStep,
    seqOrBitmapOnTable,
    hashOrSortOverTable,
    temp,
    buffers: (root['Shared Hit Blocks'] ?? 0) + (root['Shared Read Blocks'] ?? 0),
    reads: root['Shared Read Blocks'] ?? 0,
  };
}
