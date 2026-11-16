/* Dashboard-style Mixer (sources -> engine -> destinations), effect cards, effects rack, settings. */
const WAVE = (w = 40) => '<svg width="' + w + '" height="' + w * 0.66 + '" viewBox="0 0 48 32" fill="none" aria-hidden="true"><defs><linearGradient id="wg' + w + '" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#8B5CF6"/><stop offset="1" stop-color="#60A5FA"/></linearGradient></defs><path d="M4 27C4 8 14 4 18 16c2.6 8 8.4 8 11 0C33 4 44 8 44 27" stroke="url(#wg' + w + ')" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVGNS = 'http://www.w3.org/2000/svg';
const isFx = (x) => x.type.startsWith('fx.') && x.type !== 'fx.bus';
const hasGain = (n) => n.params && 'gain' in n.params;

function upstreamSource(n) {
  let cur = n, k = 0;
  while (cur && !cur.type.startsWith('source.') && k++ < 40) { const e = S.graph.edges.find((x) => x.to === cur.id); cur = e && nodeById(e.from); }
  return cur && cur.type.startsWith('source.') ? cur : null;
}
/* the effect nodes that belong "to" a selected node */
function fxOf(n) {
  if (n.type.startsWith('source.')) return chainFrom(n.id).filter(isFx);
  if (isFx(n)) { const s = upstreamSource(n); return s ? chainFrom(s.id).filter(isFx) : [n]; }
  const out = []; let cur = n, k = 0;
  while (k++ < 20) { const es = S.graph.edges.filter((x) => x.to === cur.id); if (es.length !== 1) break; cur = nodeById(es[0].from); if (!cur || !isFx(cur)) break; out.unshift(cur); }
  return out;
}
function exportSetup() {
  const b = new Blob([snapshot()], { type: 'application/json' }), a = h('a', { href: URL.createObjectURL(b), download: (S.graph.name || 'eddy-setup').replace(/\W+/g, '-').toLowerCase() + '.eddy.json' });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function importSetup() {
  const f = h('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => { const file = e.target.files[0]; if (!file) return; try { const g = JSON.parse(await file.text()); if (!g.nodes || !g.edges) throw 0; openGraph(g, 'Before import'); toast('Imported “' + (g.name || 'setup') + '”.'); } catch (er) { toast('That file is not an Eddy setup.', 'err'); } } });
  f.click();
}
function saveProfile() { saveUserPreset(S.graph.name); persistNow(); S.baseline = JSON.parse(snapshot()); toast('Saved “' + S.graph.name + '”.'); }
function revertSetup() { if (S.baseline) { openGraph(S.baseline, 'Before revert'); toast('Back to how it was when opened.'); } }

/* a dropdown of every profile */
function profileSelect(label) {
  const sel = h('select', { 'aria-label': label || 'Profile' });
  const fill = () => {
    const mine = userPresets(), cur = S.graph.name, known = PRESETS.some((p) => p.name === cur) || mine.some((p) => p.name === cur);
    const kids = [];
    if (!known) kids.push(h('option', { value: '__cur', text: cur, selected: true }));
    if (mine.length) kids.push(h('optgroup', { label: 'Yours' }, mine.map((p) => h('option', { value: 'u:' + p.id, text: p.name, selected: known && p.name === cur }))));
    kids.push(h('optgroup', { label: 'Built in' }, PRESETS.map((p) => h('option', { value: 'p:' + p.id, text: p.name, selected: p.name === cur && !mine.some((m) => m.name === cur) }))));
    sel.replaceChildren(...kids);
  };
  sel.addEventListener('change', () => {
    const v = sel.value; if (v === '__cur') return;
    const g = v.startsWith('u:') ? (userPresets().find((p) => p.id === v.slice(2)) || {}).graph : (PRESETS.find((p) => p.id === v.slice(2)) || { make: () => null }).make();
    if (g) openGraph(g); fill();
  });
  bus.on('presets', fill); bus.on('graph', fill); fill();
  return sel;
}

/* ---------- effect card (used in the inspector and the Effects page) ---------- */
function fxCard(n) {
  const t = NODE_TYPES[n.type], inst = S.engine && S.engine.get(n.id), core = inst && inst.core;
  const sw = makeSwitch(isOn(n), () => togglePower(n), 'Enable ' + n.name);
  const card = h('div', { class: 'fxcard' + (isOn(n) ? '' : ' off') + (S.sel.nodes.has(n.id) ? ' sel' : ''), style: { '--nc': n.color }, dataset: { id: n.id } });
  card.append(h('div', { class: 'fxh', onclick: () => selectNodes([n.id]) }, h('span', { class: 'fxi', html: icon(n.icon, 22) }), h('div', { class: 'fxt' }, h('b', { text: n.name }), n.name !== t.title ? h('small', { text: t.title }) : null), sw));
  const body = h('div', { class: 'fxb' });
  const keys = n.pins.length ? n.pins : t.params.filter((d) => d.t === 'range').slice(0, 3).map((d) => d.k);
  (n.type === 'fx.eq' ? [] : keys).map((k) => t.params.find((p) => p.k === k)).filter((d) => d && d.t === 'range').slice(0, 4).forEach((d) => {
    const val = h('span', { class: 'v mono', text: fmtParam(d, n.params[d.k]) });
    const rng = makeRange(d, n.params[d.k], { color: n.color, label: d.label, onInput: (v) => { val.textContent = fmtParam(d, v); setParam(n, d.k, v); }, onCommit: () => commit() });
    body.append(h('div', { class: 'crow' }, h('span', { class: 'l', text: d.label, title: d.label }), rng, val));
  });
  if (n.type === 'fx.eq' && core && core.response) body.append(Inspector.prototype.eqWidget.call({}, n, core));
  if (body.children.length) card.append(body);
  return card;
}

/* ================= right panel of the mixer ================= */
class MixInspector extends Inspector {
  nodeView(n) {
    this.nodeId = n.id;
    const t = NODE_TYPES[n.type], inst = S.engine && S.engine.get(n.id), core = inst && inst.core;
    if (!['effects', 'device', 'advanced'].includes(this.tab)) this.tab = 'effects';
    const out = [h('div', { class: 'selh', style: { '--nc': n.color } }, h('span', { class: 'sic', html: icon(n.icon, 22) }), h('b', null, h('span', { text: 'Selected: ' }), n.name), h('span', { class: 'grow' }),
      h('button', { class: 'ibtn', 'aria-label': 'Close', title: 'Deselect', html: icon('x', 18), onclick: () => selectNodes([]) })),
    h('div', { class: 'itabs', role: 'tablist' }, [['effects', 'Effects'], ['device', 'Device'], ['advanced', 'Advanced']].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(this.tab === k), onclick: () => { this.tab = k; this.render(); } }, l)))];
    if (core && core.error) out.push(h('div', { class: 'isec', style: { paddingBottom: 0, borderBottom: 0 } }, h('div', { class: 'errbox' }, h('span', { html: icon('alert', 18) }), h('span', null, core.error, core.actions && core.actions.retry ? h('span', null, ' ', h('a', { href: '#', style: { color: '#fff', textDecoration: 'underline' }, onclick: (ev) => { ev.preventDefault(); core.error = null; core.actions.retry(); } }, 'Try again')) : null))));
    if (this.tab === 'effects') {
      const cards = fxOf(n), canAdd = !!t.out;
      const wrap = h('div', { class: 'fxlist' }, cards.map(fxCard));
      if (!cards.length) wrap.append(h('div', { class: 'empty', text: canAdd ? 'No effects yet. Add one to clean up or shape this sound.' : 'Effects live on the way in. Select a source to see its effects.' }));
      if (canAdd) { const last = cards.length ? cards[cards.length - 1] : n; wrap.append(h('button', { class: 'addfx', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, Math.max(70, r.top - 330), { from: last.id, world: { x: last.x + NODE_W + 36, y: last.y + 30 } }); } }, h('span', { html: icon('plus', 16) }), 'Add effect')); }
      out.push(wrap);
    } else if (this.tab === 'device') out.push(...this.settings(n, t, core, h('span')));
    else {
      out.push(...this.look(n, t));
      out.push(h('div', { class: 'isec' }, h('div', { class: 'h-sec', text: 'Notes' }), (() => { const ta = h('textarea', { placeholder: 'What is this for?', style: { height: '90px' } }); ta.value = n.notes || ''; ta.addEventListener('keydown', (e) => e.stopPropagation()); ta.addEventListener('change', () => { n.notes = ta.value; commit(); }); return ta; })()));
      out.push(this.footer(n, t));
    }
    return out;
  }
}

