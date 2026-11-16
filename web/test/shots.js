const { chromium } = require('playwright'); const path = require('path');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const c = await b.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
  const p = await c.newPage();
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html')); await p.waitForSelector('.welcome'); await p.click('text=Try the demo'); await p.waitForTimeout(1500);
  await p.click('.tab:has-text("Routing")'); await p.waitForTimeout(500);
  await p.evaluate(() => { __eddy.S.view.zoom = 0.92; __eddy.S.view.x = 20; __eddy.S.view.y = 120; __eddy.UI.editor.applyView(); });
  await p.click('.node:has-text("Compressor") .nh'); await p.waitForTimeout(900);
  await p.screenshot({ path: '/tmp/shots/30-demo-graph.png' });
  await p.click('.tab:has-text("Mixer")'); await p.waitForTimeout(700);
  await p.screenshot({ path: '/tmp/shots/31-demo-mixer.png' });
  await b.close();
})();
