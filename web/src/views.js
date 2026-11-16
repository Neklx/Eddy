/* The screens around the graph: palette, inspector, mixer, presets, health, welcome. */
const FMIN = -60, FMAX = 12;
S.devices = { in: [], out: [] };
async function refreshDevices() {
  try {
    const l = await navigator.mediaDevices.enumerateDevices();
    S.devices = { in: l.filter((d) => d.kind === 'audioinput'), out: l.filter((d) => d.kind === 'audiooutput') };
    bus.emit('devices');
  } catch (e) {}
}
function openGraph(g, why) {
  if (S.graph.nodes.length) saveBackup(why || 'Before loading ' + (g.name || 'a setup'));
  loadGraph(g); S.baseline = clone(g); S.view = { x: 40, y: 60, zoom: 0.8 };
  if (_editor) setTimeout(() => _editor.fit(), 30);
  S.engine && S.engine.ctx.state === 'suspended' && S.engine.ctx.resume();
  if (S.tab === 'mixer') { const f = S.graph.nodes.find((n) => n.type.startsWith('source.')); if (f) selectNodes([f.id]); }
}
function fmtDb(v) { return v <= FMIN + 0.05 ? '-∞' : (v > 0 ? '+' : '') + v.toFixed(1); }
const pctAt = (db) => clamp((db - FMIN) / (FMAX - FMIN), 0, 1);
const gainOf = (n) => n.params.gain;

/* ================= palette (left side of the graph) ================= */
class Palette {
  constructor(root) {
    this.root = root;
    this.q = h('input', { type: 'text', placeholder: 'Search nodes…', 'aria-label': 'Search nodes' });
    this.list = h('div', { class: 'scroll pad' });
    root.append(h('div', { class: 'pad', style: { paddingBottom: '4px' } }, h('div', { class: 'h-sec' }, 'Nodes'), h('div', { class: 'search' }, h('span', { html: icon('search', 16) }), this.q)), this.list,
      h('div', { class: 'pad', style: { borderTop: '1px solid var(--line)', color: 'var(--txt3)', fontSize: '12px' } }, 'Drag a node onto the canvas, or click to add it in the middle.'));
    this.q.addEventListener('input', () => this.draw());
    bus.on('templates', () => this.draw());
    this.draw();
  }
  item(t, tpl) {
    const n = tpl ? tpl.node : null, col = n ? n.color : t.color;
    const b = h('button', { class: 'pal-i', draggable: 'true', style: { '--nc': col }, title: t.blurb, onclick: () => placeFromPalette(t.id, { world: _editor && _editor.centerWorld() }, n) },
      h('span', { class: 'nbadge', html: icon(n ? n.icon : t.icon, 18) }), h('span', { style: { flex: 1, minWidth: 0 } }, h('b', { text: n ? n.name : t.title }), h('span', { text: n ? t.title + ' · saved' : t.blurb.split('.')[0] })),
      tpl ? h('span', { class: 'ibtn', style: { width: '26px', height: '26px' }, title: 'Delete saved node', html: icon('trash', 14), onclick: (e) => { e.stopPropagation(); deleteNodeTemplate(tpl.id); } }) : null);
    b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/eddy-type', t.id); if (tpl) e.dataTransfer.setData('text/eddy-tpl', tpl.id); e.dataTransfer.effectAllowed = 'copy'; });
    return b;
  }
  draw() {
    const q = this.q.value.trim().toLowerCase(), kids = [];
    const tpls = nodeTemplates().filter((x) => NODE_TYPES[x.node.type] && (!q || x.node.name.toLowerCase().includes(q)));
    if (tpls.length) { kids.push(h('div', { class: 'pal-cat', text: 'My nodes' })); tpls.forEach((x) => kids.push(this.item(NODE_TYPES[x.node.type], x))); }
    CATEGORIES.forEach((c) => {
      const ts = Object.values(NODE_TYPES).filter((t) => t.cat === c && (!q || (t.title + ' ' + t.blurb + ' ' + c).toLowerCase().includes(q)));
      if (!ts.length) return;
      kids.push(h('div', { class: 'pal-cat', text: c })); ts.forEach((t) => kids.push(this.item(t)));
    });
    if (!kids.length) kids.push(h('div', { class: 'empty', text: 'No node matches that.' }));
    this.list.replaceChildren(...kids);
  }
}

/* ================= inspector ================= */
const SRC_HINT = { 'source.mic': 'Allow the microphone when your browser asks.', 'source.system': 'Pick a tab or screen and tick "Share audio".' };