/* ================= the dashboard ================= */
class MixView {
  constructor(root) {
    this.root = root; this.rows = new Map(); this.strips = new Map(); this.sig = ''; this.wp = []; this.tk = 0;
    Object.assign(root.style, { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 });
    this.srcList = h('div', { class: 'mlist' }); this.dstList = h('div', { class: 'mlist' });
    this.srcN = h('span'); this.dstN = h('span');
    const add = (kind) => h('button', { class: 'btn sm', onclick: (e) => this.addMenu(kind, e.currentTarget) }, h('span', { html: icon('plus', 14) }), 'Add');
    this.srcPanel = h('section', { class: 'mpanel' }, h('div', { class: 'mph' }, h('b', null, 'Sources (', this.srcN, ')'), add('source')), this.srcList);
    this.dstPanel = h('section', { class: 'mpanel' }, h('div', { class: 'mph' }, h('b', null, 'Destinations (', this.dstN, ')'), add('out')), this.dstList);
    this.dot = h('span', { class: 'sdot' }); this.estate = h('span');
    this.chips = h('div', { class: 'chips' });
    this.engine = h('section', { class: 'engine', 'aria-label': 'Eddy Engine' }, h('div', { class: 'eh' }, h('span', { html: WAVE(44) }), h('div', null, h('b', { text: 'Eddy Engine' }), h('div', { class: 'es' }, this.dot, this.estate))), this.chips);
    this.wires = document.createElementNS(SVGNS, 'svg'); this.wires.setAttribute('class', 'wires');
    this.flow = h('div', { class: 'mflow' }, this.wires, this.srcPanel, this.engine, this.dstPanel);
    this.mixStrips = h('div', { class: 'mstrips' }); this.busStrips = h('div', { class: 'mstrips' });
    const busAdd = h('button', { class: 'ibtn', title: 'Add a mix bus', 'aria-label': 'Add a mix bus', html: icon('plus', 18), onclick: () => this.addBus() });
    this.bottom = h('div', { class: 'mbottom' }, h('section', { class: 'mpanel' }, h('div', { class: 'mph' }, h('b', { text: 'Mixer' })), this.mixStrips), h('section', { class: 'mpanel' }, h('div', { class: 'mph' }, h('b', { text: 'Mix Buses' }), busAdd), this.busStrips));
    const main = h('div', { class: 'mixc' }, h('div', { class: 'mhead' }, h('span', { class: 'mlogo', html: icon('wave', 34) }), h('div', null, h('h1', { text: 'What do you want to hear and who should hear it?' }), h('p', { text: 'Mix your audio, clean it up, and send the right mix to each output.' }))), this.flow, this.bottom);
    // footer bar
    this.autoSw = makeSwitch(S.autoSave !== false, (v) => { S.autoSave = v; try { localStorage.setItem('eddy.v1.autosave', v ? '1' : '0'); } catch (e) {} if (v) persistNow(); toast(v ? 'Changes are saved automatically.' : 'Changes are saved only when you press Save.'); }, 'Auto save');
    const sceneSel = profileSelect('Scene');
    this.foot = h('div', { class: 'mfoot' }, h('label', { class: 'scene' }, h('span', { text: 'Scene:' }), sceneSel), h('span', { class: 'asw' }, 'Auto Save', this.autoSw), h('span', { class: 'grow' }),
      h('button', { class: 'btn', title: 'Back to how this setup was when you opened it', onclick: revertSetup }, h('span', { html: icon('undo', 16) }), 'Revert'),
      h('button', { class: 'btn primary', onclick: saveProfile }, h('span', { html: icon('save', 16) }), 'Save'));
    root.append(main, this.foot);
    bus.on('graph', () => this.build()); bus.on('select', () => this.paintSel()); bus.on('param', (id) => { const s = this.strips.get(id); s && s.update(); });
    bus.on('listen', () => this.listenPaint());
    new ResizeObserver(() => this.drawWires()).observe(this.flow);
    [this.srcList, this.dstList].forEach((l) => l.addEventListener('scroll', () => this.drawWires(), { passive: true }));
    ticker.add(() => this.tick());
    this.build();
  }

