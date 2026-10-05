const assert = require('node:assert/strict');
// Product hierarchy contract, deliberately independent of the implementation palette.
const palettes = {
  light: { screen: 'rgb(252, 252, 253)', surface: 'rgb(255, 255, 255)', raised: 'rgb(247, 248, 250)', text: 'rgb(32, 42, 53)', secondary: 'rgb(83, 97, 112)' },
  dark: { screen: 'rgb(21, 23, 28)', surface: 'rgb(28, 29, 33)', raised: 'rgb(41, 42, 47)', text: 'rgb(242, 245, 247)', secondary: 'rgb(197, 208, 218)' },
};
async function background(locator, mode, role) {
  // Find the painted background behind text/transparent list wrappers.
  const actual = await locator.evaluate((node) => {
    for (let el = node; el; el = el.parentElement) {
      const color = getComputedStyle(el).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
    }
    return null;
  });
  assert.equal(actual, palettes[mode][role], `${mode} ${role}: ${await locator.getAttribute('data-testid')}`);
}
async function canvas(page, mode) {
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), palettes[mode].screen);
  const unresolved = await page.evaluate(() => [...document.querySelectorAll('#root *')].flatMap((el) => {
    const css = getComputedStyle(el);
    return [css.color, css.backgroundColor, css.borderColor, css.fill, css.stroke].filter((value) => /^rgb\((14|15), 0,/.test(value));
  }));
  assert.deepEqual(unresolved, [], 'explicit theme tokens must never leak to browser CSS/SVG');
}
module.exports = { palettes, background, canvas };
