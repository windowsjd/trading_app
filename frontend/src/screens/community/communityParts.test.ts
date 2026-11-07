import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { getFinancialColors } from '../../theme/financialColors.ts';
import { getHomeTierName } from '../home/tierPresentation.ts';

const require = createRequire(import.meta.url);
const { communityHarness, PALETTES, React } = require('../../../test/communityTestHarness.cjs');

function parts(options: Record<string, unknown> = {}) {
  const h = communityHarness(options);
  const module = h.screen('src/screens/community/CommunityParts.tsx');
  const { tierEmblemWidth } = h.screen('src/screens/home/TierEmblem.tsx');
  return { h, module, tierEmblemWidth };
}

describe('CountButton: the like heart', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const financialPreference of ['red_blue', 'green_red'] as const) {
      it(`${mode} · ${financialPreference}: drawn in both states, filled in the count's color when liked`, async () => {
        const { h, module } = parts({ mode, financialPreference });
        const rows: string[] = [];
        for (const active of [false, true]) {
          await h.mount(React.createElement(module.CountButton, { icon: 'heart', count: 7, active, label: '좋아요', onPress() {}, testID: 'like' }));
          const button = h.node('like');
          const svg = button.findAll((node: any) => node.type === 'Svg')[0];
          const path = svg.findAll((node: any) => node.type === 'Path')[0];
          const expected = active ? getFinancialColors(mode, financialPreference).rise : PALETTES[mode].secondary;
          assert.equal(svg.props.stroke, expected, `stroke, active=${active}`);
          assert.equal(path.props.fill, active ? expected : 'none', `fill, active=${active}`);
          assert.equal(`${button.props.accessibilityState.selected}/${button.props['aria-selected']}/${button.props.accessibilityLabel}`, `${active}/${active}/좋아요 7`);
          const count = button.findAll((node: any) => node.type === 'Text')[0];
          rows.push(`${active}:${h.style(count).color}`);
          await h.close();
        }
        // The count keeps its role colors (resolved by the themed Text): rise when liked.
        assert.deepEqual(rows, ['false:#0f0005', 'true:#0e0003']);
      });
    }
  }

  it('the comment count is drawn the same way and is never "liked"', async (t) => {
    const { h, module } = parts();
    await h.mount(React.createElement(module.CountButton, { icon: 'comment', count: 2, label: '댓글', testID: 'comments' }));
    t.after(h.close);
    const svg = h.node('comments').findAll((node: any) => node.type === 'Svg')[0];
    assert.equal(svg.props.stroke, PALETTES.light.secondary);
  });
});

describe('TierMark: the ranking emblem', () => {
  const TIERS = [['master', 'whale', 'Whale'], ['diamond', 'diamond', 'Diamond'], ['platinum', 'platinum', 'Platinum'],
    ['gold', 'gold', 'Gold'], ['silver', 'silver', 'Silver'], ['bronze', 'bronze', 'Bronze']] as const;

  for (const [apiTier, emblem, name] of TIERS) {
    it(`${apiTier}: the ${emblem} image at the ranking rows' size, then "${name}"`, async (t) => {
      const { h, module, tierEmblemWidth } = parts();
      await h.mount(React.createElement(module.TierMark, { tier: apiTier, name: getHomeTierName(apiTier) }));
      t.after(h.close);
      const box = h.node(`community-tier-emblem-${emblem}`);
      assert.ok(box);
      assert.equal(box.props['aria-hidden'], true, 'decorative: the tier name is the spoken part');
      assert.equal(h.style(box).width, tierEmblemWidth(emblem, module.COMMUNITY_TIER_EMBLEM));
      const image = h.node(`community-tier-emblem-image-${emblem}`);
      assert.match(image.props.source.uri, new RegExp(`/assets/home-tiers/${emblem}\\.png$`));
      assert.equal(h.text(), name);
      // Home's own emblem ids stay unique on Home.
      assert.equal(h.renderer.root.findAll((node: any) => /^home-emblem-|^home-tier-image$/.test(node.props?.testID ?? '')).length, 0);
      assert.equal(h.renderer.root.findAll((node: any) => node.props?.style?.transform).length, 0, 'no diamond mark any more');
    });
  }

  it('no tier, an unknown tier or no name: nothing (never a made-up tier)', async () => {
    for (const [tier, name] of [[null, null], ['legend', 'Legend'], ['gold', null]] as const) {
      const { h, module } = parts();
      await h.mount(React.createElement(module.TierMark, { tier, name }));
      assert.equal(h.renderer.toJSON() === null, true, `${tier}/${name}`);
      await h.close();
    }
  });

  it('is the ranking rows\' emblem size', () => {
    const ranking = readFileSync(resolve('src/screens/ranking/RankingScreen.tsx'), 'utf8');
    const { module } = parts();
    assert.equal(Number(ranking.match(/const ROW_EMBLEM = (\d+);/)?.[1]), module.COMMUNITY_TIER_EMBLEM);
  });
});
