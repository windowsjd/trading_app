const assert = require('node:assert/strict');

// Observe rendered visual bounds separately from the Pressable's stable target.
async function assertButtonFeedback(page, button, reduced = false) {
  await button.scrollIntoViewIfNeeded();
  // Allow RN Web ScrollView to finish its programmatic scroll before pointer input.
  await page.waitForTimeout(180);
  const snapshot = () => button.evaluate(el => {
    const surface = el.firstElementChild;
    const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    return { target: box(el), surface: box(surface), transform: getComputedStyle(el).transform,
      scale: new DOMMatrix(getComputedStyle(surface).transform).a,
      // Single overlay is after an optional gradient clip, before content.
      opacity: Number(getComputedStyle([...surface.children].find(n => getComputedStyle(n).backgroundColor === 'rgb(0, 0, 0)')).opacity),
      sibling: el.nextElementSibling ? box(el.nextElementSibling) : null,
      text: el.querySelector('[dir="auto"]')?.textContent };
  });
  const idle = await snapshot();
  const [x, y, width, height] = idle.target;
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const held = await snapshot();
  assert.deepEqual(held.target, idle.target, 'hit target never shrinks');
  assert.deepEqual(held.sibling, idle.sibling, 'neighbors never move');
  assert.equal(held.transform, 'none');
  assert.ok(Math.abs(held.scale - (reduced ? 1 : 0.97)) < 0.001, JSON.stringify({ reduced, idle, held }));
  assert.ok(Math.abs(held.surface[2] / idle.surface[2] - (reduced ? 1 : 0.97)) < 0.001);
  assert.equal(held.opacity, 0.1);
  assert.equal(held.text, idle.text);
  // Leave/cancel, then release: the fixture action must not run.
  await page.mouse.move(1, 1); await page.mouse.up();
  await page.waitForTimeout(210);
  const released = await snapshot();
  assert.equal(released.scale, 1); assert.equal(released.opacity, 0);
  assert.deepEqual(released.target, idle.target);
  return { idle, held, released };
}
module.exports = { assertButtonFeedback };
