/* Graph model, history, persistence and presets. The graph is plain data, so it can be
   saved, shared, diffed, and later handed to the Rust engine unchanged. */
const NODE_W = 244;
const NODE_HEAD = 60;
const ACCENTS = ['#8B5CF6', '#4C8DFF', '#22D3EE', '#2DD4BF', '#34D399', '#A3E635', '#FBBF24', '#FB923C', '#F87171', '#F472B6', '#C084FC', '#94A3B8'];

const S = {
  graph: { name: 'Untitled', nodes: [], edges: [] },
  sel: { nodes: new Set(), edge: null },
  tab: 'mixer',
  engine: null,
  past: [], future: [],
  view: { x: 40, y: 40, zoom: 0.8 },
  listeners: {},
  dirty: false,
};
const bus = {
  on(ev, fn) { (S.listeners[ev] = S.listeners[ev] || new Set()).add(fn); return () => S.listeners[ev].delete(fn); },
  emit(ev, a) { (S.listeners[ev] || []).forEach((f) => f(a)); },
};

let idCounter = Date.now() % 100000;
const uid = (p) => p + (idCounter++).toString(36);
const clone = (o) => JSON.parse(JSON.stringify(o));
const nodeById = (id) => S.graph.nodes.find((n) => n.id === id);
const edgeById = (id) => S.graph.edges.find((e) => e.id === id);

function defaultParams(type) {
  const t = NODE_TYPES[type];
  const o = {};
  t.params.forEach((p) => { if (p.k && p.t !== 'button' && p.t !== 'eq') o[p.k] = p.def; });
  return o;
}

const DEFAULT_PINS = { 'fx.denoise': ['strength'], 'fx.gate': ['threshold'], 'fx.comp': ['threshold', 'ratio'], 'fx.leveler': ['target'], 'fx.filter': ['freq'], 'fx.limiter': ['ceiling'], 'fx.reverb': ['mix'], 'fx.delay': ['mix'], 'fx.gain': ['gain'], 'fx.bus': ['gain'], 'source.mic': ['gain'], 'source.voice': ['noise'], 'source.music': ['gain'], 'source.system': ['gain'], 'source.tone': ['freq'], 'source.noise': ['gain'], 'out.speakers': ['gain'], 'out.record': [], 'fx.pan': ['pan'], 'fx.eq': [], 'viz.spectrum': [] };

function makeNode(type, x, y, over = {}) {
  const t = NODE_TYPES[type];
  return Object.assign({
    id: uid('n'), type, x, y, name: t.title, color: t.color, icon: t.icon,
    params: defaultParams(type), bypass: false, mute: false, collapsed: false,
    pins: (DEFAULT_PINS[type] || []).slice(), notes: '',
  }, over, { params: Object.assign(defaultParams(type), over.params || {}) });
}

/* ---- changes ---- */
function wouldCycle(from, to) {
  if (from === to) return true;
  const seen = new Set(), stack = [to];
  while (stack.length) {
    const n = stack.pop();
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    S.graph.edges.forEach((e) => e.from === n && stack.push(e.to));
  }
  return false;
}

function canConnect(from, to) {
  const a = nodeById(from), b = nodeById(to);
  if (!a || !b) return 'Missing node';
  if (!NODE_TYPES[a.type].out) return a.name + ' has no output';
  if (!NODE_TYPES[b.type].in) return b.name + ' has no input';
  if (S.graph.edges.some((e) => e.from === from && e.to === to)) return 'Already connected';
  if (wouldCycle(from, to)) return 'That would make a loop';
  return null;
}

function addNode(type, x, y, over) { const n = makeNode(type, x, y, over); S.graph.nodes.push(n); return n; }
function addEdge(from, to, over = {}) {
  const why = canConnect(from, to);
  if (why) return { error: why };
  const e = Object.assign({ id: uid('e'), from, to, gain: 1, mute: false }, over);
  S.graph.edges.push(e);
  return e;
}
function removeEdge(id) { S.graph.edges = S.graph.edges.filter((e) => e.id !== id); if (S.sel.edge === id) S.sel.edge = null; }
function removeNodes(ids) {
  const set = new Set(ids);
  S.graph.nodes = S.graph.nodes.filter((n) => !set.has(n.id));
  S.graph.edges = S.graph.edges.filter((e) => !set.has(e.from) && !set.has(e.to));
  ids.forEach((id) => S.sel.nodes.delete(id));
}
function duplicateNodes(ids, dx = 40, dy = 40) {
  const map = new Map(), out = [];
  ids.forEach((id) => { const n = nodeById(id); if (!n) return; const c = Object.assign(clone(n), { id: uid('n'), x: n.x + dx, y: n.y + dy, name: n.name }); map.set(id, c.id); S.graph.nodes.push(c); out.push(c); });
  S.graph.edges.filter((e) => map.has(e.from) && map.has(e.to)).forEach((e) => S.graph.edges.push(Object.assign(clone(e), { id: uid('e'), from: map.get(e.from), to: map.get(e.to) })));
  return out;
}
function insertOnEdge(edgeId, type) {
  const e = edgeById(edgeId); if (!e) return null;
  const a = nodeById(e.from), b = nodeById(e.to);
  const n = addNode(type, (a.x + b.x) / 2, (a.y + b.y) / 2);
  const old = clone(e);
  removeEdge(edgeId);
  addEdge(a.id, n.id, { gain: old.gain, mute: old.mute });
  addEdge(n.id, b.id);
  return n;
}

