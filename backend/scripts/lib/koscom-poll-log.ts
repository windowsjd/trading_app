/**
 * Stage-1 KOSCOM poll log (`"event":"koscom_poll"` lines, design v2.1 Q2‴)
 * → the `symbol,received_s,effective_s` CSV that
 * docs/investigations/2026-10-15-koscom-100-stock-collection-design/calc/er_replay.py
 * reads with `--polls`. A failed request keeps every symbol with an empty
 * effective time (A3: a failed poll is not "no new trade"); its received time
 * is the request start.
 */
export type KoscomPollCsvRow = {
  symbol: string;
  receivedSeconds: number;
  effectiveSeconds: number | null;
};

export function parseKoscomPollLine(line: string): KoscomPollCsvRow[] {
  const start = line.indexOf('{"event":"koscom_poll"');
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(start));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const entry = parsed as Record<string, unknown>;
  const received =
    typeof entry.receivedAt === 'string'
      ? Date.parse(entry.receivedAt)
      : typeof entry.requestedAt === 'string'
        ? Date.parse(entry.requestedAt)
        : NaN;
  if (!Number.isFinite(received) || !Array.isArray(entry.quotes)) return [];
  const quotes: unknown[] = entry.quotes;
  const rows: KoscomPollCsvRow[] = [];
  for (const quote of quotes) {
    if (!Array.isArray(quote)) continue;
    const [symbol, effective] = quote as unknown[];
    if (typeof symbol !== 'string') continue;
    rows.push({
      symbol,
      receivedSeconds: received / 1000,
      effectiveSeconds:
        entry.ok === true &&
        typeof effective === 'number' &&
        Number.isFinite(effective)
          ? effective
          : null,
    });
  }
  return rows;
}

export function toKoscomPollCsv(lines: Iterable<string>): string {
  const out = ['symbol,received_s,effective_s'];
  for (const line of lines)
    for (const row of parseKoscomPollLine(line))
      out.push(
        `${row.symbol},${row.receivedSeconds.toFixed(3)},${
          row.effectiveSeconds === null ? '' : row.effectiveSeconds.toFixed(3)
        }`,
      );
  return `${out.join('\n')}\n`;
}
