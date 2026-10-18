import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import preparation from '../../assets/home-tiers/preparation.json' with { type: 'json' };
import { fitHeroTotal, heroTotalWidth, HERO_ASIDE_GAP, HERO_TOTAL_FONT_SIZE, HERO_TOTAL_MIN_FONT_SIZE, HERO_TOTAL_SHRINK_STEP } from './heroTotalFit.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

// Emblem columns as Home sizes them (TierEmblem: prepared silhouette × size/160 × optical scale).
const OPTICAL = { bronze: 1, silver: 1.005, gold: 1.01, platinum: 1.015, diamond: 0.985, whale: 1.065 } as const;
const emblemWidth = (tier: keyof typeof OPTICAL, size: number) => preparation[tier].displayAt160.width * size / 160 * OPTICAL[tier];
// Home's emblem size rule (HomeAccountContext homeTierBadgeSize) and content width (16 dp gutters).
const badgeSize = (width: number, fontScale: number) => width < 360 || fontScale > 1.3 ? 100 : width < 400 ? 132 : 140;
const row = (width: number) => width - 32;
// A conservative model of the bold tabular total at 36: digits 21, commas 10, 원 36 (dp).
const naturalAt36 = (text: string, fontScale: number) =>
  [...text].reduce((sum, c) => sum + (/\d/.test(c) ? 21 : c === ',' ? 10 : 36), 0) * fontScale;
const totals = ['0원', '9,999,999원', '10,000,000원', '123,456,789원', '1,234,567,890원'];
const glyphs = (total: string) => Array.from(total).length;

it('until every width is measured the intended layout stays: beside the emblem, at the base size', () => {
  for (const input of [{ row: 0, aside: 160, natural: 200 }, { row: 358, aside: 0, natural: 200 }, { row: 358, aside: 160, natural: 0 },
    { row: Number.NaN, aside: 160, natural: 200 }]) {
    assert.deepEqual(fitHeroTotal(input), { beside: true, fontSize: HERO_TOTAL_FONT_SIZE }, JSON.stringify(input));
  }
});

it('a total that fits keeps the base size; a longer one shrinks to its column, never past it', () => {
  assert.deepEqual(fitHeroTotal({ row: 358, aside: 140, natural: 150 }), { beside: true, fontSize: 36 });
  const column = 358 - HERO_ASIDE_GAP - 163;
  for (const natural of [190, 240, 300, 340]) {
    const { beside, fontSize } = fitHeroTotal({ row: 358, aside: 163, natural });
    assert.equal(beside, true, String(natural));
    assert.equal(fontSize < 36 && fontSize >= HERO_TOTAL_MIN_FONT_SIZE, true, String(natural));
    assert.equal(natural * fontSize / 36 <= column, true, `${natural} at ${fontSize} fits ${column}`);
    assert.equal(fontSize * 2 % 1, 0, 'half-point steps');
  }
  // Longer never draws larger.
  const sizes = [190, 220, 260, 300].map((natural) => fitHeroTotal({ row: 358, aside: 163, natural }).fontSize);
  assert.deepEqual([...sizes].sort((a, b) => b - a), sizes);
});

it('at the default text size every tier stays beside every realistic total on 320–430 dp phones', () => {
  for (const width of [320, 360, 390, 430]) {
    for (const tier of Object.keys(OPTICAL) as Array<keyof typeof OPTICAL>) {
      const aside = emblemWidth(tier, badgeSize(width, 1));
      for (const total of totals) {
        const fit = fitHeroTotal({ row: row(width), aside, natural: naturalAt36(total, 1), glyphs: glyphs(total) });
        const where = `${width} ${tier} ${total}`;
        assert.equal(fit.beside, true, where);
        assert.equal(naturalAt36(total, 1) * fit.fontSize / 36 <= row(width) - HERO_ASIDE_GAP - aside, true, where);
      }
    }
  }
});

it('the emblem column and the total column do not change with the amount', () => {
  // Same phone and tier: only the type size follows the digits; beside never flips.
  const aside = emblemWidth('diamond', 132);
  const layouts = totals.map((total) => fitHeroTotal({ row: row(360), aside, natural: naturalAt36(total, 1), glyphs: glyphs(total) }));
  assert.deepEqual(new Set(layouts.map((layout) => layout.beside)), new Set([true]));
  // 360 dp beside Diamond's 163 dp column (the narrowest total column on a 360+ phone);
  // the room kept per glyph grows with the digits.
  assert.deepEqual(layouts.map((layout) => layout.fontSize), [36, 25.5, 23, 21, 18.5]);
});

