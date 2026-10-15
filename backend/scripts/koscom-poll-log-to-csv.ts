/**
 * Usage: tsx scripts/koscom-poll-log-to-csv.ts < app.log > polls.csv
 * Reads application log lines from stdin; no network, database or Redis.
 */
import { createInterface } from 'node:readline';
import { toKoscomPollCsv } from './lib/koscom-poll-log';

async function main(): Promise<void> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin }))
    lines.push(line);
  process.stdout.write(toKoscomPollCsv(lines));
}

void main();
