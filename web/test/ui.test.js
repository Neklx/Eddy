const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1, permissions: ['microphone'] });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html'));
  await p.waitForSelector('.welcome');
  await p.screenshot({ path: '/tmp/shots/00-welcome.png' });
  await p.click('text=Try the demo');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: '/tmp/shots/01-mixer.png' });
  await p.click('.tab:has-text("Routing")'); await p.waitForTimeout(800);
  await p.screenshot({ path: '/tmp/shots/02-graph.png' });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
})();
