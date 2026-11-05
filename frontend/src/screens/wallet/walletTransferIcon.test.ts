import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// 이체하기 icon (2026-11-05): the arrowhead's tips sat exactly on the wallet outline's open ends
// (18,9.5)/(18,15.5), so with stroke 2 the arrow and the wallet merged into one shape.
const source = readFileSync(join(process.cwd(), 'src/screens/wallet/WalletScreen.tsx'), 'utf8');
const transfer = source.slice(source.indexOf("testID: 'wallet-transfer'"));
const path = /iconPath: '([^']+)'/u.exec(transfer)?.[1] ?? '';
const STROKE = 2;

test('the transfer icon keeps a clear gap between the arrowhead and the wallet outline', () => {
  const [wallet, shaft, head] = path.split(' M').map((part, index) => (index ? 'M' + part : part));
  assert.equal(path.split(' M').length, 3, 'wallet, shaft, arrowhead');
  // The wallet's right side is the open edge the arrow leaves through: its x and its two ends.
  const edgeX = Number(/^M([\d.]+) /u.exec(wallet)?.[1]);
  const top = Number(/^M[\d.]+ ([\d.]+)/u.exec(wallet)?.[1]);
  const headStart = /^M([\d.]+) ([\d.]+)l([\d.]+) ([\d.]+)-([\d.]+) ([\d.]+)$/u.exec(head);
  assert.ok(headStart, head);
  const [tipX, tipY] = [Number(headStart[1]), Number(headStart[2])];
  const pointX = tipX + Number(headStart[3]);
  // Clear space between the strokes (each stroke reaches STROKE / 2 beyond its line).
  assert.equal(tipX - edgeX - STROKE >= 2, true, `gap ${tipX - edgeX - STROKE}`);
  assert.equal(tipY, top, 'the tips line up with the open edge ends, beside them rather than on them');
  // The shaft passes through the opening without touching the edge ends, and ends at the point.
  const shaftMatch = /^M([\d.]+) ([\d.]+)h([\d.]+)$/u.exec(shaft);
  assert.ok(shaftMatch, shaft);
  const [shaftY, shaftEnd] = [Number(shaftMatch[2]), Number(shaftMatch[1]) + Number(shaftMatch[3])];
  assert.equal(shaftY - top - STROKE >= 1, true, 'clear of the edge ends above and below');
  assert.equal(shaftEnd, pointX);
  // The point (and its stroke) stays inside the 24×24 box.
  assert.equal(pointX + STROKE / 2 <= 24, true);
});