/* ---- history ---- */
function snapshot() { return JSON.stringify({ nodes: S.graph.nodes, edges: S.graph.edges, name: S.graph.name }); }
let lastSnap = '';
function commit() {
  const snap = snapshot();
  if (snap === lastSnap) { bus.emit('graph'); return; }
  if (lastSnap) { S.past.push(lastSnap); if (S.past.length > 100) S.past.shift(); }
  S.future = [];
  lastSnap = snap;
  bus.emit('graph');
  persistSoon();
}
function restore(snap) {
  const g = JSON.parse(snap);
  S.graph = Object.assign(S.graph, g);
  lastSnap = snap;
  S.sel.nodes = new Set([...S.sel.nodes].filter((id) => nodeById(id)));
  if (S.sel.edge && !edgeById(S.sel.edge)) S.sel.edge = null;
  bus.emit('graph'); bus.emit('select'); persistSoon();
}
function undo() { if (!S.past.length) return false; S.future.push(lastSnap); restore(S.past.pop()); return true; }
function redo() { if (!S.future.length) return false; S.past.push(lastSnap); restore(S.future.pop()); return true; }

function loadGraph(g, keepName) {
  S.graph = { name: g.name || 'Untitled', nodes: clone(g.nodes), edges: clone(g.edges) };
  S.graph.nodes.forEach((n) => { // forward compatibility: fill anything a newer/older file lacks
    const t = NODE_TYPES[n.type]; if (!t) return;
    n.params = Object.assign(defaultParams(n.type), n.params || {});
    n.color = n.color || t.color; n.icon = n.icon || t.icon; n.name = n.name || t.title; n.pins = n.pins || []; n.notes = n.notes || '';
  });
  S.graph.nodes = S.graph.nodes.filter((n) => NODE_TYPES[n.type]);
  const ids = new Set(S.graph.nodes.map((n) => n.id));
  S.graph.edges = S.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  S.sel = { nodes: new Set(), edge: null };
  S.past = []; S.future = []; lastSnap = snapshot();
  bus.emit('graph'); bus.emit('select');
  persistSoon();
}

/* ---- persistence: autosave + versioned backups ---- */
const KEY = 'eddy.v1.graph', BKEY = 'eddy.v1.backups';
let persistTimer = null, lastBackup = 0;
function persistSoon() { if (S.autoSave === false) return; clearTimeout(persistTimer); persistTimer = setTimeout(persistNow, 250); }
function persistNow() {
  try {
    localStorage.setItem(KEY, snapshot());
    if (Date.now() - lastBackup > 60000) { saveBackup('Auto'); }
  } catch (e) {}
}
function readBackups() { try { return JSON.parse(localStorage.getItem(BKEY) || '[]'); } catch (e) { return []; } }
function saveBackup(label) {
  if (!S.graph.nodes.length) return;
  try {
    const b = readBackups();
    b.unshift({ t: Date.now(), label, name: S.graph.name, graph: JSON.parse(snapshot()) });
    localStorage.setItem(BKEY, JSON.stringify(b.slice(0, 20)));
    lastBackup = Date.now();
    bus.emit('backups');
  } catch (e) {}
}
function readSaved() {
  try { const t = localStorage.getItem(KEY); if (!t) return null; const g = JSON.parse(t); return g && Array.isArray(g.nodes) ? g : null; } catch (e) { return null; }
}

/* ---- queries ---- */
function downstream(id) { const out = new Set(), st = [id]; while (st.length) { const n = st.pop(); S.graph.edges.forEach((e) => { if (e.from === n && !out.has(e.to)) { out.add(e.to); st.push(e.to); } }); } return out; }
/* the main path from a source through effects, following first edges */
function chainFrom(id) {
  const path = [], seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = nodeById(cur); if (!n) break;
    path.push(n);
    const nxt = S.graph.edges.filter((e) => e.from === cur).map((e) => nodeById(e.to)).filter(Boolean);
    const fx = nxt.find((m) => m.type.startsWith('fx.') && m.type !== 'fx.bus');
    cur = fx ? fx.id : null;
  }
  return path;
}
function reachableOutputs(id) {
  const outs = [];
  downstream(id).forEach((d) => { const n = nodeById(d); if (n && n.type.startsWith('out.')) outs.push(n); });
  return outs;
}

