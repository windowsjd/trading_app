// Whale tier card backgrounds with a thinner gold rim (2026-11-06).
// Run from frontend/: node scripts/prepare-whale-tier-rim.cjs
//
// The two original Whale PNGs stay byte-identical (manifest.json). This writes
// derived copies whose outer gold rim is drawn at RIM.scale of its measured
// thickness: each pixel of the rim is resampled from the ORIGINAL along the
// rim's own normal (straight edges) or radius (rounded corners), so the bevel
// profile (outer edge line, bright band, inner edge line), the outer outline
// and the corner curves keep their place and shape. A short band of the
// background just inside the rim absorbs the difference; everything else —
// facets, glow, the margin outside the rim — is copied pixel for pixel.
// No colour change, blur, painting or generated content.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');

const ASSETS = path.resolve(__dirname, '../src/assets/home-tier-backgrounds');
const FILES = {
  light: { source: '06_Whale_Light.png', output: '06_Whale_Light_thin-rim.png' },
  dark: { source: '06_Whale_Dark.png', output: '06_Whale_Dark_thin-rim.png' },
};
const RIM = {
  scale: 0.75, // drawn thickness / original thickness ("slightly thinner")
  outerThreshold: 80, // red − blue where the margin turns into the gold rim
  innerThreshold: 0, // red − blue where the rim turns into the blue background
  depthMargin: 1.5, // the compressed depth covers the thickest measured rim + this
  transition: 16, // px of background inside the rim that absorb the difference
  supersample: 4, // per axis, for the compressed rim pixels
};

const redMinusBlue = (png, x, y) => { const i = (y * png.width + x) * 4; return png.data[i] - png.data[i + 2]; };

/** Outer and inner rim crossings along `value(i)`, the pixel i px in from an edge; null when none. */
function crossings(value, limit = 48) {
  let outer = null;
  for (let i = 0; i < limit; i++) {
    const a = value(i), b = value(i + 1);
    if (outer === null) {
      if (a < RIM.outerThreshold && b >= RIM.outerThreshold) outer = i + 0.5 + (RIM.outerThreshold - a) / (b - a);
    } else if (a >= RIM.innerThreshold && b < RIM.innerThreshold) {
      return { outer, inner: i + 0.5 + (a - RIM.innerThreshold) / (a - b) };
    }
  }
  return null;
}

const median = (values) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const round = (value) => Math.round(value * 1e4) / 1e4;

/** Bilinear red − blue at a continuous point (pixel centres at i + 0.5). */
function sampleRedMinusBlue(png, x, y) {
  const rgb = [0, 0, 0];
  bilinear(png, x, y, rgb, 1);
  return rgb[0] - rgb[2];
}

function bilinear(png, x, y, acc, weight) {
  const { width: W, height: H, data } = png;
  const u = Math.min(Math.max(x - 0.5, 0), W - 1), v = Math.min(Math.max(y - 0.5, 0), H - 1);
  const i0 = Math.min(Math.floor(u), W - 2), j0 = Math.min(Math.floor(v), H - 2);
  const fx = u - i0, fy = v - j0;
  const a = (j0 * W + i0) * 4, b = a + 4, c = a + W * 4, d = c + 4;
  for (let ch = 0; ch < 3; ch++)
    acc[ch] += weight * ((data[a + ch] * (1 - fx) + data[b + ch] * fx) * (1 - fy) + (data[c + ch] * (1 - fx) + data[d + ch] * fx) * fy);
}

/**
 * The rim as drawn: the outer outline (a rounded rectangle — inset from each
 * image edge, one radius per corner), the rim thickness along each edge and
 * across each corner, and the depth that the thinning compresses.
 */
function measureRim(png) {
  const { width: W, height: H } = png;
  const along = (length, value) => {
    const found = [];
    for (let s = 70; s < length - 70; s++) { const hit = crossings((i) => value(s, i)); if (hit) found.push(hit); }
    if (found.length < (length - 140) * 0.9) throw new Error('Rim edge not found along most of an edge.');
    return { outer: median(found.map((hit) => hit.outer)), thickness: found.map((hit) => hit.inner - hit.outer) };
  };
  const sides = {
    top: along(W, (x, i) => redMinusBlue(png, x, i)),
    bottom: along(W, (x, i) => redMinusBlue(png, x, H - 1 - i)),
    left: along(H, (y, i) => redMinusBlue(png, i, y)),
    right: along(H, (y, i) => redMinusBlue(png, W - 1 - i, y)),
  };
  const insets = Object.fromEntries(Object.entries(sides).map(([side, edge]) => [side, round(edge.outer)]));
  const corners = {
    topLeft: { sx: 1, sy: 1 }, topRight: { sx: -1, sy: 1 },
    bottomLeft: { sx: 1, sy: -1 }, bottomRight: { sx: -1, sy: -1 },
  };
  const radii = {}, cornerThickness = {};
  for (const [name, { sx, sy }] of Object.entries(corners)) {
    const ix = sx > 0 ? insets.left : insets.right, iy = sy > 0 ? insets.top : insets.bottom;
    // Outline points near this corner, in px from its two edges (both scan directions).
    const points = [];
    for (let k = 0; k < 48; k++) {
      const row = crossings((i) => redMinusBlue(png, sx > 0 ? i : W - 1 - i, sy > 0 ? k : H - 1 - k));
      if (row && row.outer > ix + 0.5) points.push([row.outer, k + 0.5]);
      const column = crossings((i) => redMinusBlue(png, sx > 0 ? k : W - 1 - k, sy > 0 ? i : H - 1 - i));
      if (column && column.outer > iy + 0.5) points.push([k + 0.5, column.outer]);
    }
    // The circle tangent to both edges that fits the outline best (radius to 0.01 px).
    let best = null;
    for (let r = 20; r <= 60; r += 0.01) {
      const cx = ix + r, cy = iy + r;
      let error = 0;
      for (const [x, y] of points) { const e = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r; error += e * e; }
      if (!best || error < best.error) best = { r, error };
    }
    radii[name] = round(best.r);
    // Thickness across the corner, on the diagonal from its centre.
    const cx = ix + best.r, cy = iy + best.r;
    const at = (d) => { // d px inside the fitted outline, on the diagonal
      const rho = best.r - d;
      const x = cx - rho * Math.SQRT1_2, y = cy - rho * Math.SQRT1_2;
      return sampleRedMinusBlue(png, sx > 0 ? x : W - x, sy > 0 ? y : H - y);
    };
    const diagonal = crossings((i) => at(i + 0.5 - 4));
    if (!diagonal) throw new Error(`Rim not found across corner ${name}.`);
    cornerThickness[name] = round(diagonal.inner - diagonal.outer);
  }
  const thickness = Object.fromEntries(Object.entries(sides).map(([side, edge]) => [side, round(median(edge.thickness))]));
  const thickest = Math.max(...Object.values(sides).flatMap((edge) => edge.thickness), ...Object.values(cornerThickness));
  return { insets, radii, thickness, cornerThickness, depth: round(thickest + RIM.depthMargin) };
}

