import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const manifest = require('../../assets/home-tier-backgrounds/manifest.json');
const preparation = require('../../assets/home-tiers/preparation.json');
const names = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Whale'];

it('maps all twelve original background PNGs to the exact tier and appearance', () => {
  const h = interactionHarness();
  const { TIER_BACKGROUNDS } = h.load('src/screens/home/tierBackgrounds.ts');
  assert.equal(Object.keys(manifest).length, 12);
  for (const [index, name] of names.entries()) for (const appearance of ['Light', 'Dark']) {
    const filename = `0${index + 1}_${name}_${appearance}.png`;
    const asset = TIER_BACKGROUNDS[name.toLowerCase()][appearance.toLowerCase()];
    assert.ok(asset.source.uri.endsWith(`/${filename}`));
    const bytes = readFileSync(asset.source.uri);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest[filename].sha256);
    assert.equal(asset.width, bytes.readUInt32BE(16));
    assert.equal(asset.height, bytes.readUInt32BE(20));
  }
});

it('keeps supplied emblems verbatim, preserves the existing slots and scales both axes uniformly', () => {
  const h = interactionHarness();
  const { default: Emblem, EMBLEM_OPTICAL_SCALE } = h.load('src/screens/home/TierEmblem.tsx');
  const slots = [[154.73589511295123, 163.49453068538241], [162.33209595546762, 162.33209595546762],
    [169.92805894511557, 166.06605760545386], [174.57705384268124, 165.25497815205262],
    [200.49745473830384, 163.9103279612411], [179.8842369063985, 160.6552322715766]];
  for (const name of names) {
    const tier = name.toLowerCase();
    for (const size of [132, 160]) {
      const renderer = h.render(React.createElement(Emblem, { tier, size }));
      try {
        const image = renderer.root.findByType('Image');
        const bytes = readFileSync(image.props.source.uri);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), preparation[tier].outputSha256);
        if (tier !== 'whale') assert.equal(preparation[tier].sha256, preparation[tier].outputSha256, 'no raster preparation');
        const slot = flatten(renderer.root.findByProps({ testID: `home-emblem-${tier}` }).props.style);
        const scale = size / 160 * EMBLEM_OPTICAL_SCALE[tier];
        assert.equal(slot.width, slots[names.indexOf(name)][0] * scale);
        assert.equal(slot.height, slots[names.indexOf(name)][1] * scale);
        const style = flatten(image.props.style);
        assert.ok(Math.abs(style.width / style.height - bytes.readUInt32BE(16) / bytes.readUInt32BE(20)) < 1e-10);
        assert.equal(image.props.resizeMode, 'contain');
        assert.equal(image.props.accessible, false);
      } finally { act(() => renderer.unmount()); }
    }
  }
  assert.equal(preparation.diamond.source, 'Diamond_Depth_Legs.png');
  assert.equal(preparation.whale.outputSha256, '5c201dbf09b8feaa8d7aaeb4b86989a7783d7c5f3b4dff7ffe29c7c65684153d');
});
