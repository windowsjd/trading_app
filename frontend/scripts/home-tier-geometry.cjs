// Pixel measurements of the supplied inner rim, not the bounding box of the
// decorative wings. Seeds identify the same highlight on each ORIGINAL image.
// Lower jewels and the whale's overlapping head/tail are omitted from the fit.
const seeds = {
  bronze: [627, 548, 395, 383], silver: [627, 540, 377, 376],
  gold: [627, 540, 378, 376], platinum: [627, 540, 378, 375],
  diamond: [684, 507, 361, 350], whale: [627, 535, 389, 393],
};
function solve(matrix, values) {
  const rows = matrix.map((r, i) => [...r, values[i]]), n = values.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    if (Math.abs(divisor) < 1e-12) throw new Error('Degenerate rim fit');
    for (let j = col; j <= n; j++) rows[col][j] /= divisor;
    for (let row = 0; row < n; row++) if (row !== col) {
      const factor = rows[row][col];
      for (let j = col; j <= n; j++) rows[row][j] -= factor * rows[col][j];
    }
  }
  return rows.map(row => row[n]);
}
function fitEllipse(points, cx, cy, unit) {
  const rows = points.map(([px, py]) => {
    const x = (px - cx) / unit, y = (py - cy) / unit;
    return [x * x, y * y, x, y];
  });
  const indices = [0, 1, 2, 3];
  const [a, b, c, d] = solve(indices.map(i => indices.map(j => rows.reduce((s, r) => s + r[i] * r[j], 0))),
    indices.map(i => rows.reduce((s, r) => s + r[i], 0)));
  const x = -c / (2 * a), y = -d / (2 * b), k = 1 + a * x * x + b * y * y;
  return { center: [cx + x * unit, cy + y * unit], radii: [unit * Math.sqrt(k / a), unit * Math.sqrt(k / b)] };
}
function radialError([x, y], { center: [cx, cy], radii: [rx, ry] }) {
  return (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.sqrt(rx * ry);
}
function measureRim(im, tier, seed = seeds[tier], pixelScale = 1) {
  const [cx, cy, rx, ry] = seed, points = [];
  for (let degrees = 0; degrees < 360; degrees += 2) {
    if (degrees > 60 && degrees < 120) continue;
    if (tier === 'whale' && ((degrees > 180 && degrees < 242) || degrees > 300)) continue;
    const angle = degrees * Math.PI / 180;
    let best = -Infinity, point;
    for (let offset = -7 * pixelScale; offset <= 7 * pixelScale; offset += .25 * pixelScale) {
      const x = Math.round(cx + (rx + offset) * Math.cos(angle));
      const y = Math.round(cy + (ry + offset) * Math.sin(angle));
      if (x < 0 || y < 0 || x >= im.width || y >= im.height) continue;
      const i = (y * im.width + x) * 4;
      const score = tier === 'whale' ? im.data[i] + im.data[i + 1] - im.data[i + 2] * 1.5
        : .2126 * im.data[i] + .7152 * im.data[i + 1] + .0722 * im.data[i + 2];
      if (score > best) { best = score; point = [x, y]; }
    }
    if (point) points.push(point);
  }
  let inliers = points, fit;
  for (let pass = 0; pass < 4; pass++) {
    if (inliers.length < 40) throw new Error(`Insufficient visible rim samples for ${tier}`);
    fit = fitEllipse(inliers, cx, cy, 400 * pixelScale);
    inliers = inliers.filter(point => Math.abs(radialError(point, fit)) < 3 * pixelScale);
  }
  fit = fitEllipse(inliers, cx, cy, 400 * pixelScale);
  const [a, b] = fit.radii;
  const result = { ...fit, diameters: [2 * a, 2 * b], axisRatio: Math.min(a, b) / Math.max(a, b),
    eccentricity: Math.sqrt(1 - Math.min(a, b) ** 2 / Math.max(a, b) ** 2), samples: inliers.length,
    radialRms: Math.sqrt(inliers.reduce((sum, point) => sum + radialError(point, fit) ** 2, 0) / inliers.length) };
  Object.defineProperty(result, 'points', { value: inliers });
  return result;
}
function measurePreparedRim(im, tier, sourceRim, transform) {
  const center = transform(sourceRim.center);
  const luminance = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    let value = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = ((iy + dy) * im.width + ix + dx) * 4;
      const score = tier === 'whale' ? im.data[i] + im.data[i + 1] - im.data[i + 2] * 1.5
        : .2126 * im.data[i] + .7152 * im.data[i + 1] + .0722 * im.data[i + 2];
      value += score * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    }
    return value;
  };
  const points = sourceRim.points.map(point => {
    const [x, y] = transform(point), angle = Math.atan2(y - center[1], x - center[0]);
    let best = -Infinity, measured;
    // Follow the original highlight within one output pixel, rather than
    // accidentally measuring the adjacent concentric line or whale artwork.
    for (let offset = -1; offset <= 1; offset += .125) {
      const candidate = [x + Math.cos(angle) * offset, y + Math.sin(angle) * offset];
      const score = luminance(...candidate);
      if (score > best) { best = score; measured = candidate; }
    }
    return measured;
  });
  const fit = fitEllipse(points, ...center, 200), [a, b] = fit.radii;
  return { ...fit, diameters: [2 * a, 2 * b], axisRatio: Math.min(a, b) / Math.max(a, b),
    eccentricity: Math.sqrt(1 - Math.min(a, b) ** 2 / Math.max(a, b) ** 2), samples: points.length,
    radialRms: Math.sqrt(points.reduce((sum, point) => sum + radialError(point, fit) ** 2, 0) / points.length) };
}
module.exports = { measureRim, measurePreparedRim };
