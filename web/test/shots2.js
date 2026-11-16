const { chromium } = require('playwright'); const path = require('path');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const c = await b.newContext({ viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1, permissions: ['microphone'] });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html')); await p.waitForSelector('.welcome');
  await p.click('text=Use my microphone'); await p.waitForTimeout(2500);
  await p.screenshot({ path: '/tmp/shots/40-mixer.png' });
  for (const [t, f] of [['Routing', '41-graph'], ['Effects', '42-effects'], ['Presets', '43-presets']]) { await p.click('.tab:has-text("' + t + '")'); await p.waitForTimeout(700); await p.screenshot({ path: '/tmp/shots/' + f + '.png' }); }
  console.log(errs.length ? errs.join('\n') : 'no errors'); await b.close();
})();
