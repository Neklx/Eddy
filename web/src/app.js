/* App shell: top bar, tabs, keyboard shortcuts, audio start-up and repair. */
const LOGO_OLD = '<svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 18c4-9 14-12 21-6 4 4 2 10-3 11-4 1-7-2-6-5 1-3 5-3 6-1" stroke="#A78BFA" stroke-width="2.2" stroke-linecap="round"/><path d="M6 24c5 3 12 2 17-2" stroke="#5B6190" stroke-width="2.2" stroke-linecap="round"/></svg>';
const TABS = [['mixer', 'Mixer', 'sliders'], ['graph', 'Routing', 'route'], ['effects', 'Effects', 'wand'], ['presets', 'Presets', 'layers']];
const NAV = [['quick', 'Quick Start', 'bolt'], ['mixer', 'Mixer', 'sliders'], ['graph', 'Routing', 'route'], ['effects', 'Effects', 'wand'], ['presets', 'Presets', 'layers'], ['health', 'Devices', 'cpu'], ['settings', 'Settings', 'settings']];
const UI = {};

function setTab(t) {
  S.tab = t; closePop();
  Object.keys(UI.views).forEach((k) => { UI.views[k].classList.toggle('on', k === t); UI.tabs[k] && UI.tabs[k].setAttribute('aria-selected', String(k === t)); UI.nav[k] && (k === t ? UI.nav[k].setAttribute('aria-current', 'page') : UI.nav[k].removeAttribute('aria-current')); });
  requestAnimationFrame(() => {
    if (t === 'mixer' && !S.sel.nodes.size && !S.sel.edge) { const f = S.graph.nodes.find((n) => n.type.startsWith('source.')); if (f) S.sel.nodes = new Set([f.id]); }
    bus.emit('select'); UI.mixer.build(); UI.health.render(); UI.effects.render(); UI.mixer.drawWires();
    if (t === 'graph' && _editor) { _editor.sync(); if (!UI.fitted) { UI.fitted = true; _editor.fit(); } else _editor.applyView(); }
  });
  try { sessionStorage.setItem('eddy.tab', t); } catch (e) {}
}

async function startAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  S.sinkOK = typeof ctx.setSinkId === 'function' || 'setSinkId' in HTMLMediaElement.prototype;
  const eng = new Engine(ctx, { toast: (m) => toast(m) });
  await eng.ready.then(() => { eng.workletsOK = true; }).catch((e) => { toast('Noise filters could not start: ' + e.message, 'err'); });
  S.engine = eng;
  eng.sync(S.graph);
  ctx.addEventListener('statechange', paintStatus);
  return eng;
}

/* rebuild the whole audio engine (fixes a stuck device or context) */
async function repairAudio() {
  const old = S.engine;
  if (old) { try { old.dispose(); await old.ctx.close(); } catch (e) {} }
  S.engine = null;
  await startAudio();
  await refreshDevices();
  bus.emit('graph'); paintStatus();
  toast('Audio engine restarted.');
}

function paintStatus() {
  const ctx = S.engine && S.engine.ctx, run = ctx && ctx.state === 'running';
  UI.dot.style.background = run ? 'var(--green)' : 'var(--amber)';
  UI.state.textContent = run ? 'Running' : ctx ? 'waiting, click anywhere' : 'starting…';
  UI.lat.textContent = S.engine ? Math.max(1, Math.round(S.engine.latencyMs())) + ' ms' : '–';
  UI.sr.textContent = ctx ? '· ' + (ctx.sampleRate / 1000).toFixed(ctx.sampleRate % 1000 ? 1 : 0) + ' kHz' : '';
  UI.nodes.textContent = S.graph.nodes.length;
  const mics = S.graph.nodes.filter((n) => n.type === 'source.mic'), live = mics.length && mics.every((n) => !n.mute);
  UI.mute.setAttribute('aria-pressed', String(!!mics.length && !live));
  UI.mute.classList.toggle('muted', !!mics.length && !live);
  UI.mute.querySelector('.t').textContent = !mics.length ? 'No microphone' : live ? 'Mic live' : 'Mic muted';
  UI.mute.querySelector('.i').innerHTML = icon(!mics.length || live ? 'mic' : 'mute', 17);
  UI.mute.disabled = !mics.length;
  const l = S.engine && S.engine.listenId, n = l && nodeById(l);
  UI.listen.style.display = n ? '' : 'none'; if (n) UI.listen.querySelector('.t').textContent = 'Listening to ' + n.name;
}