  ctxSource() {
    const sel = [...S.sel.nodes].map(nodeById).filter(Boolean)[0];
    return (sel && (sel.type.startsWith('source.') ? sel : upstreamSource(sel))) || S.graph.nodes.find((n) => n.type.startsWith('source.')) || null;
  }

  /* ----- add buttons ----- */
  addMenu(kind, btn) {
    const r = btn.getBoundingClientRect();
    const items = Object.values(NODE_TYPES).filter((t) => (kind === 'source' ? t.id.startsWith('source.') : t.id.startsWith('out.'))).map((t) => ({ label: t.title, icon: t.icon, run: () => this.addIO(t.id) }));
    showMenu(items, r.left - 120, r.bottom + 6);
  }
  addIO(type) {
    const g = S.graph, xs = g.nodes.map((n) => n.x), ys = g.nodes.map((n) => n.y);
    const isSrc = type.startsWith('source.');
    const n = addNode(type, isSrc ? Math.min(0, ...xs) : Math.max(0, ...xs) + 60, (ys.length ? Math.max(...ys) : 0) + 110);
    const mixes = g.nodes.filter((x) => x.type === 'fx.bus'), outs = g.nodes.filter((x) => x.type.startsWith('out.'));
    if (isSrc) { const to = mixes[0] || outs[0]; if (to) addEdge(n.id, to.id); }
    else if (mixes.length) addEdge(mixes[mixes.length - 1].id, n.id);
    commit(); selectNodes([n.id]);
  }
  addBus() { const g = S.graph, n = addNode('fx.bus', Math.max(0, ...g.nodes.map((x) => x.x)) - 60, Math.max(0, ...g.nodes.map((x) => x.y)) + 110); commit(); selectNodes([n.id]); }

