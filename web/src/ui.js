/* Small UI toolkit: DOM helper, custom range slider, popups, toasts, animation ticker. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach((c) => c != null && c !== false && el.append(c.nodeType ? c : document.createTextNode(c)));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtParam(d, v) {
  if (d.fmt) return d.fmt(v);
  if (d.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : Math.round(v) + ' Hz';
  const dec = d.step && d.step < 1 ? (d.step < 0.1 ? 2 : 1) : 0;
  return v.toFixed(dec) + (d.unit ? ' ' + d.unit : '');
}

/* value <-> 0..1 position, linear or logarithmic */
const toPos = (d, v) => (d.log ? Math.log(v / d.min) / Math.log(d.max / d.min) : (v - d.min) / (d.max - d.min));
const fromPos = (d, p) => { const v = d.log ? d.min * Math.pow(d.max / d.min, p) : d.min + p * (d.max - d.min); return d.step ? clamp(Math.round(v / d.step) * d.step, d.min, d.max) : v; };

/* A real, keyboard-accessible slider. onInput(v) while dragging, onCommit() when released. */
function makeRange(d, value, { onInput, onCommit, color, label }) {
  const el = h('div', { class: 'rng', role: 'slider', tabindex: '0', 'aria-label': label || d.label, 'aria-valuemin': d.min, 'aria-valuemax': d.max, 'data-nodrag': '' }, h('i'), h('b'));
  if (color) el.style.setProperty('--c', color);
  const set = (v) => { el.style.setProperty('--p', clamp(toPos(d, v), 0, 1)); el.setAttribute('aria-valuenow', v); el.setAttribute('aria-valuetext', fmtParam(d, v)); };
  set(value);
  const at = (e) => { const r = el.getBoundingClientRect(); return fromPos(d, clamp((e.clientX - r.left - 7) / (r.width - 14), 0, 1)); };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true });
    const v = at(e); set(v); onInput(v);
    const mv = (ev) => { const v2 = at(ev); set(v2); onInput(v2); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); onCommit && onCommit(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); set(d.def); onInput(d.def); onCommit && onCommit(); });
  el.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!k) return;
    e.preventDefault();
    const cur = +el.getAttribute('aria-valuenow'), stepv = d.step || (d.max - d.min) / 100;
    const v = clamp(d.log ? cur * Math.pow(d.max / d.min, k * 0.02) : cur + k * stepv * (e.shiftKey ? 10 : 1), d.min, d.max);
    const vv = d.step ? clamp(Math.round(v / d.step) * d.step, d.min, d.max) : v;
    set(vv); onInput(vv); onCommit && onCommit();
  });
  el.setValue = set;
  return el;
}

function makeSwitch(on, onChange, label) {
  const b = h('button', { class: 'sw', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label || 'toggle', 'data-nodrag': '' });
  b.addEventListener('click', (e) => { e.stopPropagation(); const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); });
  b.setValue = (v) => b.setAttribute('aria-checked', String(!!v));
  return b;
}

/* ---- toasts ---- */
function toast(msg, kind) {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + (kind || '') }, h('span', { html: icon(kind === 'err' ? 'alert' : 'info', 18) }), h('span', { text: msg }));
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3200);
}

/* ---- popups ---- */
let openPop = null;
function closePop() { if (openPop) { openPop.remove(); openPop = null; document.removeEventListener('pointerdown', popOutside, true); document.removeEventListener('keydown', popKey, true); } }
function popOutside(e) { if (openPop && !openPop.contains(e.target)) closePop(); }
function popKey(e) { if (e.key === 'Escape') { closePop(); e.stopPropagation(); } }
function showPop(el, x, y) {
  closePop();
  el.classList.add('pop'); document.body.append(el); openPop = el;
  const r = el.getBoundingClientRect();
  el.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
  el.style.top = clamp(y, 8, innerHeight - r.height - 8) + 'px';
  setTimeout(() => { document.addEventListener('pointerdown', popOutside, true); document.addEventListener('keydown', popKey, true); }, 0);
  return el;
}
function showMenu(items, x, y) {
  const el = h('div', { role: 'menu' }, items.map((it) => it === '-' ? h('div', { class: 'menu-sep' }) : h('button', { class: 'menu-i ' + (it.danger ? 'danger' : ''), role: 'menuitem', onclick: () => { closePop(); it.run(); } }, h('span', { html: icon(it.icon || 'chevronRight', 16) }), it.label, it.kbd ? h('span', { class: 'kbd', text: it.kbd }) : null)));
  el.style.minWidth = '210px';
  showPop(el, x, y);
  const first = el.querySelector('button'); first && first.focus();
}

/* ---- one animation loop for every live meter and scope ---- */
const ticker = { fns: new Set(), on: false, last: 0,
  add(fn) { this.fns.add(fn); if (!this.on) { this.on = true; requestAnimationFrame((t) => this.tick(t)); } return () => this.fns.delete(fn); },
  tick(t) { if (!this.fns.size) { this.on = false; return; } if (t - this.last > 30) { this.last = t; this.fns.forEach((f) => f(t)); } requestAnimationFrame((x) => this.tick(x)); } };

const dbToPct = (db) => clamp((db + 60) / 60, 0, 1);
const lvDb = (v) => 20 * Math.log10(Math.max(v, 1e-6));

function drawSpectrum(canvas, data, color, { fill = true } = {}) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (!w) return;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hgt * dpr; }
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hgt);
  const n = 64, bw = w / n;
  const grad = g.createLinearGradient(0, hgt, 0, 0); grad.addColorStop(0, color + '33'); grad.addColorStop(1, color);
  g.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const f0 = Math.pow(i / n, 2.2), f1 = Math.pow((i + 1) / n, 2.2);
    const a = Math.floor(f0 * (data.length - 1)), b = Math.max(a + 1, Math.floor(f1 * (data.length - 1)));
    let m = 0; for (let k = a; k < b; k++) m = Math.max(m, data[k]);
    const v = (m / 255) * hgt;
    g.beginPath(); g.roundRect ? g.roundRect(i * bw + 1, hgt - v, Math.max(1, bw - 2), Math.max(1, v), 1.5) : g.rect(i * bw + 1, hgt - v, bw - 2, v); g.fill();
  }
}
