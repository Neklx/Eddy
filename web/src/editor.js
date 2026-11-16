/* The node graph editor: pan/zoom canvas, draggable nodes, wires, minimap, search-to-add,
   context menus, and per-node customisation (name, colour, icon, pinned controls). */
function engineSync() { if (S.engine) S.engine.sync(S.graph); if (S.native) S.native.sync(S.graph); }
function selectNodes(ids, edge = null) { S.sel.nodes = new Set(ids); S.sel.edge = edge; bus.emit('select'); }
function setParam(node, k, v) { node.params[k] = v; engineSync(); bus.emit('param', node.id); }
function powerKind(n) { const t = NODE_TYPES[n.type]; return t.in && t.out ? 'bypass' : 'mute'; }
function isOn(n) { return powerKind(n) === 'bypass' ? !n.bypass : !n.mute; }
function togglePower(n) { if (powerKind(n) === 'bypass') n.bypass = !n.bypass; else n.mute = !n.mute; commit(); }
const gainDb = (g) => (g <= 0.0001 ? '-inf' : (20 * Math.log10(g)).toFixed(g === 1 ? 0 : 1));

function typesFor(filter) {
  const list = [];
  CATEGORIES.forEach((c) => Object.values(NODE_TYPES).filter((t) => t.cat === c && (!filter || filter(t))).forEach((t) => list.push(t)));
  return list;
}

/* search-to-add popup. ctx: { world, from, to, edge } */
function openAddMenu(cx, cy, ctx = {}) {
  const needIn = !!ctx.from, needOut = !!ctx.to;
  const all = typesFor((t) => (!needIn || t.in) && (!needOut || t.out)).map((t) => ({ t }));
  const tpls = (!ctx.edge ? nodeTemplates() : []).filter((x) => { const t = NODE_TYPES[x.node.type]; return t && (!needIn || t.in) && (!needOut || t.out); }).map((x) => ({ t: NODE_TYPES[x.node.type], tpl: x }));
  const input = h('input', { type: 'text', placeholder: 'Search nodes…', 'aria-label': 'Search nodes' });
  const list = h('div', { class: 'pop-list', role: 'listbox' });
  const wrap = h('div', null, h('div', { class: 'search' }, h('span', { html: icon('search', 16) }), input), list);
  let items = [], idx = 0;
  const choose = (it) => { closePop(); placeFromPalette(it.t.id, ctx, it.tpl ? it.tpl.node : null); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = [...tpls, ...all].filter((it) => !q || (it.tpl ? it.tpl.node.name : it.t.title).toLowerCase().includes(q) || it.t.title.toLowerCase().includes(q) || it.t.cat.toLowerCase().includes(q) || (it.t.blurb || '').toLowerCase().includes(q));
    idx = clamp(idx, 0, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length ? items.map((it, i) => {
      const name = it.tpl ? it.tpl.node.name : it.t.title, col = it.tpl ? it.tpl.node.color : it.t.color, ic = it.tpl ? it.tpl.node.icon : it.t.icon;
      return h('button', { class: 'pal-i' + (i === idx ? ' act' : ''), role: 'option', style: { '--nc': col }, onclick: () => choose(it), onmousemove: () => { idx = i; list.querySelectorAll('.pal-i').forEach((b, k) => b.classList.toggle('act', k === i)); } },
        h('span', { class: 'nbadge', html: icon(ic, 18) }), h('span', null, h('b', { text: name + (it.tpl ? '  (saved)' : '') }), h('span', { text: it.t.cat })));
    }) : [h('div', { class: 'empty', text: 'Nothing matches “' + input.value + '”' })]));
    const a = list.querySelector('.act'); a && a.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { idx = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[idx]) choose(items[idx]);
  });
  draw();
  showPop(wrap, cx, cy);
  input.focus();
}

function placeFromPalette(type, ctx = {}, tplNode = null) {
  const w = ctx.world || viewCenterWorld();
  const over = tplNode ? (({ id, x, y, ...rest }) => clone(rest))(tplNode) : {};
  if (ctx.edge) { const n = insertOnEdge(ctx.edge, type); if (n) { if (tplNode) Object.assign(n, over, { id: n.id, x: n.x, y: n.y }); commit(); selectNodes([n.id]); } return n; }
  let x = w.x - NODE_W / 2, y = w.y - 30;
  if (ctx.from) { x = w.x + 24; }
  if (ctx.to) { x = w.x - NODE_W - 24; }
  const n = addNode(type, Math.round(x / 12) * 12, Math.round(y / 12) * 12, over);
  if (ctx.from) { const r = addEdge(ctx.from, n.id); if (r.error) toast(r.error, 'err'); }
  if (ctx.to) { const r = addEdge(n.id, ctx.to); if (r.error) toast(r.error, 'err'); }
  commit(); selectNodes([n.id]);
  return n;
}
let _editor = null;
function viewCenterWorld() { return _editor ? _editor.centerWorld() : { x: 200, y: 200 }; }