class Inspector {
  constructor(root) {
    this.root = root; this.tab = 'settings'; this.live = null;
    this.body = h('div', { class: 'scroll' }); root.append(this.body);
    ['select', 'graph', 'devices'].forEach((ev) => bus.on(ev, () => this.render()));
    bus.on('param', (id) => { if (this.nodeId === id) this.paramChanged(); });
    ticker.add(() => { if (this.live && this.root.offsetParent) this.live(); });
    this.render();
  }
  paramChanged() { this.refreshers && this.refreshers.forEach((f) => f()); }
  render() {
    if (!this.root.offsetParent) return;
    const keepScroll = this.body.scrollTop, focused = document.activeElement && this.root.contains(document.activeElement);
    this.live = null; this.refreshers = []; this.nodeId = null;
    let kids;
    if (S.sel.edge && edgeById(S.sel.edge)) kids = this.edgeView(edgeById(S.sel.edge));
    else if (S.sel.nodes.size === 1) { const n = nodeById([...S.sel.nodes][0]); kids = n ? this.nodeView(n) : this.emptyView(); }
    else if (S.sel.nodes.size > 1) kids = this.multiView();
    else kids = this.emptyView();
    this.body.replaceChildren(...kids); this.body.scrollTop = keepScroll;
    if (focused && document.activeElement === document.body) this.body.focus({ preventScroll: true });
  }

