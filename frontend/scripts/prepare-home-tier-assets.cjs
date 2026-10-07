// Non-destructive preparation of the six COMPLETE supplied emblems.
// Run: node scripts/prepare-home-tier-assets.cjs <provided-image-directory>
// Preserve originals; trim padding, apply the user-approved minimal rim ratio
// correction, then downsample. No painting, compositing or background removal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { measureRim, measurePreparedRim } = require('./home-tier-geometry.cjs');
const names = {
  bronze: '청동 원형 엠블럼의 개미 실루엣.png',
  silver: '실버 개미 엠블럼.png',
  gold: '매끈해진 황금 개미 엠블럼.png',
  platinum: '플래티넘 날개개미 엠블럼.png',
  diamond: '장엄한 다이아몬드 여왕개미 엠블럼.png',
  whale: 'whale_emblem_stately_sapphire.png',
};
function measure(im, threshold = 0) {
  const bounds = [im.width, im.height, 0, 0];
  let area = 0, xMass = 0, yMass = 0, transparentPixels = 0;
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    const alpha = im.data[(y * im.width + x) * 4 + 3];
    if (!alpha) transparentPixels++;
    if (alpha <= threshold) continue;
    const mass = alpha / 255;
    area += mass; xMass += (x + .5) * mass; yMass += (y + .5) * mass;
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x + 1); bounds[3] = Math.max(bounds[3], y + 1);
  }
  return { bounds, alphaArea: area, centroid: [xMass / area, yMass / area], transparentPixels };
}
function prepare(directory) {
  const output = path.resolve(__dirname, '../src/assets/home-tiers');
  fs.mkdirSync(output, { recursive: true });
  const manifest = {};
  for (const [index, [tier, filename]] of Object.entries(names).entries()) {
    const source = path.join(directory, filename), bytes = fs.readFileSync(source);
    const im = PNG.sync.read(bytes), sourceMetrics = measure(im), visible = measure(im, 8);
    const [left, top, right, bottom] = visible.bounds;
    // Ignore nearly transparent stray pixels when finding the visible silhouette,
    // then retain a 12px margin for the soft rim. Originals remain untouched.
    const crop = { x: left - 12, y: top - 12,
      width: Math.ceil((right - left + 24) / 2) * 2,
      height: Math.ceil((bottom - top + 24) / 2) * 2 };
    const sourceRim = measureRim(im, tier);
    const [rx, ry] = sourceRim.radii;
    // The user explicitly permitted this small correction. Split it between
    // axes to minimize displacement and preserve area: sx * sy = 1.
    const correction = { x: Math.sqrt(ry / rx), y: Math.sqrt(rx / ry) };
    let result, preparedRim, correctionPasses;
    // Correct small subpixel sampling bias from the actual prepared rim, always
    // re-rendering from the original (never resampling a previous derivative).
    for (correctionPasses = 1; correctionPasses <= 8; correctionPasses++) {
      const scaleX = .5 * correction.x, scaleY = .5 * correction.y;
      result = new PNG({ width: Math.ceil(crop.width * scaleX), height: Math.ceil(crop.height * scaleY) });
      const offsetX = (result.width - crop.width * scaleX) / 2;
      const offsetY = (result.height - crop.height * scaleY) / 2;
      for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
        const rgba = [0, 0, 0, 0];
        // Four area samples, each bilinear in premultiplied alpha: no dark halo.
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const sx = crop.x + (x + (dx + .5) / 2 - offsetX) / scaleX - .5;
          const sy = crop.y + (y + (dy + .5) / 2 - offsetY) / scaleY - .5;
          const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
          for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
            const px = ix + bx, py = iy + by;
            if (px < 0 || py < 0 || px >= im.width || py >= im.height) continue;
            const i = (py * im.width + px) * 4;
            const a = im.data[i + 3] * (bx ? fx : 1 - fx) * (by ? fy : 1 - fy);
            for (let c = 0; c < 3; c++) rgba[c] += im.data[i + c] * a;
            rgba[3] += a;
          }
        }
        const dest = (y * result.width + x) * 4;
        for (let c = 0; c < 3; c++) result.data[dest + c] = rgba[3] ? Math.round(rgba[c] / rgba[3]) : 0;
        result.data[dest + 3] = Math.round(rgba[3] / 4);
      }
      preparedRim = measurePreparedRim(result, tier, sourceRim, ([x, y]) => [
        (x + .5 - crop.x) * scaleX + offsetX - .5,
        (y + .5 - crop.y) * scaleY + offsetY - .5,
      ]);

      if (Math.abs(preparedRim.diameters[0] - preparedRim.diameters[1]) < .3 || correctionPasses === 8) break;
      const feedback = (preparedRim.radii[1] / preparedRim.radii[0]) ** .25;
      correction.x *= feedback; correction.y /= feedback;
    }
    const outputBytes = PNG.sync.write(result), prepared = measure(result, 8);
    // Perceived size follows opaque silhouette AREA, not the longest ornament.
    // Equivalent linear size increases 1% per tier (area rises ~2%). Bronze's
    // 128px area-equivalent size retains the previous 160px frame's presence.
    const linearSize = 128 * (1 + index * .01), scale = linearSize / Math.sqrt(prepared.alphaArea);
    if (Math.max(Math.abs(correction.x - 1), Math.abs(correction.y - 1)) > .02) {
      throw new Error(`Rim correction exceeds the approved small adjustment: ${tier}`);
    }
    if (Math.abs(preparedRim.diameters[0] - preparedRim.diameters[1]) * scale >= .1) {
      throw new Error(`Prepared rim differs by >= 0.1 display px: ${tier}`);
    }
    const entry = { source: filename, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sourceSize: [im.width, im.height], sourceAspectRatio: im.width / im.height,
      sourceMetrics, visibleAlphaAbove8: visible, crop, sourceRim, correction, correctionPasses, downsampleScale: .5, preparedRim,
      outputSize: [result.width, result.height], outputMetrics: prepared,
      outputSha256: crypto.createHash('sha256').update(outputBytes).digest('hex'),
      displayAt160: { width: result.width * scale, height: result.height * scale,
        visibleArea: linearSize ** 2, equivalentSize: linearSize,
        rimDiameters: preparedRim.diameters.map(diameter => diameter * scale) } };
    fs.writeFileSync(path.join(output, `${tier}.png`), outputBytes);
    manifest[tier] = entry;
    if (!bytes.equals(fs.readFileSync(source))) throw new Error(`Source changed: ${filename}`);
  }
  fs.writeFileSync(path.join(output, 'preparation.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(Object.fromEntries(Object.entries(manifest).map(([t, m]) => [t, m.displayAt160])));
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Supply the directory containing the six original emblems.');
  prepare(process.argv[2]);
}
module.exports = { measure, names };