it('very large text moves the emblem below rather than shrinking the total under the label size', () => {
  const natural = naturalAt36('10,000,000원', 2);
  for (const width of [320, 360, 390]) {
    const fit = fitHeroTotal({ row: row(width), aside: emblemWidth('diamond', badgeSize(width, 2)), natural, glyphs: 11 });
    assert.equal(fit.beside, false, String(width));
    // The whole row, still never smaller than the label: it wraps (not truncates) only past that.
    assert.equal(fit.fontSize >= HERO_TOTAL_MIN_FONT_SIZE && natural * fit.fontSize / 36 <= row(width), true, String(width));
  }
  // A 430 dp phone still has a column wide enough at text ×2.
  const wide = fitHeroTotal({ row: row(430), aside: emblemWidth('diamond', badgeSize(430, 2)), natural, glyphs: 11 });
  assert.equal(wide.beside && wide.fontSize >= HERO_TOTAL_MIN_FONT_SIZE, true);
  assert.deepEqual(fitHeroTotal({ row: 288, aside: 120, natural: 2000 }), { beside: false, fontSize: HERO_TOTAL_MIN_FONT_SIZE });
});

it('keeps room for each glyph, and a drawn line that still breaks steps down by half a point', () => {
  // Measured on RN-Web: 232 dp at 36 became 220 at 33.5 (not 216): the estimate keeps 0.5 dp per glyph.
  const plain = fitHeroTotal({ row: 358, aside: 128, natural: 232 });
  const allowed = fitHeroTotal({ row: 358, aside: 128, natural: 232, glyphs: 11 });
  assert.equal(allowed.fontSize < plain.fontSize, true);
  assert.equal(220 * allowed.fontSize / 33.5 <= 358 - HERO_ASIDE_GAP - 128, true, 'the measured overshoot fits');
  // Backstop steps: half a point each, beside while the minimum holds, then below the total.
  const steps = [0, 1, 2].map((shrinkSteps) => fitHeroTotal({ row: 358, aside: 128, natural: 232, glyphs: 11, shrinkSteps }).fontSize);
  assert.deepEqual(steps, [allowed.fontSize, allowed.fontSize - HERO_TOTAL_SHRINK_STEP, allowed.fontSize - 2 * HERO_TOTAL_SHRINK_STEP]);
  const atMinimum = fitHeroTotal({ row: 358, aside: 128, natural: 400, glyphs: 11 });
  assert.deepEqual([atMinimum.beside, atMinimum.fontSize], [true, 18.5]);
  const pastMinimum = fitHeroTotal({ row: 358, aside: 128, natural: 400, glyphs: 11, shrinkSteps: 2 });
  assert.equal(pastMinimum.beside, false, 'past the minimum beside the emblem, the emblem moves below');
  assert.equal(pastMinimum.fontSize >= HERO_TOTAL_MIN_FONT_SIZE, true);
  assert.equal(fitHeroTotal({ row: 288, aside: null, natural: 2000, glyphs: 30, shrinkSteps: 9 }).fontSize, HERO_TOTAL_MIN_FONT_SIZE);
});

it('without an emblem (general, beginner) the total fits the whole row', () => {
  assert.deepEqual(fitHeroTotal({ row: 288, aside: null, natural: 200 }), { beside: true, fontSize: 36 });
  const { fontSize } = fitHeroTotal({ row: 288, aside: null, natural: 400 });
  assert.equal(fontSize < 36 && 400 * fontSize / 36 <= 288, true);
});