  emptyView() {
    const g = S.graph, srcs = g.nodes.filter((n) => n.type.startsWith('source.')).length, outs = g.nodes.filter((n) => n.type.startsWith('out.')).length;
    return [h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Nothing selected' }),
      h('p', { class: 'note', text: 'Click a node, a strip or a cable to see and change its settings here.' })),
    h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'This setup' }),
      h('div', { class: 'ro' }, h('span', { text: 'Name' }), h('span', { text: g.name })), h('div', { class: 'ro' }, h('span', { text: 'Sources' }), h('span', { text: srcs })),
      h('div', { class: 'ro' }, h('span', { text: 'Effects & mixes' }), h('span', { text: g.nodes.length - srcs - outs })), h('div', { class: 'ro' }, h('span', { text: 'Outputs' }), h('span', { text: outs })),
      h('div', { class: 'ro' }, h('span', { text: 'Cables' }), h('span', { text: g.edges.length }))),
    h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Tips' }),
      h('p', { class: 'note', html: 'Press <span class="kbd">Shift</span> and drag to select several nodes.<br>Double-click a cable to put a node in the middle of it.<br>Use the pin on any setting to keep it on the node card.' }))];
  }
  multiView() {
    const n = S.sel.nodes.size;
    return [h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: n + ' nodes selected' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: duplicateSelection }, h('span', { html: icon('copy', 16) }), 'Duplicate'), h('button', { class: 'btn danger', onclick: deleteSelection }, h('span', { html: icon('trash', 16) }), 'Delete'))),
    h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Colour for all' }), this.swatches((c) => { S.sel.nodes.forEach((id) => (nodeById(id).color = c)); commit(); }, null))];
  }
  edgeView(e) {
    const a = nodeById(e.from), b = nodeById(e.to), db = e.gain <= 0.0001 ? FMIN : 20 * Math.log10(e.gain);
    const d = { label: 'Cable level', min: FMIN, max: FMAX, step: 0.1, def: 0, unit: 'dB', fmt: fmtDb }, val = h('span', { class: 'val', text: fmtDb(db) + ' dB' });
    const rng = makeRange(d, Math.min(db, FMAX), { color: a.color, onInput: (v) => { e.gain = v <= FMIN + 0.05 ? 0 : Math.pow(10, v / 20); val.textContent = fmtDb(v) + ' dB'; engineSync(); _editor && _editor.drawEdges(); }, onCommit: () => commit() });
    return [h('div', { class: 'ihead', style: { '--nc': a.color } }, h('div', { class: 'nbadge', html: icon('link', 20) }), h('div', null, h('b', { style: { fontSize: '15px' }, text: 'Cable' }), h('small', { text: a.name + '  →  ' + b.name }))),
      h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'How much goes through' }), h('div', { class: 'prm' }, h('span', { class: 'name', text: 'Level' }), val, rng),
        h('div', { class: 'prm', style: { marginTop: '10px' } }, h('span', { class: 'name', text: 'Muted' }), makeSwitch(e.mute, (v) => { e.mute = v; commit(); }, 'Mute cable'))),
      h('div', { class: 'isec' }, h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { const r = _editor.canvas.getBoundingClientRect(); openAddMenu(r.left + r.width / 2, r.top + 120, { edge: e.id }); } }, h('span', { html: icon('plus', 16) }), 'Insert node'),
        h('button', { class: 'btn danger', onclick: deleteSelection }, h('span', { html: icon('trash', 16) }), 'Remove')))];
  }

  swatches(onPick, cur) {
    return h('div', { class: 'swatches' }, ACCENTS.map((c) => h('button', { class: 'swatch', style: { background: c }, 'aria-label': 'Colour ' + c, 'aria-pressed': String(cur === c), onclick: () => onPick(c) })),
      h('label', { class: 'swatch', title: 'Any colour', style: { background: 'conic-gradient(#f87171,#fbbf24,#34d399,#22d3ee,#8b5cf6,#f472b6,#f87171)', position: 'relative', overflow: 'hidden', cursor: 'pointer' } }, h('input', { type: 'color', style: { opacity: 0, position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }, value: /^#[0-9a-f]{6}$/i.test(cur || '') ? cur : '#8b5cf6', onchange: (ev) => onPick(ev.target.value) })));
  }

  nodeView(n) {
    this.nodeId = n.id;
    const t = NODE_TYPES[n.type], inst = S.engine && S.engine.get(n.id), core = inst && inst.core;
    const name = h('input', { type: 'text', value: n.name, 'aria-label': 'Node name', maxlength: 28 });
    name.addEventListener('change', () => { n.name = name.value.trim() || t.title; commit(); });
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
    const sub = h('small', { text: t.title });
    const head = h('div', { class: 'ihead', style: { '--nc': n.color } }, h('div', { class: 'nbadge', html: icon(n.icon, 22) }), h('div', { style: { flex: 1, minWidth: 0 } }, name, sub),
      h('button', { class: 'npow' + (isOn(n) ? ' on' : ''), style: { width: '34px', height: '34px' }, title: powerKind(n) === 'bypass' ? 'Bypass on/off' : 'Mute on/off', 'aria-pressed': String(isOn(n)), html: icon(powerKind(n) === 'mute' && n.mute ? 'mute' : 'power', 18), onclick: () => togglePower(n) }));
    const tabs = h('div', { class: 'isec', style: { paddingBottom: '12px' } }, h('div', { class: 'seg', role: 'tablist' }, [['settings', 'Settings'], ['look', 'Customise'], ['notes', 'Notes']].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(this.tab === k), onclick: () => { this.tab = k; this.render(); } }, l))));
    const out = [head, tabs];
    const err = core && core.error;
    if (err) out.push(h('div', { class: 'isec', style: { paddingBottom: 0, borderBottom: 0 } }, h('div', { class: 'errbox' }, h('span', { html: icon('alert', 18) }), h('span', null, err, core.actions && core.actions.retry ? h('span', null, ' ', h('a', { href: '#', style: { color: '#fff', textDecoration: 'underline' }, onclick: (ev) => { ev.preventDefault(); core.error = null; core.actions.retry(); } }, 'Try again')) : null))));
    if (this.tab === 'settings') out.push(...this.settings(n, t, core, sub));
    else if (this.tab === 'look') out.push(...this.look(n, t));
    else out.push(h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Notes' }), (() => { const ta = h('textarea', { placeholder: 'What is this node for?', style: { height: '140px' } }); ta.value = n.notes || ''; ta.addEventListener('keydown', (e) => e.stopPropagation()); ta.addEventListener('change', () => { n.notes = ta.value; commit(); }); return ta; })(), h('p', { class: 'note', style: { marginTop: '10px' }, text: t.blurb })));
    out.push(this.footer(n, t));
    // live status text under the name
    this.live = ((prev) => () => {
      const st = S.engine && S.engine.status(n.id); sub.textContent = t.title + (st && st.status ? '  ·  ' + st.status : '');
      prev && prev();
    })(this.live);
    return out;
  }

  footer(n, t) {
    const listening = S.engine && S.engine.listenId === n.id;
    return h('div', { class: 'isec', style: { borderBottom: 0 } }, h('div', { class: 'actions' },
      t.out ? h('button', { class: 'btn' + (listening ? ' primary' : ''), onclick: () => { S.engine && S.engine.listen(listening ? null : n.id); bus.emit('listen'); this.render(); } }, h('span', { html: icon('ear', 16) }), listening ? 'Listening' : 'Listen') : h('span'),
      h('button', { class: 'btn', onclick: duplicateSelection }, h('span', { html: icon('copy', 16) }), 'Duplicate'),
      h('button', { class: 'btn', onclick: () => { saveNodeTemplate(n); toast('Saved. It is under “My nodes” in the node list.'); } }, h('span', { html: icon('save', 16) }), 'Save as mine'),
      h('button', { class: 'btn danger', onclick: deleteSelection }, h('span', { html: icon('trash', 16) }), 'Delete')));
  }

  look(n, t) {
    return [h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Colour' }), this.swatches((c) => { n.color = c; commit(); }, n.color)),
      h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Icon' }), h('div', { class: 'icons' }, [t.icon, ...ICON_CHOICES.filter((i) => i !== t.icon)].map((i) => h('button', { 'aria-pressed': String(n.icon === i), 'aria-label': 'Icon ' + i, html: icon(i, 18), onclick: () => { n.icon = i; commit(); } })))),
      h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'On the node card' }),
        h('div', { class: 'prm' }, h('span', { class: 'name', text: 'Collapsed (header only)' }), makeSwitch(n.collapsed, (v) => { n.collapsed = v; commit(); }, 'Collapse node')),
        h('p', { class: 'note', html: 'Pin settings from the Settings tab to put sliders right on the card. Pinned now: <b>' + (n.pins.length ? n.pins.map((k) => (t.params.find((p) => p.k === k) || {}).label || k).join(', ') : 'none') + '</b>.' }),
        h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: () => { const d = makeNode(n.type, 0, 0); n.color = d.color; n.icon = d.icon; n.name = t.title; n.pins = d.pins.slice(); commit(); } }, h('span', { html: icon('refresh', 14) }), 'Reset look'))];
  }

  settings(n, t, core, sub) {
    const secs = [], box = h('div', { class: 'isec' });
    const refs = this.refreshers;
    t.params.forEach((d) => {
      if (d.hidden) return;
      if (d.t === 'range') {
        const val = h('span', { class: 'val' }), pin = h('button', { class: 'pinb' + (n.pins.includes(d.k) ? ' on' : ''), title: n.pins.includes(d.k) ? 'Unpin from the node card' : 'Pin to the node card', 'aria-label': 'Pin ' + d.label, 'aria-pressed': String(n.pins.includes(d.k)), html: icon('pin', 13), onclick: () => { n.pins = n.pins.includes(d.k) ? n.pins.filter((k) => k !== d.k) : [...n.pins, d.k]; commit(); } });
        const rng = makeRange(d, n.params[d.k], { color: n.color, label: d.label, onInput: (v) => { val.textContent = fmtParam(d, v); setParam(n, d.k, v); }, onCommit: () => commit() });
        val.textContent = fmtParam(d, n.params[d.k]);
        refs.push(() => { rng.setValue(n.params[d.k]); val.textContent = fmtParam(d, n.params[d.k]); });
        box.append(h('div', { class: 'prm' }, h('span', { class: 'name' }, d.label, pin), val, rng));
      } else if (d.t === 'toggle') {
        box.append(h('div', { class: 'prm' }, h('span', { class: 'name', text: d.label }), makeSwitch(n.params[d.k], (v) => { setParam(n, d.k, v); commit(); }, d.label)));
      } else if (d.t === 'select') {
        const s = h('select', { 'aria-label': d.label, onchange: (e) => { setParam(n, d.k, e.target.value); commit(); } }, d.opts.map(([v, l]) => h('option', { value: v, text: l, selected: n.params[d.k] === v })));
        box.append(h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', { text: d.label }), s));
      } else if (d.t === 'device-in' || d.t === 'device-out') {
        const list = d.t === 'device-in' ? S.devices.in : S.devices.out, cur = n.params[d.k];
        const opts = [h('option', { value: 'default', text: d.t === 'device-in' ? 'System default microphone' : 'System default output', selected: cur === 'default' })];
        list.filter((x) => x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications').forEach((x) => opts.push(h('option', { value: x.deviceId, text: x.label || (d.t === 'device-in' ? 'Microphone' : 'Output') + ' ' + x.deviceId.slice(0, 4), selected: cur === x.deviceId })));
        box.append(h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', { text: d.label }), h('select', { 'aria-label': d.label, onchange: (e) => { setParam(n, d.k, e.target.value); commit(); } }, opts),
          d.t === 'device-out' ? h('span', { class: 'note', style: { fontSize: '11.5px' }, text: S.sinkOK ? 'Tip: pick “CABLE Input” (VB-Cable) to use this as a microphone in other apps.' : 'This browser cannot pick an output device; it plays on the default one.' }) : null));
      } else if (d.t === 'file') {
        const f = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' }, onchange: (e) => { const file = e.target.files[0]; if (file && core && core.actions) core.actions.setFile(file); } });
        box.append(h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', { text: d.label }), f, h('button', { class: 'btn', onclick: () => f.click() }, h('span', { html: icon('folder', 16) }), 'Choose a file…')));
      } else if (d.t === 'button') {
        const bt = h('button', { class: 'btn primary block', style: { marginBottom: '10px' }, onclick: () => { core && core.actions && core.actions[d.action] && core.actions[d.action](); setTimeout(() => this.render(), 60); } }, h('span', { html: icon(d.action === 'toggle' ? 'record' : 'monitor', 16) }), d.action === 'toggle' && core && core.recording ? 'Stop recording' : d.label);
        box.append(bt);
        if (core && core.actions && core.actions.download && core.blob) box.append(h('button', { class: 'btn block', style: { marginBottom: '10px' }, onclick: () => core.actions.download() }, h('span', { html: icon('download', 16) }), 'Download recording'));
      } else if (d.t === 'eq') {
        if (core && core.response) secs.push(this.eqWidget(n, core));
      }
    });
    const hint = SRC_HINT[n.type]; if (hint && !(core && core.error)) box.append(h('p', { class: 'note', style: { fontSize: '12px' }, text: hint }));
    const res = [];
    if (box.children.length) res.push(box);
    res.push(...secs);
    const meter = this.liveSection(n, t, core); if (meter) res.push(meter);
    return res;
  }

  liveSection(n, t, core) {
    const inst = S.engine && S.engine.get(n.id); if (!inst) return null;
    const sec = h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: t.viz ? 'Spectrum' : 'Live signal' }));
    const cv = h('canvas', { class: 'scope', 'aria-label': 'Live signal' }); sec.append(cv);
    const data = new Uint8Array(1024), rows = [];
    const ro = (label) => { const v = h('span', { class: 'mono', text: '–' }); rows.push(v); sec.append(h('div', { class: 'ro' }, h('span', { text: label }), v)); return v; };
    const lvl = ro('Level'), extra = core.reduction ? ro('Gain reduction') : core.meter && 'gate' in core.meter ? ro('Gate') : core.meter && 'gain' in core.meter ? ro('Gain being applied') : null;
    const tr = n.type === 'fx.comp' ? this.transfer(n) : null; if (tr) { sec.append(h('div', { class: 'h-sec', style: { marginTop: '14px' }, text: 'Compression curve' }), tr.cv); this.refreshers.push(tr.draw); }
    this.live = () => {
      const l = S.engine.level(n.id); if (!l) return;
      lvl.textContent = lvDb(l.peak) < -80 ? 'silent' : lvDb(l.peak).toFixed(1) + ' dB';
      if (extra) { if (core.reduction) extra.textContent = core.reduction().toFixed(1) + ' dB'; else if ('gate' in core.meter) extra.textContent = core.meter.gate > 0.5 ? 'open' : 'closed (' + toDb(core.meter.gate).toFixed(0) + ' dB)'; else extra.textContent = (toDb(core.meter.gain) > 0 ? '+' : '') + toDb(core.meter.gain).toFixed(1) + ' dB'; }
      this.scope(cv, n.color, t.viz, data);
    };
    return sec;
  }
  scope(cv, color, spectrum, data) {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight; if (!w) return;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
    if (spectrum) { S.engine.spectrum(this.nodeId, data); drawSpectrum(cv, data, color); return; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
    S.engine.waveform(this.nodeId, data);
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
    g.strokeStyle = color; g.lineWidth = 1.6; g.shadowColor = color; g.shadowBlur = 8; g.beginPath();
    for (let i = 0; i < 512; i++) { const x = i / 511 * w, y = hh / 2 + ((data[i * 2] - 128) / 128) * hh * 0.46; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.shadowBlur = 0;
  }
  transfer(n) {
    const cv = h('canvas', { class: 'scope', style: { height: '130px' }, 'aria-label': 'Compression curve' });
    const draw = () => {
      const dpr = devicePixelRatio || 1, w = cv.clientWidth || 300, hh = 130; cv.width = w * dpr; cv.height = hh * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
      const X = (db) => 8 + (db + 60) / 60 * (w - 16), Y = (db) => hh - 8 - (db + 60) / 60 * (hh - 16);
      g.strokeStyle = 'rgba(255,255,255,.07)'; for (let d = -60; d <= 0; d += 12) { g.beginPath(); g.moveTo(X(d), 8); g.lineTo(X(d), hh - 8); g.moveTo(8, Y(d)); g.lineTo(w - 8, Y(d)); g.stroke(); }
      g.strokeStyle = 'rgba(255,255,255,.18)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(X(-60), Y(-60)); g.lineTo(X(0), Y(0)); g.stroke(); g.setLineDash([]);
      const { threshold: T, ratio: R, knee: K, makeup: M } = n.params;
      g.strokeStyle = n.color; g.lineWidth = 2.2; g.shadowColor = n.color; g.shadowBlur = 8; g.beginPath();
      for (let x = -60; x <= 0; x += 0.5) {
        let y = x; const o = x - T;
        if (2 * o < -K) y = x; else if (2 * Math.abs(o) <= K) y = x + (1 / R - 1) * Math.pow(o + K / 2, 2) / (2 * K); else y = T + o / R;
        y = Math.min(0, y + M); x === -60 ? g.moveTo(X(x), Y(y)) : g.lineTo(X(x), Y(y));
      }
      g.stroke(); g.shadowBlur = 0; g.fillStyle = '#fff'; g.beginPath(); g.arc(X(T), Y(T + M), 3.5, 0, 7); g.fill();
    };
    setTimeout(draw, 0);
    return { cv, draw };
  }

  /* draggable 5-band EQ curve */
  eqWidget(n, core) {
    const cv = h('canvas', { class: 'eqc', 'aria-label': 'Equalizer curve. Drag a point to change frequency and gain, scroll on a point to change width.', 'data-nodrag': '' });
    const flatBtn = h('button', { class: 'btn sm', onclick: () => { for (let i = 0; i < 5; i++) n.params['g' + i] = 0; engineSync(); bus.emit('param', n.id); commit(); } }, 'Flat');
    const sec = h('div', { class: 'isec' }, h('div', { class: 'h-sec' }, 'Curve', flatBtn), cv);
    const cols = ['#F472B6', '#FBBF24', '#34D399', '#22D3EE', '#A78BFA'];
    const FL = 20, FH = 20000, GR = 18;
    const fx = (f, w) => (Math.log(f / FL) / Math.log(FH / FL)) * w, xf = (x, w) => FL * Math.pow(FH / FL, clamp(x / w, 0, 1));
    const gy = (g, hh) => hh / 2 - (g / GR) * (hh / 2 - 12), yg = (y, hh) => clamp(((hh / 2 - y) / (hh / 2 - 12)) * GR, -GR, GR);
    const freqs = new Float32Array(160); for (let i = 0; i < 160; i++) freqs[i] = FL * Math.pow(FH / FL, i / 159);
    let drag = -1, hover = -1;
    const draw = () => {
      const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight; if (!w) return;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
      g.font = '9px ui-monospace,monospace'; g.fillStyle = 'rgba(255,255,255,.3)'; g.strokeStyle = 'rgba(255,255,255,.06)';
      [100, 1000, 10000].forEach((f) => { const x = fx(f, w); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hh); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, hh - 4); });
      [-12, -6, 0, 6, 12].forEach((d) => { const y = gy(d, hh); g.strokeStyle = d === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)'; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); if (d) g.fillText((d > 0 ? '+' : '') + d, 4, y - 3); });
      const r = core.response(freqs);
      g.beginPath(); freqs.forEach((f, i) => { const x = fx(f, w), y = gy(clamp(r[i], -GR, GR), hh); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      const grad = g.createLinearGradient(0, 0, w, 0); cols.forEach((c, i) => grad.addColorStop(i / 4, c));
      g.strokeStyle = grad; g.lineWidth = 2.5; g.shadowColor = n.color; g.shadowBlur = 10; g.stroke(); g.shadowBlur = 0;
      g.lineTo(w, gy(0, hh)); g.lineTo(0, gy(0, hh)); g.closePath(); g.globalAlpha = 0.1; g.fillStyle = n.color; g.fill(); g.globalAlpha = 1;
      for (let i = 0; i < 5; i++) { const x = fx(n.params['f' + i], w), y = gy(n.params['g' + i], hh), on = i === drag || i === hover; g.beginPath(); g.arc(x, y, on ? 8 : 6.5, 0, 7); g.fillStyle = '#0B0A1B'; g.fill(); g.lineWidth = 2.4; g.strokeStyle = cols[i]; g.stroke(); if (on) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); } }
    };
    const pick = (e) => { const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; let best = -1, bd = 18; for (let i = 0; i < 5; i++) { const d = Math.hypot(fx(n.params['f' + i], r.width) - px, gy(n.params['g' + i], r.height) - py); if (d < bd) { bd = d; best = i; } } return best; };
    cv.addEventListener('pointerdown', (e) => { drag = pick(e); if (drag < 0) return; cv.setPointerCapture(e.pointerId); e.stopPropagation(); });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag < 0) { const p = pick(e); if (p !== hover) { hover = p; cv.style.cursor = p >= 0 ? 'grab' : 'crosshair'; } return; }
      const i = drag; n.params['g' + i] = Math.round(yg(e.clientY - r.top, r.height) * 10) / 10;
      n.params['f' + i] = Math.round(xf(e.clientX - r.left, r.width));
      engineSync(); bus.emit('param', n.id);
    });
    cv.addEventListener('pointerup', () => { if (drag >= 0) { drag = -1; commit(); } });
    cv.addEventListener('dblclick', (e) => { const i = pick(e); if (i >= 0) { n.params['g' + i] = 0; engineSync(); commit(); } });
    cv.addEventListener('wheel', (e) => { const i = pick(e); if (i < 0) return; e.preventDefault(); n.params['q' + i] = clamp(n.params['q' + i] * Math.exp(-e.deltaY * 0.002), 0.2, 8); engineSync(); bus.emit('param', n.id); clearTimeout(cv._t); cv._t = setTimeout(commit, 300); }, { passive: false });
    const tk = ticker.add(() => { if (!cv.isConnected) { tk(); return; } draw(); });
    return sec;
  }
}