class Editor {
  constructor(root) {
    _editor = this;
    this.root = root; this.els = new Map(); this.edgeEls = new Map(); this.chips = new Map(); this.sizes = new Map(); this.vizData = new Uint8Array(1024);
    this.canvas = h('div', { class: 'gcanvas', tabindex: '-1' });
    this.layer = h('div', { class: 'glayer' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.setAttribute('class', 'gedges');
    this.defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); this.svg.append(this.defs);
    this.tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path'); this.tmp.setAttribute('class', 'ewire'); this.tmp.setAttribute('stroke', '#A78BFA'); this.tmp.style.display = 'none'; this.tmp.setAttribute('fill', 'none'); this.tmp.style.opacity = 1; this.svg.append(this.tmp);
    this.layer.append(this.svg); this.canvas.append(this.layer);
    this.tool = this.buildToolbar(); this.zoomc = this.buildZoom();
    this.hint = h('div', { class: 'ghint' }, h('span', null, 'Drag from a dot to connect'), h('span', null, 'Double-click to add'), h('span', null, 'Scroll to zoom'));
    root.append(this.canvas, this.tool, this.zoomc, this.hint);
    this.bind();
    bus.on('graph', () => this.sync());
    bus.on('select', () => this.paintSelection());
    bus.on('param', (id) => this.updateValues(id));
    bus.on('listen', () => this.sync());
    ticker.add(() => this.tick());
    this.sync(); this.applyView();
  }

  centerWorld() { const r = this.canvas.getBoundingClientRect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }
  toWorld(cx, cy) { const r = this.canvas.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.zoom, y: (cy - r.top - S.view.y) / S.view.zoom }; }
  applyView() {
    const v = S.view;
    this.layer.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.zoom + ')';
    this.canvas.style.setProperty('--gs', 24 * v.zoom + 'px');
    this.canvas.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
    this.zoomLbl.textContent = Math.round(v.zoom * 100) + '%';
    this.drawMinimap();
  }

  buildToolbar() {
    const b = (ic, tip, fn, id) => h('button', { class: 'ibtn', title: tip, 'aria-label': tip, id, html: icon(ic, 18), onclick: fn });
    this.undoB = b('undo', 'Undo (Ctrl+Z)', () => undo()); this.redoB = b('redo', 'Redo (Ctrl+Y)', () => redo());
    this.snapB = b('grid', 'Snap to grid', () => { S.snap = !S.snap; this.snapB.classList.toggle('on', S.snap); });
    this.snapB.innerHTML = '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/></svg>';
    S.snap = true; this.snapB.classList.add('on');
    return h('div', { class: 'gtool', role: 'toolbar', 'aria-label': 'Graph tools' },
      this.undoB, this.redoB, h('span', { class: 'sep' }),
      b('plus', 'Add node (double-click the canvas)', (e) => { const r = e.currentTarget.getBoundingClientRect(); openAddMenu(r.left, r.bottom + 8, { world: this.centerWorld() }); }),
      b('layout', 'Tidy up layout', () => { autoLayout(); commit(); this.fit(); }),
      b('fit', 'Fit everything in view (F)', () => this.fit()),
      this.snapB, h('span', { class: 'sep' }),
      b('trash', 'Delete selection (Del)', () => deleteSelection()));
  }
  buildZoom() {
    this.mm = h('div', { class: 'minimap' }, h('canvas'));
    this.mmc = this.mm.firstChild;
    this.zoomLbl = h('span', { class: 'mono', style: { minWidth: '44px', textAlign: 'center', color: 'var(--txt2)' }, text: '80%' });
    const zb = (t, d) => h('button', { class: 'ibtn', 'aria-label': t, title: t, html: icon(d > 0 ? 'plus' : 'x', 16), onclick: () => this.zoomBy(d > 0 ? 1.2 : 1 / 1.2) });
    zb('Zoom in', 1).innerHTML = icon('plus', 16);
    const zout = h('button', { class: 'ibtn', 'aria-label': 'Zoom out', title: 'Zoom out', html: '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 12h14"/></svg>', onclick: () => this.zoomBy(1 / 1.2) });
    const zin = h('button', { class: 'ibtn', 'aria-label': 'Zoom in', title: 'Zoom in', html: icon('plus', 16), onclick: () => this.zoomBy(1.2) });
    const row = h('div', { class: 'gtool', style: { position: 'static', transform: 'none', padding: '3px' } }, zout, this.zoomLbl, zin);
    return h('div', { class: 'zoomc' }, this.mm, row);
  }

