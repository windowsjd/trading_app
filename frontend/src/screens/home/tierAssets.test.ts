import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const manifest = require('../../assets/home-tier-backgrounds/manifest.json');
const whaleRim = require('../../assets/home-tier-backgrounds/whale-rim.json');
const preparation = require('../../assets/home-tiers/preparation.json');
const names = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Whale'];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const backgroundFile = (filename: string) => readFileSync(require.resolve(`../../assets/home-tier-backgrounds/${filename}`));

it('keeps all twelve original background PNGs and maps each tier and appearance to its art', () => {
  const h = interactionHarness();
  const { TIER_BACKGROUNDS } = h.load('src/screens/home/tierBackgrounds.ts');
  assert.equal(Object.keys(manifest).length, 12);
  for (const [index, name] of names.entries()) for (const appearance of ['Light', 'Dark']) {
    const filename = `0${index + 1}_${name}_${appearance}.png`;
    assert.equal(sha256(backgroundFile(filename)), manifest[filename].sha256, `${filename} stays byte-identical`);
    // Whale draws its thinner-rim derivative (whale-rim.json); every other tier its original.
    const derivative = name === 'Whale' ? whaleRim[appearance.toLowerCase()] : null;
    const asset = TIER_BACKGROUNDS[name.toLowerCase()][appearance.toLowerCase()];
    assert.ok(asset.source.uri.endsWith(`/${derivative ? derivative.output : filename}`));
    const bytes = readFileSync(asset.source.uri);
    assert.equal(sha256(bytes), derivative ? derivative.outputSha256 : manifest[filename].sha256);
    if (derivative) assert.equal(derivative.sourceSha256, manifest[filename].sha256);
    assert.equal(asset.width, bytes.readUInt32BE(16));
    assert.equal(asset.height, bytes.readUInt32BE(20));
    assert.deepEqual([asset.width, asset.height], [manifest[filename].width, manifest[filename].height]);
  }
});

it("derives Whale's thinner rim from the untouched originals and changes nothing outside the rim band", () => {
  const { PNG } = require('pngjs');
  const script = require('../../../scripts/prepare-whale-tier-rim.cjs');
  assert.deepEqual(whaleRim.rim, script.RIM);
  for (const appearance of ['light', 'dark'] as const) {
    const entry = whaleRim[appearance];
    assert.deepEqual([entry.source, entry.output], [script.FILES[appearance].source, script.FILES[appearance].output]);
    const original = PNG.sync.read(backgroundFile(entry.source));
    const derived = PNG.sync.read(backgroundFile(entry.output));
    assert.deepEqual([derived.width, derived.height], [original.width, original.height]);
    // The committed pixels are exactly the script's output for the recorded measurement.
    const geometry = script.measureRim(original);
    assert.deepEqual(geometry, entry.geometry);
    assert.equal(script.thinRim(original, geometry).data.equals(derived.data), true, `${appearance} is reproducible`);
    // Thinner by the recorded scale; the outer outline and corner curves stay where they were.
    const after = script.measureRim(derived);
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const ratio = after.thickness[side] / geometry.thickness[side];
      assert.equal(ratio > 0.72 && ratio < 0.82, true, `${appearance} ${side} rim ×${ratio.toFixed(3)}`);
      assert.equal(Math.abs(after.insets[side] - geometry.insets[side]) < 0.15, true, `${appearance} ${side} outline`);
    }
    for (const corner of ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']) {
      const ratio = after.cornerThickness[corner] / geometry.cornerThickness[corner];
      assert.equal(ratio > 0.72 && ratio < 0.84, true, `${appearance} ${corner} rim ×${ratio.toFixed(3)}`);
      assert.equal(Math.abs(after.radii[corner] - geometry.radii[corner]) < 0.25, true, `${appearance} ${corner} curve`);
    }
    // Outside the rim band (the margin and all the artwork) every pixel is the original's.
    const at = script.outline(geometry, original.width, original.height);
    const far = script.RIM.scale * geometry.depth + script.RIM.transition;
    let outside = 0, changedOutside = 0, inner = 0, changedInner = 0;
    for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
      const i = (y * original.width + x) * 4;
      const same = original.data[i] === derived.data[i] && original.data[i + 1] === derived.data[i + 1] && original.data[i + 2] === derived.data[i + 2];
      const { t } = at(x + 0.5, y + 0.5);
      if (t < -0.5 || t >= far) { outside += 1; if (!same) changedOutside += 1; }
      // Independent of the outline model: 45 px in from every edge is past any band.
      if (x >= 45 && y >= 45 && x < original.width - 45 && y < original.height - 45) { inner += 1; if (!same) changedInner += 1; }
    }
    assert.equal(changedOutside, 0, `${appearance}: ${changedOutside} of ${outside} pixels outside the band changed`);
    assert.equal(changedInner, 0, `${appearance}: ${changedInner} of ${inner} inner pixels changed`);
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
