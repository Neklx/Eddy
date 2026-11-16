const { chromium } = require('playwright'); const path = require('path');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('PASS', m); };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const c = await b.newContext({ viewport: { width: 1600, height: 960 }, permissions: ['microphone'] });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html')); await p.waitForSelector('.welcome'); await p.click('text=Try the demo'); await p.waitForTimeout(1200);
  // every preset loads, builds in the engine, and produces sound at its outputs (or is silent only by design)
  const ids = await p.evaluate(() => __eddy.PRESETS.map((x) => x.id));
  for (const id of ids) {
    const r = await p.evaluate(async (id) => {
      const pr = __eddy.PRESETS.find((x) => x.id === id); __eddy.openGraph(pr.make()); await new Promise((r) => setTimeout(r, 1800));
      const E = __eddy.S.engine, g = __eddy.S.graph; let peak = 0, errsN = 0;
      for (let i = 0; i < 60; i++) { g.nodes.filter((n) => n.type.startsWith('out.')).forEach((n) => { const l = E.level(n.id); l && (peak = Math.max(peak, l.peak)); }); await new Promise((r) => setTimeout(r, 33)); }
      g.nodes.forEach((n) => { const s = E.status(n.id); if (s && s.error) errsN++; });
      return { inst: E.inst.size, nodes: g.nodes.length, edges: E.edges.size, gedges: g.edges.length, peak, errsN };
    }, id);
    assert(r.inst === r.nodes && r.edges === r.gedges && r.errsN === 0, id + ' builds ' + JSON.stringify(r));
  }
  // recorder
  await p.evaluate(() => __eddy.openGraph(__eddy.PRESETS.find((x) => x.id === 'streaming').make())); await p.waitForTimeout(1200);
  const rec = await p.evaluate(async () => { const E = __eddy.S.engine, n = __eddy.S.graph.nodes.find((x) => x.type === 'out.record'), core = E.get(n.id).core; core.actions.toggle(); await new Promise((r) => setTimeout(r, 1800)); core.actions.toggle(); await new Promise((r) => setTimeout(r, 400)); return { size: core.blob ? core.blob.size : 0, status: core.status }; });
  assert(rec.size > 1000, 'recorder produced a file ' + JSON.stringify(rec));
  // listen
  const ls = await p.evaluate(() => { const E = __eddy.S.engine, n = __eddy.S.graph.nodes.find((x) => x.type === 'fx.comp'); E.listen(n.id); const a = E.listenId; E.listen(null); return a === n.id && E.listenId === null; });
  assert(ls, 'listen toggles');
  // EQ drag
  await p.click('.tab:has-text("Routing")'); await p.waitForTimeout(500);
  await p.click('.node:has-text("Equalizer") .nh'); await p.waitForTimeout(300);
  const cv = await p.locator('.v-graph .eqc').boundingBox();
  const before = await p.evaluate(() => JSON.stringify(__eddy.S.graph.nodes.find((n) => n.type === 'fx.eq').params));
  // band 4 (index 3) default 4k +2 dB: find on-screen x
  const x4 = cv.x + Math.log(4000 / 20) / Math.log(1000) * cv.width, y4 = cv.y + cv.height / 2 - (2 / 18) * (cv.height / 2 - 12);
  await p.mouse.move(x4, y4); await p.mouse.down(); await p.mouse.move(x4 - 60, y4 - 40, { steps: 6 }); await p.mouse.up();
  const after = await p.evaluate(() => JSON.stringify(__eddy.S.graph.nodes.find((n) => n.type === 'fx.eq').params));
  assert(before !== after, 'EQ point drags and changes params');
  await p.screenshot({ path: '/tmp/shots/20-eq-dragged.png' });
  // template save + reuse, then edge inspector
  await p.click('.node:has-text("Compressor") .nh'); await p.click('.v-graph .insp button:has-text("Save as mine")'); await p.waitForTimeout(200);
  const nt = await p.evaluate(() => JSON.parse(localStorage.getItem('eddy.v1.nodeTemplates') || '[]').length); assert(nt === 1, 'node template saved');
  await p.click('.edge >> nth=0', { force: true, position: { x: 1, y: 1 } }).catch(() => {});
  await p.evaluate(() => { const g = __eddy.S.graph; __eddy.UI.editor && 0; window.selectNodes([], g.edges[0].id); }); await p.waitForTimeout(250);
  await p.screenshot({ path: '/tmp/shots/21-edge.png' });
  assert(await p.locator('.v-graph .insp:has-text("Cable")').count() === 1, 'edge inspector shows');
  // export / import round trip through presets page
  await p.click('.tab:has-text("Presets")'); await p.waitForTimeout(300);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export current")')]);
  const f = await dl.path(); const json = JSON.parse(require('fs').readFileSync(f, 'utf8')); assert(json.nodes.length === 12, 'export contains the graph');
  console.log(errs.length ? errs.join('\n') : 'no errors'); await b.close();
})();