  zoomBy(f, cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const px = cx == null ? r.width / 2 : cx - r.left, py = cy == null ? r.height / 2 : cy - r.top;
    const z = clamp(S.view.zoom * f, 0.2, 1.8), k = z / S.view.zoom;
    S.view.x = px - (px - S.view.x) * k; S.view.y = py - (py - S.view.y) * k; S.view.zoom = z; this.applyView();
  }
  bounds(ids) {
    const ns = S.graph.nodes.filter((n) => !ids || ids.has(n.id)); if (!ns.length) return null;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    ns.forEach((n) => { const hh = this.sizes.get(n.id) || nodeHeight(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + hh); });
    return { x0, y0, x1, y1 };
  }
  fit() {
    const b = this.bounds(); const r = this.canvas.getBoundingClientRect();
    if (!b || !r.width) return;
    const z = clamp(Math.min((r.width - 120) / (b.x1 - b.x0), (r.height - 190) / (b.y1 - b.y0)), 0.25, 1.1);
    S.view.zoom = z; S.view.x = (r.width - (b.x1 - b.x0) * z) / 2 - b.x0 * z; S.view.y = (r.height - (b.y1 - b.y0) * z) / 2 - b.y0 * z + 24;
    this.applyView();
  }
  focusNode(id) { const n = nodeById(id); if (!n) return; const r = this.canvas.getBoundingClientRect(); S.view.x = r.width / 2 - (n.x + NODE_W / 2) * S.view.zoom; S.view.y = r.height / 2 - (n.y + 40) * S.view.zoom; this.applyView(); }

  /* ---------- rendering ---------- */
  sync() {
    const ids = new Set(S.graph.nodes.map((n) => n.id));
    for (const [id, el] of this.els) if (!ids.has(id)) { el.remove(); this.els.delete(id); this.sizes.delete(id); }
    S.graph.nodes.forEach((n) => { let el = this.els.get(n.id); if (!el) { el = this.buildNode(n); this.els.set(n.id, el); this.layer.append(el); } this.updateNode(n, el); });
    const eids = new Set(S.graph.edges.map((e) => e.id));
    for (const [id, g] of this.edgeEls) if (!eids.has(id)) { g.g.remove(); g.grad.remove(); this.edgeEls.delete(id); const c = this.chips.get(id); c && c.remove(); this.chips.delete(id); }
    S.graph.edges.forEach((e) => { if (!this.edgeEls.has(e.id)) this.buildEdge(e); });
    this.sizes.forEach((_, id) => { const el = this.els.get(id); if (el) this.sizes.set(id, el.offsetHeight); });
    S.graph.nodes.forEach((n) => { const el = this.els.get(n.id); if (el) this.sizes.set(n.id, el.offsetHeight); });
    this.drawEdges(); this.paintSelection(); this.drawMinimap();
    this.undoB.disabled = !S.past.length; this.redoB.disabled = !S.future.length;
  }

