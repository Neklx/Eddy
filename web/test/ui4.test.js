const { chromium } = require('playwright'); const path = require('path');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('PASS', m); };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const c = await b.newContext({ viewport: { width: 1672, height: 941 } }); const p = await c.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html')); await p.waitForSelector('.welcome'); await p.click('text=Try the demo'); await p.waitForTimeout(1500);
  const q = (f) => p.evaluate(f);
  // source toggle mutes
  await p.click('.mrow:has-text("Demo voice") .sw'); await p.waitForTimeout(200);
  assert(await q(() => __eddy.S.graph.nodes.find((n) => n.type === 'source.voice').mute === true), 'source switch mutes the source');
  await p.click('.mrow:has-text("Demo voice") .sw'); await p.waitForTimeout(200);
  // select effect chip -> inspector shows card selected
  await p.click('.echip >> nth=1'); await p.waitForTimeout(200);
  assert(await q(() => __eddy.S.sel.nodes.size === 1), 'engine chip selects the effect');
  // inspector tabs
  await p.click('.itabs button:has-text("Device")'); await p.waitForTimeout(150);
  assert(await p.locator('.v-mixer .insp .prm').count() > 0, 'device tab shows settings');
  await p.click('.itabs button:has-text("Advanced")'); await p.waitForTimeout(150);
  assert(await p.locator('.v-mixer .insp .swatch').count() > 5, 'advanced tab shows colours');
  await p.click('.itabs button:has-text("Effects")');
  // add a source from the mixer
  await p.click('.mpanel:has-text("Sources") button:has-text("Add")'); await p.click('.menu-i:has-text("Microphone")'); await p.waitForTimeout(300);
  assert(await q(() => __eddy.S.graph.nodes.filter((n) => n.type === 'source.mic').length === 1), 'Add source creates a node');
  assert(await p.locator('.mrow').count() === 4, 'new source appears in the list (' + await p.locator('.mrow').count() + ' rows)');
  // fader drag
  const f = await p.locator('.cs:has-text("Demo voice") .fader').boundingBox();
  await p.mouse.move(f.x + 15, f.y + f.height * 0.3); await p.mouse.down(); await p.mouse.move(f.x + 15, f.y + f.height * 0.7, { steps: 5 }); await p.mouse.up();
  const g = await q(() => __eddy.S.graph.nodes.find((n) => n.type === 'source.voice').params.gain); assert(g < -10, 'fader drags to ' + g);
  // profile switch via dropdown
  await p.selectOption('.prof select', { label: 'Podcast' }); await p.waitForTimeout(800);
  assert(await q(() => __eddy.S.graph.name) === 'Podcast', 'profile dropdown loads Podcast');
  // auto save off then reload keeps old
  await p.click('.asw .sw'); await p.waitForTimeout(100);
  assert(await q(() => __eddy.S.autoSave) === false, 'auto save can be turned off');
  // settings modal
  await p.click('button[aria-label=Settings]'); assert(await p.locator('.modal:has-text("Settings")').count() === 1, 'settings opens'); await p.keyboard.press('Escape');
  console.log(errs.length ? errs.join('\n') : 'no errors'); await b.close();
})();