/* ---- auto layout: layers left to right, order kept from current y ---- */
function autoLayout() {
  const depth = new Map();
  const ind = (id) => S.graph.edges.filter((e) => e.to === id).map((e) => e.from);
  const d = (id, seen = new Set()) => { if (depth.has(id)) return depth.get(id); if (seen.has(id)) return 0; seen.add(id); const v = Math.max(-1, ...ind(id).map((p) => d(p, seen))) + 1; depth.set(id, v); return v; };
  S.graph.nodes.forEach((n) => d(n.id));
  const layers = {};
  S.graph.nodes.forEach((n) => (layers[depth.get(n.id)] = layers[depth.get(n.id)] || []).push(n));
  Object.keys(layers).forEach((k) => {
    layers[k].sort((a, b) => a.y - b.y);
    let y = 40;
    layers[k].forEach((n) => { n.x = 40 + k * 300; n.y = y; y += nodeHeight(n) + 36; });
  });
}
function nodeHeight(n) {
  if (n.collapsed) return NODE_HEAD;
  const t = NODE_TYPES[n.type];
  return NODE_HEAD + 34 + (n.pins || []).length * 38 + (t.viz ? 70 : 0) + 8;
}

/* ---- presets ---- */
function build(name, spec) {
  const keyed = {};
  const nodes = spec.nodes.map(([key, type, x, y, over]) => { const n = makeNode(type, x, y, over || {}); keyed[key] = n.id; return n; });
  const edges = spec.edges.map(([a, b, gain, mute]) => ({ id: uid('e'), from: keyed[a], to: keyed[b], gain: gain == null ? 1 : gain, mute: !!mute }));
  return { name, nodes, edges };
}
const PRESETS = [
  { id: 'streaming', name: 'Streaming', blurb: 'Clean voice to chat and stream, music and game for you.', icon: 'broadcast',
    make: () => build('Streaming', { nodes: [
      ['mic', 'source.mic', 40, 40, { name: 'Microphone' }], ['music', 'source.music', 40, 300], ['sys', 'source.system', 40, 520],
      ['dn', 'fx.denoise', 340, 40, { params: { strength: 0.75 } }], ['gate', 'fx.gate', 640, 40], ['eq', 'fx.eq', 940, 40], ['comp', 'fx.comp', 1240, 40],
      ['vbus', 'fx.bus', 1540, 40, { name: 'Voice mix', color: '#8B5CF6' }], ['sbus', 'fx.bus', 1540, 300, { name: 'Stream mix', color: '#F472B6' }],
      ['vout', 'out.speakers', 1840, 20, { name: 'Voice chat', icon: 'chat', color: '#8B5CF6' }], ['rec', 'out.record', 1840, 300, { name: 'Stream recorder' }], ['hp', 'out.speakers', 1840, 520, { name: 'Headphones' }],
    ], edges: [['mic', 'dn'], ['dn', 'gate'], ['gate', 'eq'], ['eq', 'comp'], ['comp', 'vbus'], ['vbus', 'vout'], ['vbus', 'sbus'], ['music', 'sbus', 0.5], ['sys', 'sbus', 0.7], ['sbus', 'rec'], ['music', 'hp'], ['sys', 'hp'], ['vbus', 'hp', 0.4, true]] }) },
  { id: 'demo', name: 'Demo (no mic needed)', blurb: 'A noisy test voice through the full clean-up chain.', icon: 'sparkles',
    make: () => build('Demo', { nodes: [
      ['voice', 'source.voice', 40, 40], ['music', 'source.music', 40, 330, { params: { play: false } }],
      ['dn', 'fx.denoise', 340, 40, { params: { strength: 0.8 } }], ['gate', 'fx.gate', 640, 40, { params: { threshold: -45 } }], ['eq', 'fx.eq', 940, 40], ['comp', 'fx.comp', 1240, 40],
      ['spec', 'viz.spectrum', 1540, 40], ['hp', 'out.speakers', 1840, 40, { name: 'Headphones' }],
    ], edges: [['voice', 'dn'], ['dn', 'gate'], ['gate', 'eq'], ['eq', 'comp'], ['comp', 'spec'], ['spec', 'hp'], ['music', 'hp', 0.6]] }) },
  { id: 'gaming', name: 'Gaming', blurb: 'Clear callouts for your team, game sound only for you.', icon: 'gamepad',
    make: () => build('Gaming', { nodes: [
      ['mic', 'source.mic', 40, 40], ['sys', 'source.system', 40, 330, { name: 'Game' }], ['music', 'source.music', 40, 550, { params: { gain: -12, play: false } }],
      ['hpf', 'fx.filter', 340, 40, { name: 'Rumble cut' }], ['dn', 'fx.denoise', 640, 40], ['comp', 'fx.comp', 940, 40, { params: { ratio: 3 } }],
      ['vout', 'out.speakers', 1240, 40, { name: 'Voice chat', icon: 'chat', color: '#8B5CF6' }], ['hp', 'out.speakers', 1240, 330, { name: 'Headphones' }],
    ], edges: [['mic', 'hpf'], ['hpf', 'dn'], ['dn', 'comp'], ['comp', 'vout'], ['sys', 'hp'], ['music', 'hp']] }) },
  { id: 'podcast', name: 'Podcast', blurb: 'Broadcast sound, recorded safely under a limiter.', icon: 'mic',
    make: () => build('Podcast', { nodes: [
      ['mic', 'source.mic', 40, 40], ['hpf', 'fx.filter', 340, 40, { name: 'Rumble cut' }], ['dn', 'fx.denoise', 640, 40], ['eq', 'fx.eq', 940, 40, { params: { g0: 3, g3: 3 } }],
      ['comp', 'fx.comp', 1240, 40, { params: { ratio: 3, threshold: -26 } }], ['lev', 'fx.leveler', 1540, 40], ['lim', 'fx.limiter', 1840, 40],
      ['rec', 'out.record', 2140, 20, { name: 'Recorder' }], ['hp', 'out.speakers', 2140, 260, { name: 'Headphones' }],
    ], edges: [['mic', 'hpf'], ['hpf', 'dn'], ['dn', 'eq'], ['eq', 'comp'], ['comp', 'lev'], ['lev', 'lim'], ['lim', 'rec'], ['lim', 'hp', 0.4, true]] }) },
  { id: 'karaoke', name: 'Karaoke', blurb: 'Your voice with reverb over a backing track.', icon: 'music',
    make: () => build('Karaoke', { nodes: [
      ['mic', 'source.mic', 40, 40], ['music', 'source.music', 40, 330, { name: 'Backing track' }],
      ['dn', 'fx.denoise', 340, 40], ['rev', 'fx.reverb', 640, 40, { params: { mix: 0.3, decay: 2.2 } }], ['bus', 'fx.bus', 940, 160, { name: 'Mix' }],
      ['hp', 'out.speakers', 1240, 80, { name: 'Speakers' }], ['rec', 'out.record', 1240, 300, { name: 'Recorder' }],
    ], edges: [['mic', 'dn'], ['dn', 'rev'], ['rev', 'bus'], ['music', 'bus', 0.7], ['bus', 'hp'], ['bus', 'rec']] }) },
  { id: 'music', name: 'Music only', blurb: 'Listen with EQ, a safety limiter and a live spectrum.', icon: 'headphones',
    make: () => build('Music only', { nodes: [
      ['music', 'source.music', 40, 40], ['eq', 'fx.eq', 340, 40, { params: { g0: 3, g4: 2 } }], ['lim', 'fx.limiter', 640, 40], ['spec', 'viz.spectrum', 940, 40], ['hp', 'out.speakers', 1240, 40, { name: 'Headphones' }],
    ], edges: [['music', 'eq'], ['eq', 'lim'], ['lim', 'spec'], ['spec', 'hp']] }) },
];
const USER_PRESETS_KEY = 'eddy.v1.userPresets';
function userPresets() { try { return JSON.parse(localStorage.getItem(USER_PRESETS_KEY) || '[]'); } catch (e) { return []; } }
function saveUserPreset(name) {
  try { const p = userPresets(); p.unshift({ id: uid('u'), name, graph: JSON.parse(snapshot()), t: Date.now() }); localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(p.slice(0, 30))); bus.emit('presets'); } catch (e) {}
}
function deleteUserPreset(id) { try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(userPresets().filter((p) => p.id !== id))); bus.emit('presets'); } catch (e) {} }

/* node templates: save a customised node (name, colour, pins, settings) and reuse it */
const TPL_KEY = 'eddy.v1.nodeTemplates';
function nodeTemplates() { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '[]'); } catch (e) { return []; } }
function saveNodeTemplate(n) { try { const t = nodeTemplates(); t.unshift({ id: uid('t'), node: clone(n) }); localStorage.setItem(TPL_KEY, JSON.stringify(t.slice(0, 40))); bus.emit('templates'); } catch (e) {} }
function deleteNodeTemplate(id) { try { localStorage.setItem(TPL_KEY, JSON.stringify(nodeTemplates().filter((t) => t.id !== id))); bus.emit('templates'); } catch (e) {} }