  buildNode(n) {
    const el = h('div', { class: 'node', dataset: { id: n.id }, role: 'group' });
    el.append(h('span', { class: 'port in', dataset: { side: 'in' }, title: 'Input: drag a wire here' }), h('span', { class: 'port out', dataset: { side: 'out' }, title: 'Output: drag to connect' }));
    return el;
  }
  updateNode(n, el) {
    const t = NODE_TYPES[n.type];
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.setProperty('--nc', n.color);
    el.classList.toggle('bypassed', !!n.bypass); el.classList.toggle('muted', !!n.mute);
    el.setAttribute('aria-label', n.name + ', ' + t.title);
    el.querySelector('.port.in').style.display = t.in ? '' : 'none';
    el.querySelector('.port.out').style.display = t.out ? '' : 'none';
    const sig = [n.collapsed, n.pins.join(','), n.type, n.name, n.icon, n.bypass, n.mute, S.engine && S.engine.listenId === n.id].join('|');
    if (el._sig === sig) { this.updateValues(n.id); return; }
    el._sig = sig;
    el.querySelectorAll('.nh,.nbody').forEach((x) => x.remove());
    const pow = h('button', { class: 'npow' + (isOn(n) ? ' on' : ''), title: powerKind(n) === 'bypass' ? (n.bypass ? 'Bypassed: click to turn on' : 'On: click to bypass') : (n.mute ? 'Muted: click to unmute' : 'Click to mute'), 'aria-label': (powerKind(n) === 'bypass' ? 'Bypass ' : 'Mute ') + n.name, 'aria-pressed': String(isOn(n)), html: icon(powerKind(n) === 'mute' && n.mute ? 'mute' : 'power', 16), 'data-nodrag': '' });
    pow.addEventListener('pointerdown', (e) => e.stopPropagation());
    pow.addEventListener('click', (e) => { e.stopPropagation(); togglePower(n); });
    const head = h('div', { class: 'nh' }, h('div', { class: 'nbadge', html: icon(n.icon, 19) }), h('div', { class: 'nname' }, h('b', { text: n.name }), h('span', { text: t.title })), pow);
    el.append(head);
    el._pins = [];
    if (!n.collapsed) {
      const body = h('div', { class: 'nbody' });
      const stat = h('div', { class: 'nstat idle' }, h('span', { class: 'dot' }), h('span', { class: 't' }));
      el._stat = stat;
      body.append(stat);
      if (t.out || t.in) body.append(h('div', { class: 'nmeter' }, h('i')));
      n.pins.forEach((k) => {
        const d = t.params.find((p) => p.k === k); if (!d) return;
        if (d.t === 'range') {
          const val = h('span', { class: 'v' });
          const rng = makeRange(d, n.params[k], { color: n.color, label: n.name + ' ' + d.label, onInput: (v) => { setParam(n, k, v); }, onCommit: () => commit() });
          body.append(h('div', { class: 'pinrow' }, h('span', { class: 'n', text: d.label }), val, rng));
          el._pins.push({ k, d, val, rng });
        } else if (d.t === 'toggle') {
          const sw = makeSwitch(n.params[k], (v) => { setParam(n, k, v); commit(); }, d.label);
          body.append(h('div', { class: 'pinrow' }, h('span', { class: 'n', text: d.label }), sw));
          el._pins.push({ k, d, sw });
        }
      });
      if (t.viz) { el._viz = h('canvas', { class: 'vizc' }); body.append(el._viz); }
      if (n.type === 'fx.eq') { el._eq = h('canvas', { class: 'vizc' }); body.append(el._eq); }
      el.append(body);
    }
    this.updateValues(n.id);
  }
  updateValues(id) {
    const n = nodeById(id), el = this.els.get(id); if (!n || !el) return;
    (el._pins || []).forEach((p) => { if (p.rng) { p.rng.setValue(n.params[p.k]); p.val.textContent = fmtParam(p.d, n.params[p.k]); } else if (p.sw) p.sw.setValue(n.params[p.k]); });
  }