  /* ----- build ----- */
  build() {
    const g = S.graph, srcs = g.nodes.filter((n) => n.type.startsWith('source.')), dsts = g.nodes.filter((n) => n.type.startsWith('out.')), buses = g.nodes.filter((n) => n.type === 'fx.bus');
    const sig = g.nodes.map((n) => [n.id, n.name, n.color, n.icon, n.mute, n.bypass].join(':')).join('|') + '#' + g.edges.map((e) => e.from + e.to).join(',');
    this.srcN.textContent = srcs.length; this.dstN.textContent = dsts.length;
    if (sig !== this.sig) {
      this.sig = sig; this.rows.clear(); this.strips.clear();
      this.srcList.replaceChildren(...(srcs.length ? srcs.map((n) => this.row(n, false)) : [h('div', { class: 'empty', text: 'No sources yet. Press Add.' })]));
      this.dstList.replaceChildren(...(dsts.length ? dsts.map((n) => this.row(n, true)) : [h('div', { class: 'empty', text: 'No outputs yet. Press Add.' })]));
      const sf = srcs.filter(hasGain), bf = [...buses, ...dsts].filter(hasGain);
      this.mixStrips.replaceChildren(...(sf.length ? sf.map((n, i) => this.strip(n, i === 0)) : [h('div', { class: 'empty', text: 'Add a source to see its fader.' })]));
      this.busStrips.replaceChildren(...(bf.length ? bf.map((n, i) => this.strip(n, i === 0)) : [h('div', { class: 'empty', text: 'No mixes yet.' })]));
    } else this.strips.forEach((s) => s.update());
    this.paintSel(); this.drawChips(); requestAnimationFrame(() => this.drawWires());
  }
  row(n, dst) {
    const t = NODE_TYPES[n.type], lv = h('i'), sub = h('small');
    const sw = makeSwitch(!n.mute, (v) => { n.mute = !v; commit(); }, (dst ? 'Enable ' : 'Hear ') + n.name);
    const el = h('div', { class: 'mrow' + (n.mute ? ' off' : ''), style: { '--nc': n.color }, dataset: { id: n.id }, onclick: () => selectNodes([n.id]) },
      h('span', { class: 'nbadge', html: icon(n.icon, 20) }), h('div', { class: 'mt' }, h('b', { text: n.name }), sub, h('div', { class: 'lvl' }, lv)), sw);
    this.rows.set(n.id, { el, lv, sub, node: n, t, dst });
    return el;
  }
  drawChips() {
    const src = this.ctxSource(), kids = [];
    this.dot.style.background = S.engine && S.engine.ctx.state === 'running' ? 'var(--green)' : 'var(--amber)';
    this.estate.textContent = S.engine && S.engine.ctx.state === 'running' ? 'Running' : 'Waiting for a click';
    if (src) {
      const fx = fxOf(src), last = chainFrom(src.id).slice(-1)[0] || src;
      fx.slice(0, 4).forEach((n) => kids.push(h('button', { class: 'echip' + (isOn(n) ? '' : ' off') + (S.sel.nodes.has(n.id) ? ' sel' : ''), style: { '--nc': n.color }, title: n.name, onclick: () => selectNodes([n.id]) }, h('span', { html: icon(n.icon, 22) }), h('span', { class: 'el', text: n.name }))));
      if (fx.length > 4) kids.push(h('button', { class: 'echip', title: fx.slice(4).map((x) => x.name).join(', '), onclick: () => selectNodes([src.id]) }, h('b', { text: '+' + (fx.length - 4) }), h('span', { class: 'el', text: 'more' })));
      if (last.type.startsWith('source.') || isFx(last)) kids.push(h('button', { class: 'echip plus', 'aria-label': 'Add effect', title: 'Add effect', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, r.bottom + 6, { from: last.id, world: { x: last.x + NODE_W + 36, y: last.y + 30 } }); } }, h('span', { html: icon('plus', 22) })));
      this.chips.replaceChildren(...kids);
    } else this.chips.replaceChildren(h('div', { class: 'empty', text: 'Add a source to start.' }));
  }

  /* ----- wires ----- */
  drawWires() {
    if (!this.flow.offsetParent) return;
    const fr = this.flow.getBoundingClientRect(), er = this.engine.getBoundingClientRect(), sp = this.srcPanel.getBoundingClientRect(), dp = this.dstPanel.getBoundingClientRect();
    this.wires.setAttribute('viewBox', '0 0 ' + fr.width + ' ' + fr.height); this.wires.replaceChildren(); this.wp = [];
    const clampY = (y, p) => Math.min(p.bottom - 16, Math.max(p.top + 50, y));
    const make = (x1, y1, x2, y2, n) => {
      const dx = Math.max(24, Math.abs(x2 - x1) * 0.55), col = n.color;
      const g = document.createElementNS(SVGNS, 'g'), p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', 'M' + x1 + ' ' + y1 + 'C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2); p.setAttribute('fill', 'none'); p.setAttribute('stroke', col); p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-width', S.sel.nodes.has(n.id) ? 3.6 : 2.4); if (n.mute) p.setAttribute('stroke-dasharray', '2 7');
      g.append(p); [[x1, y1], [x2, y2]].forEach(([x, y]) => { const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 3.6); c.setAttribute('fill', col); g.append(c); });
      this.wires.append(g); this.wp.push({ g, id: n.id, mute: n.mute });
    };
    const lay = (items, side) => items.forEach(([n, rec], i, a) => {
      const rr = rec.el.getBoundingClientRect(); if (!rr.height) return;
      const ey = er.top - fr.top + 30 + (a.length === 1 ? (er.height - 60) / 2 : (i * (er.height - 60)) / (a.length - 1));
      if (side === 'L') make(sp.right - fr.left, clampY(rr.top + rr.height / 2, sp) - fr.top, er.left - fr.left, ey, n);
      else make(er.right - fr.left, ey, dp.left - fr.left, clampY(rr.top + rr.height / 2, dp) - fr.top, n);
    });
    const all = [...this.rows.entries()].map(([id, rec]) => [rec.node, rec, rec.dst]);
    lay(all.filter((x) => !x[2]).map((x) => [x[0], x[1]]), 'L'); lay(all.filter((x) => x[2]).map((x) => [x[0], x[1]]), 'R');
  }

  /* ----- strips ----- */
  strip(n, first) {
    const mkMeter = () => h('canvas'), m1 = mkMeter(), m2 = mkMeter();
    const fi = h('i'), fb = h('b'), fader = h('div', { class: 'fader', role: 'slider', tabindex: '0', 'aria-label': n.name + ' level', 'aria-valuemin': FMIN, 'aria-valuemax': FMAX }, fi, fb);
    const dbl = h('div', { class: 'cdb mono' }), t = NODE_TYPES[n.type];
    const set = (db) => { db = clamp(db, FMIN, FMAX); setParam(n, 'gain', db <= FMIN + 0.05 ? FMIN : Math.round(db * 10) / 10); st.update(); };
    const atY = (e) => { const r = fader.getBoundingClientRect(); return FMIN + clamp(1 - (e.clientY - r.top - 6) / (r.height - 12), 0, 1) * (FMAX - FMIN); };
    fader.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fader.setPointerCapture(e.pointerId); fader.focus({ preventScroll: true }); set(atY(e)); const mv = (ev) => set(atY(ev)), up = () => { fader.removeEventListener('pointermove', mv); fader.removeEventListener('pointerup', up); commit(); }; fader.addEventListener('pointermove', mv); fader.addEventListener('pointerup', up); });
    fader.addEventListener('dblclick', () => { set(0); commit(); });
    fader.addEventListener('keydown', (e) => { const k = { ArrowUp: 1, ArrowDown: -1, ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (k) { e.preventDefault(); set(gainOf(n) + k * (e.shiftKey ? 5 : 0.5)); clearTimeout(fader._t); fader._t = setTimeout(commit, 300); } });
    const mute = h('button', { class: 'ibtn', title: 'Mute', 'aria-label': 'Mute ' + n.name, onclick: (e) => { e.stopPropagation(); n.mute = !n.mute; commit(); } });
    const ear = t.out ? h('button', { class: 'ibtn', title: 'Listen to this alone', 'aria-label': 'Listen to ' + n.name, html: icon('headphones', 18), onclick: (e) => { e.stopPropagation(); S.engine && S.engine.listen(S.engine.listenId === n.id ? null : n.id); bus.emit('listen'); } }) : null;
    const scale = first ? h('div', { class: 'scale' }, [12, 0, -12, -24, -36, -48, -60].map((d) => h('span', { text: d, style: { bottom: 'calc(6px + (100% - 12px) * ' + pctAt(d) + ')' } }))) : null;
    const el = h('div', { class: 'cs', style: { '--nc': n.color }, dataset: { id: n.id }, onclick: () => selectNodes([n.id]) },
      h('div', { class: 'csh' }, h('span', { class: 'cic', html: icon(n.icon, 20) }), h('span', { class: 'cn', text: n.name, title: n.name })),
      h('div', { class: 'cf' }, scale, h('div', { class: 'cmt' }, m1, m2), fader), dbl, h('div', { class: 'cbtn' }, ear, mute));
    const st = { el, m1, m2, ear, p1: 0, p2: 0, h1: 0, update: () => { const db = gainOf(n), p = pctAt(db); fi.style.height = 'calc((100% - 12px) * ' + p + ')'; fb.style.bottom = 'calc(6px + (100% - 12px) * ' + p + ')'; dbl.textContent = fmtDb(db) + ' dB'; fader.setAttribute('aria-valuenow', db); mute.innerHTML = icon(n.mute ? 'mute' : 'speaker', 18); mute.style.color = n.mute ? 'var(--red)' : ''; el.style.opacity = n.mute ? 0.55 : 1; }, node: n };
    this.strips.set(n.id, st); st.update(); return el;
  }
  paintSel() {
    this.rows.forEach((r, id) => r.el.classList.toggle('sel', S.sel.nodes.has(id)));
    this.strips.forEach((s, id) => s.el.classList.toggle('sel', S.sel.nodes.has(id)));
    this.drawChips(); this.listenPaint(); this.drawWires();
  }
  listenPaint() { this.strips.forEach((s, id) => s.ear && s.ear.classList.toggle('on', !!S.engine && S.engine.listenId === id)); }

  /* ----- live ----- */
  meter(cv, v, st, key) {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight; if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
    st[key] = Math.max(v, st[key] - 0.035);
    const segs = 22, sh = hh / segs;
    for (let i = 0; i < segs; i++) { const p = (i + 1) / segs, on = p <= st[key] + 0.001; g.fillStyle = on ? (p > 0.92 ? '#F87171' : p > 0.78 ? '#FBBF24' : p > 0.6 ? '#A3E635' : '#34D399') : 'rgba(255,255,255,.07)'; g.fillRect(0, hh - (i + 1) * sh + 1, w, sh - 1.5); }
  }
  tick() {
    if (!this.root.offsetParent || !S.engine) return;
    const now = performance.now(), slow = now - this.tk > 500; if (slow) this.tk = now;
    const lv = new Map();
    this.rows.forEach((r, id) => {
      const l = S.engine.level(id); if (!l) return; lv.set(id, l);
      r.lv.style.width = Math.round(dbToPct(lvDb(l.peak)) * 100) + '%';
      if (slow) { const st = S.engine.status(id); r.sub.textContent = r.t.title + (st && st.error ? ' · problem' : st && st.status ? ' · ' + st.status : ''); }
    });
    this.strips.forEach((s, id) => { const l = S.engine.level(id); if (!l) return; this.meter(s.m1, dbToPct(lvDb(l.peak)), s, 'p1'); this.meter(s.m2, dbToPct(lvDb(l.rms * 1.6)), s, 'p2'); });
    this.wp.forEach((w) => { const l = lv.get(w.id); const a = l ? Math.min(1, 0.55 + dbToPct(lvDb(l.peak)) * 0.5) : 0.5; w.g.style.opacity = w.mute ? 0.3 : a; });
  }
}