/* ================= presets ================= */
function miniGraph(g) {
  const ns = g.nodes; if (!ns.length) return '';
  const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y)), x1 = Math.max(...ns.map((n) => n.x + NODE_W)), y1 = Math.max(...ns.map((n) => n.y + 70));
  const w = x1 - x0 + 40, hh = y1 - y0 + 40, by = new Map(ns.map((n) => [n.id, n]));
  const edges = g.edges.map((e) => { const a = by.get(e.from), b = by.get(e.to); if (!a || !b) return ''; const ax = a.x + NODE_W - x0 + 20, ay = a.y + 30 - y0 + 20, bx = b.x - x0 + 20, by2 = b.y + 30 - y0 + 20, dx = Math.max(40, (bx - ax) / 2); return '<path d="M' + ax + ' ' + ay + ' C' + (ax + dx) + ' ' + ay + ' ' + (bx - dx) + ' ' + by2 + ' ' + bx + ' ' + by2 + '" stroke="' + a.color + '" stroke-opacity=".55" stroke-width="5" fill="none"/>'; }).join('');
  const boxes = ns.map((n) => '<rect x="' + (n.x - x0 + 20) + '" y="' + (n.y - y0 + 20) + '" width="' + NODE_W + '" height="60" rx="14" fill="#1B1840" stroke="' + n.color + '" stroke-width="3"/><circle cx="' + (n.x - x0 + 50) + '" cy="' + (n.y - y0 + 50) + '" r="13" fill="' + n.color + '"/>').join('');
  return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="xMidYMid meet">' + edges + boxes + '</svg>';
}
class Presets {
  constructor(root) {
    this.root = root; this.box = h('div', { class: 'page' }); root.append(this.box);
    bus.on('presets', () => this.draw()); this.draw();
  }
  card(name, blurb, icn, graph, extra) {
    return h('div', { class: 'pcard card' }, h('div', { class: 'pv', html: miniGraph(graph) }), h('h3', null, h('span', { html: icon(icn, 18) }), name), h('p', { text: blurb }),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { openGraph(graph); setTab('mixer'); toast('“' + name + '” is ready.'); } }, 'Use this'), extra));
  }
  draw() {
    const mine = userPresets();
    const imp = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: async (e) => { const f = e.target.files[0]; if (!f) return; try { const g = JSON.parse(await f.text()); if (!g.nodes || !g.edges) throw 0; openGraph(g, 'Before import'); setTab('mixer'); toast('Imported “' + (g.name || 'setup') + '”.'); } catch (er) { toast('That file is not an Eddy setup.', 'err'); } } });
    this.box.replaceChildren(...[
      h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' } }, h('div', null, h('h1', { text: 'Presets' }), h('p', { class: 'sub', text: 'Start from a setup that fits what you are doing, then change anything.' })),
        h('div', { class: 'row', style: { display: 'flex', gap: '10px', marginBottom: '22px' } }, imp,
          h('button', { class: 'btn', onclick: () => imp.click() }, h('span', { html: icon('upload', 16) }), 'Import…'),
          h('button', { class: 'btn', onclick: () => { const b = new Blob([snapshot()], { type: 'application/json' }), a = h('a', { href: URL.createObjectURL(b), download: (S.graph.name || 'eddy-setup').replace(/\W+/g, '-').toLowerCase() + '.eddy.json' }); a.click(); } }, h('span', { html: icon('download', 16) }), 'Export current'),
          h('button', { class: 'btn primary', onclick: () => { saveUserPreset(S.graph.name); toast('Saved “' + S.graph.name + '”.'); } }, h('span', { html: icon('save', 16) }), 'Save current'))),
      mine.length ? h('div', null, h('div', { class: 'h-sec', text: 'Yours' }), h('div', { class: 'pgrid', style: { marginBottom: '28px' } }, mine.map((p) => this.card(p.name, new Date(p.t).toLocaleString(), 'save', p.graph, h('button', { class: 'btn danger', 'aria-label': 'Delete ' + p.name, html: icon('trash', 16), onclick: () => deleteUserPreset(p.id) }))))) : null,
      h('div', { class: 'h-sec', text: 'Built in' }), h('div', { class: 'pgrid' }, PRESETS.map((p) => this.card(p.name, p.blurb, p.icon, p.make())))].filter(Boolean));
  }
}

