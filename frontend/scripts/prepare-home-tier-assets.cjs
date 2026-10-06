// Non-destructive preparation. Usage: NODE_PATH=<browser-tools>/node_modules node
// scripts/prepare-home-tier-assets.cjs <provided-frame-directory> <provided-whale.png>
// pngjs is already available through Expo; Playwright is the existing external test tool.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { chromium } = require('playwright');
const names = {
  bronze: '단일 V형 하단 장식 청동 엠블럼.png', silver: '스모키 젬 실버 랭크 엠블럼.png',
  gold: 'gold-frame-refined.png', platinum: '청록빛 삼중 곡선 엠블럼.png',
  diamond: '빙결빛 다이아몬드 랭크 엠블럼.png', whale: 'whale-diamond-evolution.png',
};
const circles = { bronze: [627, 540, 370], silver: [627, 540, 370], gold: [627, 540, 372], platinum: [627, 540, 373], diamond: [686, 507, 355], whale: [627, 530, 364] };
function bounds(im, threshold = 8) {
  const b = [im.width, im.height, 0, 0];
  for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
    if (im.data[(y * im.width + x) * 4 + 3] <= threshold) continue;
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x + 1); b[3] = Math.max(b[3], y + 1);
  }
  return b;
}
function removeOutsideWhite(im) {
  const count = im.width * im.height, visited = new Uint8Array(count), queue = new Int32Array(count);
  let head = 0, tail = 0;
  const visit = i => {
    if (i < 0 || i >= count || visited[i]) return;
    const c = im.data.subarray(i * 4, i * 4 + 3);
    if (Math.min(...c) < 235 || Math.max(...c) - Math.min(...c) > 20) return;
    visited[i] = 1; queue[tail++] = i;
  };
  for (let x = 0; x < im.width; x++) { visit(x); visit(count - im.width + x); }
  for (let y = 0; y < im.height; y++) { visit(y * im.width); visit((y + 1) * im.width - 1); }
  while (head < tail) {
    const i = queue[head++]; im.data[i * 4 + 3] = 0;
    if (i % im.width) visit(i - 1);
    if (i % im.width < im.width - 1) visit(i + 1);
    visit(i - im.width); visit(i + im.width);
  }
  return tail;
}
(async () => {
  const output = path.resolve(__dirname, '../src/assets/home-tiers');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); const manifest = {};
  try {
    for (const [key, name] of [...Object.entries(names), ['whale-subject', path.basename(process.argv[3])]]) {
      const source = key === 'whale-subject' ? process.argv[3] : path.join(process.argv[2], name);
      const bytes = fs.readFileSync(source), im = PNG.sync.read(bytes);
      const sourceBounds = bounds(im, 0);
      const removed = key === 'whale-subject' ? removeOutsideWhite(im) : 0;
      const b = bounds(im), side = Math.max(b[2] - b[0], b[3] - b[1]) + 24;
      const x = (b[0] + b[2] - side) / 2, y = (b[1] + b[3] - side) / 2;
      const url = 'data:image/png;base64,' + PNG.sync.write(im).toString('base64');
      const result = await page.evaluate(async ({ url, x, y, side }) => {
        const img = new Image(); img.src = url; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, x, y, side, side, 0, 0, 512, 512);
        return canvas.toDataURL('image/png').split(',')[1];
      }, { url, x, y, side });
      const filename = key === 'whale-subject' ? key : `${key}-frame`;
      fs.writeFileSync(path.join(output, `${filename}.png`), Buffer.from(result, 'base64'));
      manifest[key] = { source: name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sourceSize: [im.width, im.height], sourceBounds, visibleBoundsAlphaAbove8: b,
        crop: { x, y, side }, removedOutsideWhitePixels: removed, outputSize: [512, 512],
        ...(circles[key] ? { interior: { x: (circles[key][0] - x) / side, y: (circles[key][1] - y) / side, radius: circles[key][2] / side } } : {}),
      };
    }
    fs.writeFileSync(path.join(output, 'preparation.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(manifest, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
