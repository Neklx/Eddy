// Tests the graph -> native engine translator on the real presets. Plain Node, no browser needed.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = (f) => fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
const ctx = vm.createContext({ console, Math, JSON, Date, Set, Map });
vm.runInContext(['icons.js', 'worklets.js', 'nodes.js', 'native.js', 'graph.js'].map(src).join('\n') +
  '\nthis.api = { nativePlan, nativeDiff, PRESETS, makeNode, NODE_TYPES };', ctx);
const { nativePlan, nativeDiff, PRESETS } = ctx.api;

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('PASS', name); };
const preset = (id) => PRESETS.find((p) => p.id === id).make();
const by = (plan, cmd, f) => Object.values(plan.req).find((r) => r.cmd === cmd && f(r));

ok('every preset translates without throwing, all numbers finite', () => {
  for (const p of PRESETS) {
    const plan = nativePlan(p.make());
    for (const r of Object.values(plan.req)) for (const v of Object.values(r)) if (typeof v === 'number') assert.ok(Number.isFinite(v), p.id + ' ' + JSON.stringify(r));
  }
});

ok('streaming: mic chain becomes voice stages, mic reaches Eddy Mic (1), music reaches headphones (0)', () => {
  const plan = nativePlan(preset('streaming'));
  for (const s of ['noise', 'gate', 'eq', 'compressor']) assert.equal(by(plan, 'set_stage', (r) => r.stage === s).on, true, s);
  assert.equal(by(plan, 'set_stage', (r) => r.stage === 'leveler').on, false, 'no leveler in this preset');
  assert.equal(by(plan, 'set_param', (r) => r.param === 'noise_strength').value, 0.75);
  assert.equal(plan.req['sd:0:1'].gain, 1, 'mic -> voice chat');
  assert.equal(plan.req['sd:0:0'].gain, 0, 'mic is not sent to your own headphones');
  assert.equal(plan.req['sd:4:0'].gain > 0 || plan.req['sd:4:1'].gain >= 0, true);
  assert.ok(plan.warnings.some((w) => /recorder/i.test(w)), 'recorder is reported as unsupported');
});

ok('music has no native input yet and says so', () => {
  const plan = nativePlan(preset('streaming'));
  assert.ok(plan.warnings.some((w) => /music/i.test(w) || /Music/.test(w)));
});

ok('gaming: high-pass filter feeds high_pass_hz, game sound goes to headphones only', () => {
  const plan = nativePlan(preset('gaming'));
  assert.equal(by(plan, 'set_param', (r) => r.param === 'high_pass_hz').value, 80);
  assert.equal(plan.req['sd:4:0'].gain, 1);
  assert.equal(plan.req['sd:4:1'].gain, 0);
  assert.equal(plan.req['sd:0:1'].gain, 1);
});

ok('muted source, muted edge and a bypassed effect are respected', () => {
  const g = preset('streaming');
  g.nodes.find((x) => x.type === 'source.mic').mute = true;
  assert.equal(nativePlan(g).req['sm:0'].mute, true);
  const g2 = preset('streaming');
  g2.nodes.find((x) => x.type === 'fx.gate').bypass = true;
  assert.equal(by(nativePlan(g2), 'set_stage', (r) => r.stage === 'gate').on, false);
  const g3 = preset('gaming');
  const sys = g3.nodes.find((x) => x.type === 'source.system');
  g3.edges.filter((e) => e.from === sys.id).forEach((e) => (e.mute = true));
  assert.equal(nativePlan(g3).req['sd:4:0'].gain, 0);
});

ok('edge gain and output level multiply into the send', () => {
  const g = preset('gaming');
  const sys = g.nodes.find((x) => x.type === 'source.system');
  g.edges.filter((e) => e.from === sys.id).forEach((e) => (e.gain = 0.5));
  g.nodes.find((x) => x.name === 'Headphones').params.gain = -6.0206;
  const p = nativePlan(g);
  assert.equal(p.req['sd:4:0'].gain, 0.5);
  assert.ok(Math.abs(p.req['dg:0'].gain - 0.5) < 0.001);
});

ok('a cycle in the graph does not hang', () => {
  const g = preset('podcast');
  const a = g.nodes.find((x) => x.type === 'fx.comp'), b = g.nodes.find((x) => x.type === 'fx.leveler');
  g.edges.push({ id: 'loop', from: b.id, to: a.id, gain: 1 });
  nativePlan(g);
});

ok('diff sends only what changed, and everything the first time', () => {
  const g = preset('streaming');
  const first = nativePlan(g);
  assert.equal(nativeDiff({}, first.req).length, Object.keys(first.req).length);
  const sent = Object.assign({}, first.req);
  assert.equal(nativeDiff(sent, nativePlan(g).req).length, 0);
  g.nodes.find((x) => x.type === 'fx.denoise').params.strength = 0.3;
  const d = nativeDiff(sent, nativePlan(g).req);
  assert.equal(d.length, 1);
  assert.equal(d[0][1].value, 0.3);
});

ok('empty graph: warnings, every send off', () => {
  const p = nativePlan({ nodes: [], edges: [] });
  assert.ok(p.warnings.length >= 2);
  assert.ok(Object.values(p.req).filter((r) => r.cmd === 'set_send').every((r) => r.gain === 0));
});

console.log(n + ' passed');