/* ================= health ================= */
class Health {
  constructor(root) {
    this.root = root; this.box = h('div', { class: 'page' }); root.append(this.box);
    bus.on('backups', () => this.render());
  }
  checks() {
    const ctx = S.engine && S.engine.ctx, ok = (name, d, r, st) => ({ name, d, r, st: st || 'ok' });
    const c = [];
    c.push(ok('Audio engine', ctx ? 'Web Audio is running in this browser tab' : 'Not started', ctx ? ctx.state : 'off', ctx && ctx.state === 'running' ? 'ok' : 'warn'));
    c.push(ok('Sample rate', 'Everything runs at one rate, so nothing is resampled', ctx ? Math.round(ctx.sampleRate / 100) / 10 + ' kHz' : '–'));
    c.push(ok('Delay through Eddy', 'Browser output plus device buffer', S.engine ? S.engine.latencyMs().toFixed(0) + ' ms' : '–'));
    c.push(ok('Noise filters', 'AudioWorklets for denoise, gate and auto level', S.engine && S.engine.workletsOK ? 'loaded' : 'loading', S.engine && S.engine.workletsOK ? 'ok' : 'warn'));
    c.push(ok('Secure context', 'Microphone access needs https or a local file', window.isSecureContext ? 'yes' : 'no', window.isSecureContext ? 'ok' : 'bad'));
    c.push(ok('Choose output device', S.sinkOK ? 'Needed to send sound into a virtual cable' : 'This browser cannot pick outputs. Use Chrome or Edge.', S.sinkOK ? 'supported' : 'missing', S.sinkOK ? 'ok' : 'warn'));
    c.push(ok('Capture a tab or screen', 'For system sound through the browser', navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? 'supported' : 'missing', navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? 'ok' : 'warn'));
    c.push(ok('Microphones found', S.devices.in.some((d) => d.label) ? 'Names show once you allowed the microphone' : 'Allow the microphone to see names', String(S.devices.in.length), S.devices.in.length ? 'ok' : 'warn'));
    const cable = S.devices.out.find((d) => /cable input|eddy mic/i.test(d.label || ''));
    c.push(ok('Virtual microphone', cable ? 'Pick “' + (cable.label.replace(/\s*\(.*$/, '')) + '” as the output of your Eddy Mic node. Voice apps then use the matching “CABLE Output” as their microphone.' : 'Not found. Install VB-Cable (free, from vb-cable.com), restart Eddy, then voice apps can use it as a microphone.', cable ? 'found' : 'missing', cable ? 'ok' : 'warn'));
    c.push(ok('Output devices found', 'Headphones, speakers and virtual cables', String(S.devices.out.length), S.devices.out.length ? 'ok' : 'warn'));
    let store = 'ok'; try { localStorage.setItem('eddy.t', '1'); localStorage.removeItem('eddy.t'); } catch (e) { store = 'bad'; }
    c.push(ok('Saving', 'Your setup is saved in this browser after every change', store === 'ok' ? 'on' : 'blocked', store));
    return c;
  }
  nativeCard() { if (!S.native) return null; if (!this.native) this.native = new NativeCard(); return this.native.el; }
  render() {
    if (!this.root.offsetParent) return;
    const cs = this.checks(), bad = cs.filter((c) => c.st === 'bad').length, warn = cs.filter((c) => c.st === 'warn').length;
    const sum = bad ? 'Something needs your attention.' : warn ? 'Works, with a couple of notes below.' : 'Everything is healthy.';
    const bks = readBackups();
    this.box.replaceChildren(
      h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' } }, h('div', null, h('h1', { text: 'Audio health' }), h('p', { class: 'sub', 'aria-live': 'polite', text: sum + ' If sound ever stops, press Repair.' })),
        h('button', { class: 'btn primary', style: { marginBottom: '22px' }, onclick: async () => { await repairAudio(); this.render(); } }, h('span', { html: icon('refresh', 16) }), 'Repair audio')),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('div', { class: 'hh', text: 'Checks' }), cs.map((c) => h('div', { class: 'check ' + (c.st === 'ok' ? '' : c.st) }, h('span', { class: 'ok', html: icon(c.st === 'ok' ? 'check' : 'alert', 15) }), h('div', null, h('b', { text: c.name }), h('span', { class: 'd', text: c.d })), h('span', { class: 'r', text: c.r })))),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
          this.nativeCard(),
          h('div', { class: 'card' }, h('div', { class: 'hh' }, 'Backups', h('button', { class: 'btn sm', onclick: () => { saveBackup('Manual'); toast('Backup saved.'); } }, 'Back up now')),
            bks.length ? bks.slice(0, 8).map((b) => h('div', { class: 'brow' }, h('div', { style: { flex: 1 } }, h('b', { text: b.name + (b.label ? ' · ' + b.label : '') }), h('small', { text: new Date(b.t).toLocaleString() })),
              h('button', { class: 'btn sm', onclick: () => { openGraph(b.graph, 'Before restore'); toast('Restored “' + b.name + '”.'); setTab('mixer'); } }, 'Restore'))) : h('div', { class: 'empty', text: 'Eddy saves a copy before big changes and every minute.' })),
          h('div', { class: 'card' }, h('div', { class: 'hh', text: 'Shortcuts' }),
            h('div', { class: 'sc' }, [['Ctrl Z / Y', 'Undo / redo'], ['Ctrl D', 'Duplicate'], ['Ctrl C / V', 'Copy / paste'], ['Del', 'Delete selection'], ['F', 'Fit graph to window'], ['M', 'Mute microphone'], ['Shift + drag', 'Select several'], ['Double-click', 'Add a node']].flatMap(([k, d]) => [h('span', { class: 'kbd', text: k }), h('span', { text: d })])))))
    );
  }
}