it('the hero keeps the emblem beside a long total and sizes the total from the measured widths', (t) => {
  const h = interactionHarness();
  const Hero = h.load('src/screens/home/HomeAssetHero.tsx').default;
  const summary = { totalAssetKrw: '1234567890', returnRate: '12.5', unrealizedPnlKrw: '0' };
  const element = (props = {}) => React.createElement(Hero, { summary, aside: React.createElement('Emblem'), ...props });
  const renderer = h.render(element());
  t.after(() => act(() => renderer.unmount()));
  const host = (id: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  const layout = (node: any, width: number, height = 46) => act(() => node.props.onLayout({ nativeEvent: { layout: { width, height, x: 0, y: 0 } } }));
  const measurer = () => renderer.root.findAll((node: any) => node.type === 'Text' && node.props['aria-hidden'] && node.props.onLayout)[0];
  // The measurer holds the same text, hidden from screen readers and inside a zero-size clip.
  assert.deepEqual([measurer().props.children, host('home-total-asset').props.children], ['1,234,567,890원', '1,234,567,890원']);
  assert.equal(measurer().props.accessibilityElementsHidden, true);
  layout(host('home-summary-card'), 358); layout(host('home-hero-aside'), 163); layout(measurer(), 280);
  const total = flatten(host('home-total-asset').props.style);
  assert.equal(total.fontSize, fitHeroTotal({ row: 358, aside: 163, natural: 280, glyphs: 14 }).fontSize);
  assert.equal(total.fontSize < 36 && total.fontSize >= HERO_TOTAL_MIN_FONT_SIZE, true);
  // The line height never moves with the size; nothing truncates the number.
  assert.deepEqual([total.lineHeight, host('home-total-asset').props.numberOfLines], [46, undefined]);
  // Beside: the emblem column is the summary row's own child, not inside the performance lines.
  const asideParent = host('home-hero-aside').parent;
  assert.equal(asideParent === host('home-summary-card'), true);
  // Backstop: the drawn total still broke (two 46 dp lines) → half a point smaller; one line → it stays.
  layout(host('home-total-asset'), 183, 92);
  assert.equal(flatten(host('home-total-asset').props.style).fontSize, total.fontSize - 0.5);
  layout(host('home-total-asset'), 183, 46);
  assert.equal(flatten(host('home-total-asset').props.style).fontSize, total.fontSize - 0.5);
  // A short total returns to the base size; the emblem does not move.
  act(() => renderer.update(element({ summary: { ...summary, totalAssetKrw: '1000' } })));
  layout(measurer(), 90);
  assert.equal(flatten(host('home-total-asset').props.style).fontSize, 36);
  assert.equal(host('home-hero-aside').parent === host('home-summary-card'), true);
  // Very large text: the emblem moves below, beside the performance lines.
  layout(measurer(), 900);
  assert.equal(host('home-hero-aside').parent === host('home-summary-card'), false);
  assert.equal(flatten(host('home-total-asset').props.style).fontSize >= HERO_TOTAL_MIN_FONT_SIZE, true);
});

it('an amount not measured yet takes the last measured width scaled by its advances', () => {
  // The same text is the measurement itself; nothing measured stays unmeasured.
  assert.equal(heroTotalWidth({ width: 203, text: '9,999,999원' }, '9,999,999원'), 203);
  assert.equal(heroTotalWidth({ width: 0, text: '' }, '10,000,000원'), 0);
  // One digit more is one digit's advance more; tabular digits keep the same width.
  for (const [from, to] of [['9,999,999원', '10,000,000원'], ['99,999,999원', '100,000,000원'], ['123,456,789원', '1,234,567,890원'],
    ['10,000,000원', '9,999,999원'], ['9,648,192원', '9,876,543원']]) {
    const estimate = heroTotalWidth({ width: naturalAt36(from, 1), text: from }, to);
    assert.equal(Math.abs(estimate - naturalAt36(to, 1)) < 0.02 * naturalAt36(to, 1), true, `${from} → ${to}`);
  }
});

it('an updated amount is drawn at a fitting size at once, before its own width is measured', (t) => {
  const h = interactionHarness();
  const Hero = h.load('src/screens/home/HomeAssetHero.tsx').default;
  const element = (totalAssetKrw: string) => React.createElement(Hero, {
    summary: { totalAssetKrw, returnRate: '0.5', unrealizedPnlKrw: '0' }, aside: React.createElement('Emblem') });
  const renderer = h.render(element('9999999'));
  t.after(() => act(() => renderer.unmount()));
  const host = (id: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  const layout = (node: any, width: number, height = 46) => act(() => node.props.onLayout({ nativeEvent: { layout: { width, height, x: 0, y: 0 } } }));
  const measurer = () => renderer.root.findAll((node: any) => node.type === 'Text' && node.props['aria-hidden'] && node.props.onLayout)[0];
  const size = () => flatten(host('home-total-asset').props.style).fontSize;
  layout(host('home-summary-card'), 358); layout(host('home-hero-aside'), 163); layout(measurer(), naturalAt36('9,999,999원', 1));
  const before = size();
  // 10,000,000원 arrives; the measurer has not reported its width yet.
  act(() => renderer.update(element('10000000')));
  const column = 358 - HERO_ASIDE_GAP - 163;
  const drawn = naturalAt36('10,000,000원', 1) * size() / HERO_TOTAL_FONT_SIZE;
  assert.equal(size() < before, true, 'already smaller for the extra digit');
  assert.equal(drawn <= column, true, `fits its column at once (${drawn} ≤ ${column})`);
  assert.equal(host('home-hero-aside').parent === host('home-summary-card'), true, 'the emblem stays beside');
  // Its own measurement then confirms the size (the estimate was the measured advance here).
  layout(measurer(), naturalAt36('10,000,000원', 1));
  assert.equal(size(), fitHeroTotal({ row: 358, aside: 163, natural: naturalAt36('10,000,000원', 1), glyphs: 11 }).fontSize);
});