  portPos(n, side) { return { x: side === 'out' ? n.x + NODE_W : n.x, y: n.y + 30 }; }
  edgePath(a, b) { const dx = Math.max(60, Math.abs(b.x - a.x) * 0.5); return 'M' + a.x + ' ' + a.y + ' C' + (a.x + dx) + ' ' + a.y + ' ' + (b.x - dx) + ' ' + b.y + ' ' + b.x + ' ' + b.y; }
  buildEdge(e) {
    const NS = 'http://www.w3.org/2000/svg', mk = (n, a) => { const x = document.createElementNS(NS, n); for (const k in a) x.setAttribute(k, a[k]); return x; };
    const grad = mk('linearGradient', { id: 'g-' + e.id, gradientUnits: 'userSpaceOnUse' });
    grad.append(mk('stop', { offset: '0', 'stop-color': '#fff' }), mk('stop', { offset: '1', 'stop-color': '#fff' }));
    this.defs.append(grad);
    const g = mk('g', { class: 'edge', 'data-id': e.id });
    const wire = mk('path', { class: 'ewire', stroke: 'url(#g-' + e.id + ')' }), flow = mk('path', { class: 'eflow', stroke: '#fff' }), hit = mk('path', { class: 'ehit' });
    g.append(wire, flow, hit); this.svg.insertBefore(g, this.tmp);
    hit.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); selectNodes([], e.id); });
    hit.addEventListener('contextmenu', (ev) => { ev.preventDefault(); selectNodes([], e.id); this.edgeMenu(e.id, ev.clientX, ev.clientY); });
    hit.addEventListener('dblclick', (ev) => { ev.stopPropagation(); openAddMenu(ev.clientX, ev.clientY, { edge: e.id }); });
    const chip = h('div', { class: 'emid', role: 'button', tabindex: '0', title: 'Cable level. Click to edit, double-click to insert a node' });
    chip.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    chip.addEventListener('click', () => selectNodes([], e.id));
    chip.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') selectNodes([], e.id); });
    chip.addEventListener('dblclick', (ev) => openAddMenu(ev.clientX, ev.clientY, { edge: e.id }));
    chip.addEventListener('contextmenu', (ev) => { ev.preventDefault(); selectNodes([], e.id); this.edgeMenu(e.id, ev.clientX, ev.clientY); });
    this.layer.append(chip); this.chips.set(e.id, chip);
    this.edgeEls.set(e.id, { g, wire, flow, hit, grad });
  }
  drawEdges(onlyIds) {
    S.graph.edges.forEach((e) => {
      if (onlyIds && !onlyIds.has(e.from) && !onlyIds.has(e.to)) return;
      const a = nodeById(e.from), b = nodeById(e.to), els = this.edgeEls.get(e.id); if (!a || !b || !els) return;
      const p1 = this.portPos(a, 'out'), p2 = this.portPos(b, 'in'), d = this.edgePath(p1, p2);
      els.wire.setAttribute('d', d); els.flow.setAttribute('d', d); els.hit.setAttribute('d', d);
      els.grad.setAttribute('x1', p1.x); els.grad.setAttribute('y1', p1.y); els.grad.setAttribute('x2', p2.x); els.grad.setAttribute('y2', p2.y);
      const st = els.grad.children; st[0].setAttribute('stop-color', a.color); st[1].setAttribute('stop-color', b.color); els.flow.setAttribute('stroke', a.color);
      const chip = this.chips.get(e.id);
      chip.style.left = (p1.x + p2.x) / 2 + 'px'; chip.style.top = (p1.y + p2.y) / 2 + 'px';
      chip.textContent = e.mute ? 'muted' : gainDb(e.gain) + ' dB'; chip.classList.toggle('muted', !!e.mute);
    });
  }
  paintSelection() {
    this.els.forEach((el, id) => el.classList.toggle('sel', S.sel.nodes.has(id)));
    this.edgeEls.forEach((x, id) => { x.g.classList.toggle('edge-sel', S.sel.edge === id); this.chips.get(id).classList.toggle('sel', S.sel.edge === id); });
    this.drawMinimap();
  }

  /* live level animation: meters on nodes, signal flowing along cables */
  tick() {
    if (!this.root.offsetParent || !S.engine) return;
    const lv = new Map();
    const n_of = (id) => nodeById(id);
    this.els.forEach((el, id) => {
      const l = S.engine.level(id); if (!l) return; lv.set(id, l);
      const m = el.querySelector('.nmeter i'); if (m) m.style.width = (dbToPct(lvDb(l.peak)) * 100).toFixed(1) + '%';
      if (el._stat) {
        const st = S.engine.status(id), tt = el._stat.querySelector('.t'), txt = st && st.error ? st.error : (st && st.status) || '';
        const cls = st && st.error ? 'bad' : (txt === 'idle' || txt === 'not capturing' ? 'idle' : '');
        if (tt.textContent !== txt) tt.textContent = txt; el._stat.className = 'nstat ' + cls; el._stat.style.display = txt ? '' : 'none';
        el.classList.toggle('err', !!(st && st.error));
      }
      if (el._eq) this.drawEq(el._eq, n_of(id), id);
      if (el._viz && S.engine.spectrum(id, this.vizData)) drawSpectrum(el._viz, this.vizData, getComputedStyle(el).getPropertyValue('--nc').trim() || '#2DD4BF');
    });
    S.graph.edges.forEach((e) => {
      const els = this.edgeEls.get(e.id), l = lv.get(e.from); if (!els || !l) return;
      const lvl = e.mute ? 0 : l.peak * e.gain, live = lvl > 0.004;
      els.flow.classList.toggle('live', live);
      els.wire.style.opacity = S.sel.edge === e.id ? 1 : (0.28 + Math.min(1, dbToPct(lvDb(lvl)) * 1.2) * 0.6).toFixed(2);
    });
  }

  drawEq(cv, n, id) {
    const inst = S.engine.get(id); if (!inst || !inst.core.response || !n) return;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight; if (!w) return;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hh * dpr; }
    const key = JSON.stringify(n.params) + n.color; if (cv._key === key) return; cv._key = key;
    if (!this._fr) { this._fr = new Float32Array(96); for (let i = 0; i < 96; i++) this._fr[i] = 20 * Math.pow(1000, i / 95); }
    const r = inst.core.response(this._fr), g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
    g.strokeStyle = 'rgba(255,255,255,.1)'; g.beginPath(); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
    g.beginPath(); this._fr.forEach((f, i) => { const x = i / 95 * w, y = hh / 2 - clamp(r[i], -18, 18) / 18 * (hh / 2 - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.strokeStyle = n.color; g.lineWidth = 2; g.shadowColor = n.color; g.shadowBlur = 6; g.stroke();
  }

  /* ---------- interaction ---------- */
  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
    c.addEventListener('dblclick', (e) => { if (e.target === c || e.target === this.layer || e.target.closest('.gedges') === null && !e.target.closest('.node') && !e.target.closest('.emid')) openAddMenu(e.clientX, e.clientY, { world: this.toWorld(e.clientX, e.clientY) }); });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const nodeEl = e.target.closest('.node');
      if (nodeEl) { const id = nodeEl.dataset.id; if (!S.sel.nodes.has(id)) selectNodes([id]); this.nodeMenu(id, e.clientX, e.clientY); }
      else if (!e.target.closest('.emid') && !e.target.closest('.ehit')) this.canvasMenu(e.clientX, e.clientY);
    });
    c.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/eddy-type')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    c.addEventListener('drop', (e) => {
      const type = e.dataTransfer.getData('text/eddy-type'); if (!type) return; e.preventDefault();
      const tpl = e.dataTransfer.getData('text/eddy-tpl'), tn = tpl ? (nodeTemplates().find((x) => x.id === tpl) || {}).node : null;
      placeFromPalette(type, { world: this.toWorld(e.clientX, e.clientY) }, tn);
    });
    const mmMove = (e) => { const r = this.mmc.getBoundingClientRect(), m = this.mmMap; if (!m) return; const wx = m.x0 + (e.clientX - r.left) / m.s, wy = m.y0 + (e.clientY - r.top) / m.s, cr = this.canvas.getBoundingClientRect(); S.view.x = cr.width / 2 - wx * S.view.zoom; S.view.y = cr.height / 2 - wy * S.view.zoom; this.applyView(); };
    this.mm.addEventListener('pointerdown', (e) => { this.mm.setPointerCapture(e.pointerId); mmMove(e); const mv = (ev) => mmMove(ev), up = () => { this.mm.removeEventListener('pointermove', mv); this.mm.removeEventListener('pointerup', up); }; this.mm.addEventListener('pointermove', mv); this.mm.addEventListener('pointerup', up); });
    new ResizeObserver(() => this.drawMinimap()).observe(this.mm);
  }

  down(e) {
    if (e.button === 2) return;
    const t = e.target;
    if (t.closest('[data-nodrag]') && !t.closest('.port')) return;
    const port = t.closest('.port');
    if (port) { const id = port.closest('.node').dataset.id; return this.startConnect(e, id, port.dataset.side); }
    const nodeEl = t.closest('.node');
    if (nodeEl) return this.startDrag(e, nodeEl.dataset.id);
    this.canvas.focus({ preventScroll: true });
    if (e.shiftKey) return this.startMarquee(e);
    // pan; a click without moving clears the selection
    const sx = e.clientX, sy = e.clientY, ox = S.view.x, oy = S.view.y; let moved = false;
    this.canvas.classList.add('pan');
    const mv = (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; S.view.x = ox + dx; S.view.y = oy + dy; this.applyView(); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); this.canvas.classList.remove('pan'); if (!moved) selectNodes([]); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }

  startDrag(e, id) {
    if (e.shiftKey) { const s = new Set(S.sel.nodes); s.has(id) ? s.delete(id) : s.add(id); selectNodes([...s]); }
    else if (!S.sel.nodes.has(id)) selectNodes([id]); else if (S.sel.edge) selectNodes([...S.sel.nodes]);
    const ids = [...S.sel.nodes]; if (!ids.length) return;
    const start = ids.map((i) => { const n = nodeById(i); return { n, x: n.x, y: n.y }; });
    const sx = e.clientX, sy = e.clientY; let moved = false;
    const idset = new Set(ids);
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / S.view.zoom, dy = (ev.clientY - sy) / S.view.zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3 / S.view.zoom) return;
      moved = true;
      start.forEach((s) => { let x = s.x + dx, y = s.y + dy; if (S.snap) { x = Math.round(x / 12) * 12; y = Math.round(y / 12) * 12; } s.n.x = x; s.n.y = y; const el = this.els.get(s.n.id); el.style.left = x + 'px'; el.style.top = y + 'px'; });
      this.drawEdges(idset); this.drawMinimap();
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) commit(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }

  startMarquee(e) {
    const r = this.canvas.getBoundingClientRect(), box = h('div', { class: 'marq' }); this.canvas.append(box);
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const mv = (ev) => {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      Object.assign(box.style, { left: Math.min(sx, x) + 'px', top: Math.min(sy, y) + 'px', width: Math.abs(x - sx) + 'px', height: Math.abs(y - sy) + 'px' });
      const a = this.toWorld(Math.min(sx, x) + r.left, Math.min(sy, y) + r.top), b = this.toWorld(Math.max(sx, x) + r.left, Math.max(sy, y) + r.top);
      selectNodes(S.graph.nodes.filter((n) => n.x < b.x && n.x + NODE_W > a.x && n.y < b.y && n.y + (this.sizes.get(n.id) || 80) > a.y).map((n) => n.id));
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); box.remove(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }

  startConnect(e, id, side) {
    e.preventDefault(); e.stopPropagation();
    const n = nodeById(id), start = this.portPos(n, side);
    const port = e.target.closest('.port'); port.classList.add('hot');
    this.tmp.style.display = ''; let target = null;
    const clear = () => this.els.forEach((el) => el.classList.remove('target'));
    const mv = (ev) => {
      const w = this.toWorld(ev.clientX, ev.clientY);
      this.tmp.setAttribute('d', side === 'out' ? this.edgePath(start, w) : this.edgePath(w, start));
      const el = document.elementFromPoint(ev.clientX, ev.clientY), ne = el && el.closest && el.closest('.node');
      clear(); target = null;
      if (ne && ne.dataset.id !== id) {
        const why = side === 'out' ? canConnect(id, ne.dataset.id) : canConnect(ne.dataset.id, id);
        if (!why) { target = ne.dataset.id; ne.classList.add('target'); }
      }
    };
    const up = (ev) => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      this.tmp.style.display = 'none'; clear(); port.classList.remove('hot');
      if (target) {
        const r = side === 'out' ? addEdge(id, target) : addEdge(target, id);
        if (r.error) toast(r.error, 'err'); else { commit(); selectNodes([], r.id); }
        return;
      }
      const el = document.elementFromPoint(ev.clientX, ev.clientY), ne = el && el.closest && el.closest('.node');
      if (ne && ne.dataset.id !== id) { const why = side === 'out' ? canConnect(id, ne.dataset.id) : canConnect(ne.dataset.id, id); if (why) toast(why, 'err'); return; }
      if (el && el.closest && el.closest('.gcanvas') && !ne) openAddMenu(ev.clientX, ev.clientY, { world: this.toWorld(ev.clientX, ev.clientY), from: side === 'out' ? id : null, to: side === 'in' ? id : null });
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
    mv(e);
  }

  /* ---------- menus ---------- */
  nodeMenu(id, x, y) {
    const n = nodeById(id), many = S.sel.nodes.size > 1;
    showMenu([
      { label: 'Duplicate', icon: 'copy', kbd: 'Ctrl+D', run: () => duplicateSelection() },
      { label: isOn(n) ? (powerKind(n) === 'bypass' ? 'Bypass' : 'Mute') : (powerKind(n) === 'bypass' ? 'Turn on' : 'Unmute'), icon: 'power', run: () => { S.sel.nodes.forEach((i) => togglePower(nodeById(i))); } },
      NODE_TYPES[n.type].out ? { label: S.engine && S.engine.listenId === id ? 'Stop listening' : 'Listen to this node', icon: 'ear', run: () => S.engine && S.engine.listen(S.engine.listenId === id ? null : id) } : null,
      { label: n.collapsed ? 'Expand' : 'Collapse', icon: 'chevronDown', run: () => { n.collapsed = !n.collapsed; commit(); } },
      { label: 'Save as my node', icon: 'save', run: () => { saveNodeTemplate(n); toast('Saved. Find it under “My nodes” in the node list.'); } },
      '-',
      { label: many ? 'Delete ' + S.sel.nodes.size + ' nodes' : 'Delete', icon: 'trash', kbd: 'Del', danger: true, run: () => deleteSelection() },
    ].filter(Boolean), x, y);
  }
  edgeMenu(id, x, y) {
    const e = edgeById(id);
    showMenu([
      { label: 'Insert a node here…', icon: 'plus', run: () => openAddMenu(x, y, { edge: id }) },
      { label: e.mute ? 'Unmute cable' : 'Mute cable', icon: 'mute', run: () => { e.mute = !e.mute; commit(); } },
      '-', { label: 'Remove cable', icon: 'trash', kbd: 'Del', danger: true, run: () => { removeEdge(id); commit(); } },
    ], x, y);
  }
  canvasMenu(x, y) {
    const w = this.toWorld(x, y);
    showMenu([
      { label: 'Add node…', icon: 'plus', run: () => openAddMenu(x, y, { world: w }) },
      { label: 'Paste', icon: 'copy', kbd: 'Ctrl+V', run: () => pasteClipboard(w) },
      '-', { label: 'Tidy up layout', icon: 'layout', run: () => { autoLayout(); commit(); this.fit(); } },
      { label: 'Fit everything in view', icon: 'fit', kbd: 'F', run: () => this.fit() },
    ], x, y);
  }

  drawMinimap() {
    const cv = this.mmc; if (!cv || !cv.clientWidth) return;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hgt * dpr; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hgt);
    const cr = this.canvas.getBoundingClientRect(), vx0 = -S.view.x / S.view.zoom, vy0 = -S.view.y / S.view.zoom, vx1 = vx0 + cr.width / S.view.zoom, vy1 = vy0 + cr.height / S.view.zoom;
    const b = this.bounds() || { x0: 0, y0: 0, x1: 100, y1: 100 };
    const x0 = Math.min(b.x0, vx0) - 40, y0 = Math.min(b.y0, vy0) - 40, x1 = Math.max(b.x1, vx1) + 40, y1 = Math.max(b.y1, vy1) + 40;
    const s = Math.min(w / (x1 - x0), hgt / (y1 - y0)), ox = (w - (x1 - x0) * s) / 2, oy = (hgt - (y1 - y0) * s) / 2;
    this.mmMap = { x0: x0 - ox / s, y0: y0 - oy / s, s };
    const X = (v) => (v - x0) * s + ox, Y = (v) => (v - y0) * s + oy;
    g.lineWidth = 1.2;
    S.graph.edges.forEach((e) => { const a = nodeById(e.from), bb = nodeById(e.to); if (!a || !bb) return; g.strokeStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(X(a.x + NODE_W), Y(a.y + 30)); g.lineTo(X(bb.x), Y(bb.y + 30)); g.stroke(); });
    S.graph.nodes.forEach((n) => { g.fillStyle = n.color; g.globalAlpha = S.sel.nodes.has(n.id) ? 1 : 0.7; g.beginPath(); g.roundRect ? g.roundRect(X(n.x), Y(n.y), NODE_W * s, (this.sizes.get(n.id) || 80) * s, 2) : g.rect(X(n.x), Y(n.y), NODE_W * s, 20 * s); g.fill(); });
    g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(X(vx0), Y(vy0), (vx1 - vx0) * s, (vy1 - vy0) * s);
  }
}