/* ================= Effects rack page ================= */
class EffectsView {
  constructor(root) { this.root = root; this.box = h('div', { class: 'page' }); root.append(this.box); bus.on('graph', () => this.render()); bus.on('devices', () => this.render()); }
  render() {
    if (!this.root.offsetParent) return;
    const srcs = S.graph.nodes.filter((n) => n.type.startsWith('source.'));
    const secs = srcs.map((s) => {
      const fx = fxOf(s), last = chainFrom(s.id).slice(-1)[0] || s;
      return h('section', { class: 'rack' }, h('div', { class: 'rackh', style: { '--nc': s.color } }, h('span', { class: 'nbadge', html: icon(s.icon, 20) }), h('b', { text: s.name }), h('span', { class: 'sub', text: fx.length + (fx.length === 1 ? ' effect' : ' effects') }), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left - 200, r.bottom + 6, { from: last.id, world: { x: last.x + NODE_W + 36, y: last.y + 30 } }); } }, h('span', { html: icon('plus', 14) }), 'Add effect')),
        fx.length ? h('div', { class: 'fxgrid' }, fx.map(fxCard)) : h('div', { class: 'empty', text: 'No effects on this source.' }));
    });
    this.box.replaceChildren(h('h1', { text: 'Effects' }), h('p', { class: 'sub', text: 'Every effect, grouped by the source it cleans up. Pin more settings from the Routing view to see them here.' }), ...(secs.length ? secs : [h('div', { class: 'empty', text: 'Add a source first.' })]));
  }
}