/**
 * Distance `t` of a point from the rim's outer outline (positive inside) and
 * the inward unit normal there: radial within a rounded corner.
 */
function outline(geometry, width, height) {
  const { insets, radii } = geometry;
  const x0 = insets.left, y0 = insets.top, x1 = width - insets.right, y1 = height - insets.bottom;
  const corners = [
    [x0 + radii.topLeft, y0 + radii.topLeft, radii.topLeft, -1, -1],
    [x1 - radii.topRight, y0 + radii.topRight, radii.topRight, 1, -1],
    [x0 + radii.bottomLeft, y1 - radii.bottomLeft, radii.bottomLeft, -1, 1],
    [x1 - radii.bottomRight, y1 - radii.bottomRight, radii.bottomRight, 1, 1],
  ];
  return (x, y) => {
    for (const [cx, cy, r, dx, dy] of corners) {
      if ((x - cx) * dx > 0 && (y - cy) * dy > 0) {
        const len = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        return len > 0 ? { t: r - len, nx: (cx - x) / len, ny: (cy - y) / len } : { t: r, nx: 0, ny: 0 };
      }
    }
    const left = x - x0, right = x1 - x, top = y - y0, bottom = y1 - y;
    const t = Math.min(left, right, top, bottom);
    if (t === left) return { t, nx: 1, ny: 0 };
    if (t === right) return { t, nx: -1, ny: 0 };
    if (t === top) return { t, nx: 0, ny: 1 };
    return { t, nx: 0, ny: -1 };
  };
}

/** The derived image: the rim's depth range [0, depth] drawn in [0, scale × depth]. */
function thinRim(png, geometry) {
  const { width: W, height: H } = png;
  const out = new PNG({ width: W, height: H });
  png.data.copy(out.data);
  const at = outline(geometry, W, H);
  const depth = geometry.depth, near = RIM.scale * depth, far = near + RIM.transition;
  // Radial resampling needs the whole band well inside every corner's circle.
  if (far >= Math.min(...Object.values(geometry.radii)) - 4) throw new Error('The rim band reaches a corner centre.');
  // Output depth t → original depth: compressed rim, then a short stretch back to 1:1.
  const source = (t) => (t <= 0 ? t : t <= near ? t / RIM.scale : t < far ? depth + ((t - near) * (far - depth)) / (far - near) : t);
  const S = RIM.supersample, acc = [0, 0, 0];
  const add = (x, y, weight) => {
    const p = at(x, y), shift = source(p.t) - p.t;
    bilinear(png, x + p.nx * shift, y + p.ny * shift, acc, weight);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const { t } = at(x + 0.5, y + 0.5);
    if (t < -0.5 || t >= far) continue; // copied
    acc[0] = acc[1] = acc[2] = 0;
    if (t > near + 0.5) add(x + 0.5, y + 0.5, 1);
    else for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) add(x + (i + 0.5) / S, y + (j + 0.5) / S, 1 / (S * S));
    const o = (y * W + x) * 4;
    for (let ch = 0; ch < 3; ch++) out.data[o + ch] = Math.min(255, Math.max(0, Math.round(acc[ch])));
  }
  return out;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function prepare() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
  const record = { purpose: 'Whale card art with a thinner outer gold rim (2026-11-06); originals unchanged', rim: RIM };
  for (const [appearance, { source, output }] of Object.entries(FILES)) {
    const bytes = fs.readFileSync(path.join(ASSETS, source));
    if (sha256(bytes) !== manifest[source].sha256) throw new Error(`Original changed: ${source}`);
    const png = PNG.sync.read(bytes);
    const geometry = measureRim(png);
    const derived = thinRim(png, geometry);
    const outputBytes = PNG.sync.write(derived, { colorType: 2 });
    fs.writeFileSync(path.join(ASSETS, output), outputBytes);
    const after = measureRim(PNG.sync.read(outputBytes));
    record[appearance] = { source, sourceSha256: manifest[source].sha256, size: [png.width, png.height], geometry,
      output, outputSha256: sha256(outputBytes), outputThickness: after.thickness, outputCornerThickness: after.cornerThickness };
  }
  fs.writeFileSync(path.join(ASSETS, 'whale-rim.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
}
if (require.main === module) prepare();
module.exports = { FILES, RIM, measureRim, outline, thinRim };
