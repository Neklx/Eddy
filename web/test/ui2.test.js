const { chromium } = require('playwright');
const path = require('path');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('PASS', m); };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await b.newContext({ viewport: { width: 1600, height: 960 }, permissions: ['microphone'] });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html'));
  await p.waitForSelector('.welcome');
  await p.click('text=Use my microphone'); await p.waitForTimeout(2500);
  const st = () => p.evaluate(() => ({ n: __eddy.S.graph.nodes.length, e: __eddy.S.graph.edges.length, name: __eddy.S.graph.name }));
  let s = await st(); assert(s.name === 'Streaming' && s.n === 12, 'streaming preset loaded ' + JSON.stringify(s));
  // mic is live via fake device
  const mic = await p.evaluate(async () => { const n = __eddy.S.graph.nodes.find((x) => x.type === 'source.mic'); let peak = 0; for (let i = 0; i < 150; i++) { peak = Math.max(peak, __eddy.S.engine.level(n.id).peak); await new Promise((r) => setTimeout(r, 33)); } return { peak, st: __eddy.S.engine.status(n.id) }; });
  console.log('mic', JSON.stringify(mic)); assert(mic.peak > 0.001, 'mic meter shows signal from fake device');
  await p.screenshot({ path: '/tmp/shots/10-streaming-mixer.png' });
  // select a strip -> inspector
  await p.click('.cs:has-text("Microphone") .csh'); await p.waitForTimeout(300);
  await p.screenshot({ path: '/tmp/shots/11-mixer-mic-selected.png' });
  // graph
  await p.click('.tab:has-text("Routing")'); await p.waitForTimeout(600);
  await p.evaluate(() => { __eddy.S.view.zoom = 0.85; __eddy.UI.editor.focusNode(__eddy.S.graph.nodes.find((n) => n.type === 'fx.eq').id); __eddy.UI.editor.applyView(); });
  await p.click('.node:has-text("Equalizer") .nh'); await p.waitForTimeout(500);
  await p.screenshot({ path: '/tmp/shots/12-graph-eq.png' });
  // add a node through search popup (double-click empty canvas)
  await p.dblclick('.gcanvas', { position: { x: 300, y: 650 } }); await p.waitForSelector('.pop input');
  await p.fill('.pop input', 'echo'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  s = await st(); assert(s.n === 13, 'added node via search ' + s.n);
  // undo / redo
  await p.keyboard.press('Control+z'); await p.waitForTimeout(150); s = await st(); assert(s.n === 12, 'undo removes node');
  await p.keyboard.press('Control+y'); await p.waitForTimeout(150); s = await st(); assert(s.n === 13, 'redo restores node');
  await p.evaluate(() => { const g = __eddy.S.graph; __eddy.UI.editor && (0); window.__sel = g.nodes[g.nodes.length - 1].id; });
  await p.click('.node:last-of-type .nh'); await p.waitForTimeout(150);
  // delete via keyboard (new node is selected)
  await p.keyboard.press('Delete'); await p.waitForTimeout(150); s = await st(); assert(s.n === 12, 'delete selection');
  // connect by dragging ports: voice-chat out? use two nodes: add gain, connect eq -> gain
  const r = await p.evaluate(() => { const E = __eddy.S; const a = E.graph.nodes.find((n) => n.type === 'source.music'), c = E.graph.nodes.find((n) => n.name === 'Headphones'); return { a: a.id, c: c.id, before: E.graph.edges.length }; });
  // compressor inspector: select comp and screenshot
  await p.click('.node:has-text("Compressor") .nh'); await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/shots/13-graph-comp.png' });
  // pin a param
  await p.click('.v-graph .insp .pinb >> nth=2'); await p.waitForTimeout(200);
  const pins = await p.evaluate(() => __eddy.S.graph.nodes.find((n) => n.type === 'fx.comp').pins.length); assert(pins === 3, 'pinning adds a slider to the card (' + pins + ')');
  // customise tab
  await p.click('button[role=tab]:has-text("Customise") >> nth=-1'); await p.waitForTimeout(150);
  await p.click('.swatch >> nth=3'); await p.waitForTimeout(150);
  const col = await p.evaluate(() => __eddy.S.graph.nodes.find((n) => n.type === 'fx.comp').color); assert(col === '#2DD4BF', 'colour changed ' + col);
  await p.screenshot({ path: '/tmp/shots/14-customise.png' });
  // drag-connect via ports
  await p.evaluate(() => __eddy.UI.editor.fit()); await p.waitForTimeout(200);
  const box = async (sel) => (await p.locator(sel).first().boundingBox());
  const ids = await p.evaluate(() => { const g = __eddy.S.graph; return [g.nodes.find((n) => n.type === 'source.system').id, g.nodes.find((n) => n.type === 'fx.eq').id]; });
  const eb0 = await p.evaluate(() => __eddy.S.graph.edges.length);
  const o = await box(`.node[data-id="${ids[0]}"] .port.out`), i = await box(`.node[data-id="${ids[1]}"] .port.in`);
  await p.mouse.move(o.x + o.width / 2, o.y + o.height / 2); await p.mouse.down(); await p.mouse.move(i.x + i.width / 2, i.y + i.height / 2, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(250);
  const eb1 = await p.evaluate(() => __eddy.S.graph.edges.length); assert(eb1 === eb0 + 1, 'drag from port to port makes a cable ' + eb0 + '→' + eb1);
  // loop rejection
  const cyc = await p.evaluate(() => { const g = __eddy.S.graph, c = g.nodes.find((n) => n.type === 'fx.comp'), d = g.nodes.find((n) => n.type === 'fx.denoise'); return canConnect(c.id, d.id); });
  assert(cyc && /loop/.test(cyc), 'loop is rejected: ' + cyc);
  // presets page + persistence
  await p.click('.tab:has-text("Presets")'); await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/shots/15-presets.png' });
  await p.click('.nitem:has-text("Devices")'); await p.waitForTimeout(400);
  await p.screenshot({ path: '/tmp/shots/16-health.png' });
  await p.waitForTimeout(500);
  await p.reload(); await p.waitForTimeout(1500);
  s = await st(); assert(s.n === 12 && s.name === 'Streaming', 'graph persists after reload ' + JSON.stringify(s));
  assert(!(await p.$('.welcome')), 'no welcome after reload');
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
})();