/* ================= settings ================= */
function showSettings() {
  const close = () => m.remove();
  const m = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', onclick: (e) => { if (e.target === m) close(); } }, h('div', { class: 'welcome', style: { textAlign: 'left', maxWidth: '520px' } },
    h('h1', { style: { fontSize: '22px', margin: '0 0 14px' }, text: 'Settings' }),
    h('div', { class: 'prm', style: { marginBottom: '14px' } }, h('span', { class: 'name', text: 'Save changes automatically' }), makeSwitch(S.autoSave !== false, (v) => { S.autoSave = v; try { localStorage.setItem('eddy.v1.autosave', v ? '1' : '0'); } catch (e) {} v && persistNow(); UI.mixer.autoSw.setValue(v); }, 'Auto save')),
    h('div', { class: 'row', style: { justifyContent: 'flex-start', flexWrap: 'wrap', margin: '0 0 14px' } },
      h('button', { class: 'btn', onclick: () => { close(); showWelcome(true); } }, h('span', { html: icon('wand', 16) }), 'Quick start'),
      h('button', { class: 'btn', onclick: exportSetup }, h('span', { html: icon('download', 16) }), 'Export setup'),
      h('button', { class: 'btn', onclick: importSetup }, h('span', { html: icon('upload', 16) }), 'Import setup'),
      h('button', { class: 'btn danger', onclick: () => { if (confirm('Erase all your setups, saved nodes and backups from this browser?')) { try { Object.keys(localStorage).filter((k) => k.startsWith('eddy.')).forEach((k) => localStorage.removeItem(k)); } catch (e) {} location.reload(); } } }, h('span', { html: icon('trash', 16) }), 'Erase everything')),
    h('p', { class: 'fine', style: { textAlign: 'left' }, text: 'Eddy web build 0.2. Everything stays in this browser. Nothing is uploaded.' }),
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: close }, 'Done'))));
  document.body.append(m); m.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }); m.querySelector('button.btn').focus();
}
