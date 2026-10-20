// Native Yoga defaults, controlled text measurement; NOT an Android device run.
// Like homeTierYoga.cjs, accepts an external diagnostic-only Yoga installation:
// YOGA_LAYOUT_MODULE=/absolute/path/to/yoga-layout/dist/src/index.js node test/native/assetDetailYoga.cjs
// Run from frontend/. No application dependency is added.
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { inlineTradingHarness } = require('../inlineTradingHarness.cjs');
const { interactionHarness, React, act, flatten } = require('../interactionTestHarness.cjs');

(async () => {
  const { default: Yoga } = await import(pathToFileURL(process.env.YOGA_LAYOUT_MODULE || require.resolve('yoga-layout')).href);
  const interaction = interactionHarness('android');
  // Keep the real CTA's label, lock, caption and styles; omit ink/animation only.
  const CTA = interaction.load('src/components/common/CTAButton.tsx', {
    './ActionPressable': { default: 'Pressable', __esModule: true },
  }).default;
  const records = [];
  for (const assetType of ['domestic_stock', 'us_stock', 'crypto']) {
    const h = inlineTradingHarness();
    h.assets.bnb.assetType = assetType;
    h.Screen = h.Detail;
    await h.mount();
    try {
      const footer = h.node('asset-order-actions');
      for (const locked of [false, true]) for (const legacy of [false, true]) {
        const renderers = [];
        try {
          const children = footer.findAllByType('CTAButton').map((button, index) => {
            const renderer = interaction.render(React.createElement(CTA, {
              ...button.props,
              style: { ...button.props.style, ...(legacy ? { flex: 1 } : {}) },
              learningHint: locked && index === 1 ? '퀘스트를 먼저 완료해주세요.' : null,
            }));
            renderers.push(renderer);
            return { type: 'View', props: { style: button.parent.props.style }, children: [renderer.toJSON()] };
          });
          for (const bottomInset of [0, 24, 34, 48]) for (const fontScale of [1, 1.3, 2]) {
            for (const [width, height] of [[320, 450], [384, 752], [430, 850]]) {
              const config = Yoga.Config.create();
              config.setUseWebDefaults(false);
              config.setErrata(Yoga.ERRATA_ALL);
              config.setPointScaleFactor(1);
              const nodes = new Map(), parents = new Map();
              const textNodes = [], touchNodes = new Set();
              function convert(json) {
                const node = Yoga.Node.create(config);
                const style = flatten(json.props.style);
                for (const key of ['flex', 'flexGrow', 'flexShrink', 'minWidth', 'minHeight', 'width', 'height']) {
                  if (typeof style[key] === 'number') node[`set${key[0].toUpperCase()}${key.slice(1)}`](style[key]);
                }
                if (style.maxWidth === '100%') node.setMaxWidthPercent(100);
                if (style.flexDirection === 'row') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
                if (style.alignItems === 'center') node.setAlignItems(Yoga.ALIGN_CENTER);
                if (style.justifyContent === 'center') node.setJustifyContent(Yoga.JUSTIFY_CENTER);
                if (style.gap) node.setGap(Yoga.GUTTER_ALL, style.gap);
                for (const [key, edge] of Object.entries({
                  paddingVertical: Yoga.EDGE_VERTICAL, paddingHorizontal: Yoga.EDGE_HORIZONTAL,
                  paddingTop: Yoga.EDGE_TOP, paddingBottom: Yoga.EDGE_BOTTOM,
                })) if (typeof style[key] === 'number') node.setPadding(edge, style[key]);
                if (style.borderTopWidth) node.setBorder(Yoga.EDGE_TOP, style.borderTopWidth);
                if (style.borderWidth) node.setBorder(Yoga.EDGE_ALL, style.borderWidth);
                if (json.props.testID) nodes.set(json.props.testID, node);
                if (json.type === 'Pressable') touchNodes.add(node);
                if (json.type === 'Text') {
                  textNodes.push(node);
                  // Deterministic glyph widths/line heights, including wrapping;
                  // this does not model Android font shaping or font padding.
                  const text = (json.children ?? []).join('');
                  const intrinsic = text.length * (style.fontSize ?? 14) * fontScale;
                  node.setMeasureFunc((available, mode) => {
                    const width = mode === Yoga.MEASURE_MODE_UNDEFINED ? intrinsic : Math.min(available, intrinsic);
                    return { width, height: (style.lineHeight ?? 21) * fontScale * Math.max(1, Math.ceil(intrinsic / Math.max(1, width))) };
                  });
                } else if (json.type === 'Svg') {
                  node.setWidth(json.props.width);
                  node.setHeight(json.props.height);
                } else for (const child of json.children ?? []) {
                  if (child && typeof child === 'object') {
                    const childNode = convert(child);
                    node.insertChild(childNode, node.getChildCount());
                    parents.set(childNode, node);
                  }
                }
                return node;
              }
              const root = Yoga.Node.create(config);
              root.setWidth(width); root.setHeight(height);
              // The real detail's flex content slot represents the bounded
              // ScrollView viewport. Its scroll content must not size the footer.
              const content = convert({ type: 'View', props: { style: h.node('asset-order-actions').parent.children[0].props.style } });
              root.insertChild(content, 0);
              parents.set(content, root);
              const bar = convert({ type: 'View', props: { style: { ...footer.props.style, paddingBottom: 8 + bottomInset } }, children });
              root.insertChild(bar, 1);
              parents.set(bar, root);
              try {
                root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
                const topInRoot = (node) => node.getComputedTop() + (parents.has(node) ? topInRoot(parents.get(node)) : 0);
                const actionNodes = [...nodes].filter(([id]) => id.startsWith('asset-detail-open-'));
                assert.ok(actionNodes.length >= 2, 'measure both actual CTA touch hosts');
                const actionBottom = Math.max(...actionNodes.map(([, node]) => topInRoot(node) + node.getComputedHeight()));
                const gap = height - bottomInset - actionBottom;
                if (!legacy) {
                  assert.ok(gap >= 7 && gap <= 9, `safe gap: ${JSON.stringify({ assetType, locked, bottomInset, fontScale, width, gap })}`);
                  for (const [, node] of actionNodes) {
                    let slot = node;
                    while (parents.get(slot) !== bar) slot = parents.get(slot);
                    assert.ok(topInRoot(node) + node.getComputedHeight() <= topInRoot(slot) + slot.getComputedHeight() + 1, 'touch host stays inside its measured slot');
                  }
                  assert.ok(content.getComputedHeight() > 0, 'body keeps the remaining viewport');
                  assert.equal(Math.round(topInRoot(bar)), Math.round(content.getComputedHeight()), 'scroll viewport ends at the footer');
                  for (const text of textNodes) {
                    let touch = parents.get(text);
                    while (touch && !touchNodes.has(touch)) touch = parents.get(touch);
                    assert.equal(touch !== undefined, true, 'labels have a touch host');
                    assert.ok(topInRoot(text) >= topInRoot(touch) - 1, 'text starts inside its button');
                    assert.ok(topInRoot(text) + text.getComputedHeight() <= topInRoot(touch) + touch.getComputedHeight() + 1, 'large text ends inside its button');
                  }
                } else {
                  assert.ok(gap < 0, 'restoring the nested flex reproduces overlap despite the correct inset');
                }
                records.push({ assetType, locked, legacy, bottomInset, fontScale, width, height,
                  footer: bar.getComputedLayout(), actionBottom, navigationTop: height - bottomInset, gap });
              } finally { root.freeRecursive(); config.free(); }
            }
          }
        } finally { for (const renderer of renderers) act(() => renderer.unmount()); }
      }
    } finally { await h.close(); }
  }
  console.log(JSON.stringify({ nativeDevice: false, engine: 'yoga-layout 3.2.1',
    textMeasurement: 'controlled glyph widths and line heights; actual screen/QuestTarget/CTA styles',
    cases: records.length, records }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