/* ================= welcome ================= */
function showWelcome(hasSaved) {
  const close = () => m.remove();
  const go = (fn) => () => { close(); fn(); };
  const m = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Welcome to Eddy' }, h('div', { class: 'welcome' },
    h('div', { html: '<svg width="64" height="64" viewBox="0 0 32 32" fill="none"><path d="M4 18c4-9 14-12 21-6 4 4 2 10-3 11-4 1-7-2-6-5 1-3 5-3 6-1" stroke="#A78BFA" stroke-width="2.2" stroke-linecap="round"/><path d="M6 24c5 3 12 2 17-2" stroke="#5B6190" stroke-width="2.2" stroke-linecap="round"/></svg>', style: { filter: 'drop-shadow(0 0 18px rgba(139,92,246,.7))' } }),
    h('h1', { text: 'Welcome to Eddy' }),
    h('p', { text: 'A mixer for your voice and your sound. Clean your microphone, blend music and games, and send the result to chat, a stream or a recording. Build it as simply or as deeply as you like.' }),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: go(() => openGraph(PRESETS[0].make(), 'Before welcome')) }, h('span', { html: icon('mic', 18) }), 'Use my microphone'),
      h('button', { class: 'btn', onclick: go(() => openGraph(PRESETS[1].make(), 'Before welcome')) }, h('span', { html: icon('sparkles', 18) }), 'Try the demo, no mic needed'),
      hasSaved ? h('button', { class: 'btn', onclick: go(() => {}) }, 'Continue where I left off') : null),
    h('p', { class: 'fine', text: 'Everything stays on your computer. Nothing is uploaded.' })));
  document.body.append(m);
  const b = m.querySelector('button'); b && b.focus();
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
