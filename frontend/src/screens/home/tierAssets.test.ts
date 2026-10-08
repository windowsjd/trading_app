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

it('keeps all six complete emblems byte-identical and scales both axes uniformly', () => {
  const h = interactionHarness();
  const { default: Emblem } = h.load('src/screens/home/TierEmblem.tsx');
  for (const name of names) {
    const tier = name.toLowerCase();
    for (const size of [132, 160]) {
      const renderer = h.render(React.createElement(Emblem, { tier, size }));
      try {
        const image = renderer.root.findByType('Image');
        const bytes = readFileSync(image.props.source.uri);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), preparation[tier].outputSha256);
        const style = flatten(image.props.style);
        assert.ok(Math.abs(style.width / style.height - bytes.readUInt32BE(16) / bytes.readUInt32BE(20)) < 1e-10);
        assert.equal(image.props.resizeMode, 'contain');
        assert.equal(image.props.accessible, false);
      } finally { act(() => renderer.unmount()); }
    }
  }
});