function toggleMicMute() {
  const mics = S.graph.nodes.filter((n) => n.type === 'source.mic'); if (!mics.length) return;
  const mute = mics.every((n) => !n.mute); mics.forEach((n) => (n.mute = mute)); commit();
  toast(mute ? 'Microphone muted' : 'Microphone live');
}

function buildShell() {
  UI.tabs = {}; UI.views = {}; UI.nav = {};
  const tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Main' }, TABS.map(([k, l, ic]) => (UI.tabs[k] = h('button', { class: 'tab', role: 'tab', 'aria-selected': 'false', onclick: () => setTab(k) }, h('span', { html: icon(ic, 18) }), l))));
  UI.dot = h('span', { class: 'sdot' }); UI.state = h('b'); UI.lat = h('b', { class: 'mono' }); UI.sr = h('span'); UI.nodes = h('b', { class: 'mono' });
  UI.lvbar = h('i'); UI.lvpct = h('b', { class: 'mono', text: '' });
  UI.mute = h('button', { class: 'btn', onclick: toggleMicMute, title: 'Mute or unmute the microphone (M)' }, h('span', { class: 'i' }), h('span', { class: 't' }));
  UI.listen = h('button', { class: 'btn primary sm', title: 'Stop listening', style: { display: 'none' }, onclick: () => { S.engine.listen(null); bus.emit('listen'); paintStatus(); } }, h('span', { html: icon('ear', 15) }), h('span', { class: 't' }), h('span', { html: icon('x', 14) }));
  const top = h('header', { class: 'top' }, tabs, h('span', { class: 'grow' }), UI.listen,
    h('div', { class: 'chip', title: 'Loudest output right now' }, 'Level', h('span', { class: 'bar' }, UI.lvbar)), h('div', { class: 'chip' }, 'Delay ', UI.lat), UI.mute,
    h('button', { class: 'ibtn', title: 'Help and shortcuts', 'aria-label': 'Help', html: icon('help', 20), onclick: () => setTab('health') }),
    h('button', { class: 'ibtn', title: 'Settings', 'aria-label': 'Settings', html: icon('settings', 20), onclick: showSettings }));
  const brand = h('div', { class: 'brand', html: WAVE(46) + '<span>Eddy</span>' });

  UI.profSel = profileSelect('Profile');
  const kebab = h('button', { class: 'ibtn', title: 'Profile actions', 'aria-label': 'Profile actions', html: icon('chevronDown', 18), onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu([{ label: 'Save as profile', icon: 'save', run: saveProfile }, { label: 'Export setup', icon: 'download', run: exportSetup }, { label: 'Import setup…', icon: 'upload', run: importSetup }, '-', { label: 'Revert to how it opened', icon: 'undo', run: revertSetup }], r.left, r.bottom + 6); } });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' }, h('div', { class: 'navl', text: 'Profiles' }), h('div', { class: 'prof' }, h('span', { class: 'pi', html: icon('gamepad', 18) }), UI.profSel, kebab),
    h('div', { class: 'nitems' }, NAV.map(([k, l, ic]) => { const b = h('button', { class: 'nitem', onclick: () => (k === 'quick' ? showWelcome(true) : k === 'settings' ? showSettings() : setTab(k)) }, h('span', { html: icon(ic, 20) }), h('span', { class: 'nl', text: l })); UI.nav[k] = b; return b; })),
    h('span', { class: 'grow' }), h('div', { class: 'nfoot' }, h('div', { class: 'ne' }, UI.dot, h('b', null, 'Engine ', UI.state)), h('small', { text: 'Eddy web build 0.2' }), h('small', null, 'Audio: Web Audio ', UI.sr)));

  const mk = (cls, ...kids) => h('main', { class: 'view ' + cls, role: 'tabpanel' }, ...kids);
  const mixc = h('section', { style: { minWidth: 0, minHeight: 0 } }), insp1 = h('aside', { class: 'insp', 'aria-label': 'Inspector' });
  UI.views.mixer = mk('v-mixer', mixc, insp1);
  const side2 = h('aside', { class: 'side', 'aria-label': 'Nodes' }), gw = h('section', { class: 'gwrap' }), insp2 = h('aside', { class: 'insp', 'aria-label': 'Inspector' });
  UI.views.graph = mk('v-graph', side2, gw, insp2);
  const ef = h('section', { class: 'pagewrap' }), pr = h('section', { class: 'pagewrap' }), he = h('section', { class: 'pagewrap' });
  UI.views.effects = mk('v-page', ef); UI.views.presets = mk('v-page', pr); UI.views.health = mk('v-page', he);
  const app = h('div', { class: 'app' }, brand, top, nav, h('div', { class: 'stage' }, Object.values(UI.views)));
  document.body.replaceChildren(app);
  UI.mixer = new MixView(mixc); UI.insp1 = new MixInspector(insp1);
  UI.palette = new Palette(side2); UI.editor = new Editor(gw); UI.insp2 = new Inspector(insp2);
  UI.effects = new EffectsView(ef); UI.presets = new Presets(pr); UI.health = new Health(he);
}