/* ---------- selection actions (also used by shortcuts) ---------- */
function deleteSelection() {
  if (S.sel.edge) { removeEdge(S.sel.edge); S.sel.edge = null; commit(); bus.emit('select'); return; }
  const ids = [...S.sel.nodes]; if (!ids.length) return;
  removeNodes(ids); commit(); bus.emit('select');
}
function duplicateSelection() {
  const ids = [...S.sel.nodes]; if (!ids.length) return;
  const out = duplicateNodes(ids); commit(); selectNodes(out.map((n) => n.id));
}
let clipboard = null;
function copySelection() {
  const ids = new Set(S.sel.nodes); if (!ids.size) return;
  clipboard = { nodes: clone(S.graph.nodes.filter((n) => ids.has(n.id))), edges: clone(S.graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to))) };
  toast('Copied ' + ids.size + (ids.size === 1 ? ' node' : ' nodes'));
}
function pasteClipboard(at) {
  if (!clipboard || !clipboard.nodes.length) return;
  const map = new Map(), minx = Math.min(...clipboard.nodes.map((n) => n.x)), miny = Math.min(...clipboard.nodes.map((n) => n.y));
  const p = at || { x: minx + 40, y: miny + 40 }, made = [];
  clipboard.nodes.forEach((n) => { const c = Object.assign(clone(n), { id: uid('n'), x: p.x + n.x - minx, y: p.y + n.y - miny }); map.set(n.id, c.id); S.graph.nodes.push(c); made.push(c.id); });
  clipboard.edges.forEach((e) => S.graph.edges.push(Object.assign(clone(e), { id: uid('e'), from: map.get(e.from), to: map.get(e.to) })));
  commit(); selectNodes(made);
}