function shortcuts() {
  addEventListener('keydown', (e) => {
    const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing || document.querySelector('.modal')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); }
    else if (mod && k === 'c') { copySelection(); }
    else if (mod && k === 'v') { pasteClipboard(); }
    else if (mod && k === 'a' && S.tab === 'graph') { e.preventDefault(); selectNodes(S.graph.nodes.map((n) => n.id)); }
    else if ((k === 'delete' || k === 'backspace') && (S.tab === 'graph')) { e.preventDefault(); deleteSelection(); }
    else if (k === 'escape') { selectNodes([]); }
    else if (!mod && k === 'f' && S.tab === 'graph') { UI.editor.fit(); }
    else if (!mod && k === 'm') { toggleMicMute(); }
  });
}

async function boot() {
  buildShell();
  shortcuts();
  bus.on('graph', () => { engineSync(); paintStatus(); });
  bus.on('listen', paintStatus);
  bus.on('select', paintStatus);
  const wake = () => { S.engine && S.engine.ctx.state === 'suspended' && S.engine.ctx.resume().then(paintStatus); };
  addEventListener('pointerdown', wake, true); addEventListener('keydown', wake, true);
  try { S.autoSave = localStorage.getItem('eddy.v1.autosave') !== '0'; } catch (e) {}
  const saved = readSaved();
  if (saved && saved.nodes.length) { loadGraph(saved); S.baseline = clone(saved); }
  else { loadGraph({ name: 'Untitled', nodes: [], edges: [] }); }
  let tab = 'mixer'; try { tab = sessionStorage.getItem('eddy.tab') || 'mixer'; } catch (e) {}
  setTab(UI.views[tab] ? tab : 'mixer');
  try { await startAudio(); } catch (e) { toast('Audio could not start: ' + e.message, 'err'); }
  refreshDevices(); navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  setInterval(paintStatus, 1500); paintStatus();
  ticker.add(() => { if (!S.engine) return; let pk = 0; S.graph.nodes.forEach((n) => { if (n.type.startsWith('out.')) { const l = S.engine.level(n.id); l && (pk = Math.max(pk, l.peak)); } }); UI.lvbar.style.width = Math.round(dbToPct(lvDb(pk)) * 100) + '%'; });
  if (!(saved && saved.nodes.length)) showWelcome(false);
  /* Inside the Windows app: tray menu and the global hotkey send this event */
  try { const T = window.__TAURI__; if (T && T.event) T.event.listen('toggle-mic', () => toggleMicMute()); } catch (e) {}
  window.__eddy = { S, bus, UI, Engine, PRESETS, openGraph, setTab };
}
boot();
