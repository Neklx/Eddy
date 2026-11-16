/* Native engine bridge (desktop app only).
   The UI edits a free-form graph. The Rust engine is a fixed mixer: 5 sources, 3 destinations and
   one voice chain on the microphone. nativePlan() translates the graph into that shape and says
   what it had to leave out. nativeDiff() keeps the traffic small. NativeEngine talks to the
   engine process through Tauri commands. In a plain browser none of this is used. */

const NATIVE_SRC_NAMES = ['Microphone', 'Voice chat app', 'Music player', 'Game', 'System sound'];
const NATIVE_DST_NAMES = ['Headphones', 'Eddy Mic', 'Eddy Stream'];
const NATIVE_SRC = { 'source.mic': 0, 'source.system': 4 };
const NATIVE_FX = { 'fx.denoise': 'noise', 'fx.gate': 'gate', 'fx.eq': 'eq', 'fx.comp': 'compressor', 'fx.leveler': 'leveler' };
const NATIVE_PASS = new Set(['fx.limiter', 'viz.spectrum']); // the engine always limits its outputs
const nativeLin = (db) => Math.min(4, Math.max(0, Math.pow(10, db / 20)));
const nativeRound = (x) => Math.round(x * 1000) / 1000;
const nativeTitle = (n) => n.name || n.type;

/* Voice chat, chat and stream outputs go to the virtual microphone, everything else to headphones. */
function nativeDest(n) { return /voice|chat|mic|cable|stream/i.test(n.name || '') ? 1 : 0; }

function nativePlan(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const outs = new Map();
  graph.edges.forEach((e) => { if (!outs.has(e.from)) outs.set(e.from, []); outs.get(e.from).push(e); });
  const warn = new Set(), req = {};
  const sendGain = {}, present = {};
  let hp = null;

  const destNode = {};
  for (const n of graph.nodes) {
    if (n.type !== 'out.speakers') continue;
    const d = nativeDest(n);
    if (destNode[d]) warn.add('Two outputs lead to “' + NATIVE_DST_NAMES[d] + '”. Only the first one sets its level.');
    else destNode[d] = n;
  }

  const walk = (id, gain, src, isMic, seen) => {
    for (const e of outs.get(id) || []) {
      const n = nodes.get(e.to);
      if (!n || seen.has(n.id)) continue;
      let g = gain * (e.mute ? 0 : e.gain == null ? 1 : e.gain);
      if (n.mute) g = 0;
      if (n.type === 'out.speakers') { const k = src + ':' + nativeDest(n); sendGain[k] = (sendGain[k] || 0) + g; continue; }
      if (n.type === 'out.record') { warn.add('The recorder only works in the built-in engine.'); continue; }
      const stage = NATIVE_FX[n.type];
      if (stage) {
        if (!isMic) warn.add('Effects only work on the microphone in the native engine. “' + nativeTitle(n) + '” is skipped on other sources.');
        else if (!n.bypass && !present[stage]) present[stage] = n;
      } else if (n.type === 'fx.filter') {
        if (!isMic) warn.add('Filters only work on the microphone in the native engine.');
        else if (n.params.type !== 'highpass') warn.add('Only a high-pass filter works in the native engine. “' + nativeTitle(n) + '” is skipped.');
        else if (!n.bypass && !hp) hp = n;
      } else if (n.type === 'fx.gain' || n.type === 'fx.bus') {
        if (!n.bypass && n.params && typeof n.params.gain === 'number') g *= nativeLin(n.params.gain);
      } else if (!NATIVE_PASS.has(n.type)) {
        warn.add('“' + nativeTitle(n) + '” is not available in the native engine yet and is skipped.');
      }
      walk(n.id, g, src, isMic, new Set(seen).add(n.id));
    }
  };

  const claimed = {};
  for (const n of graph.nodes) {
    if (!n.type.startsWith('source.')) continue;
    const s = NATIVE_SRC[n.type];
    if (s === undefined) { warn.add('“' + nativeTitle(n) + '” has no native input yet. It plays only in the built-in engine.'); continue; }
    if (claimed[s]) { warn.add('Only the first ' + NATIVE_SRC_NAMES[s].toLowerCase() + ' is used.'); continue; }
    claimed[s] = n;
    req['sg:' + s] = { cmd: 'set_source_gain', src: s, gain: nativeRound(nativeLin(n.params.gain || 0)) };
    req['sm:' + s] = { cmd: 'set_source_mute', src: s, mute: !!n.mute };
    walk(n.id, 1, s, s === 0, new Set([n.id]));
  }

  const mic = (stage, key, param, v) => { req['pa:0:' + param] = { cmd: 'set_param', src: 0, param, value: nativeRound(v) }; };
  for (const stage of ['noise', 'gate', 'eq', 'compressor', 'leveler']) {
    req['st:0:' + stage] = { cmd: 'set_stage', src: 0, stage, on: !!present[stage] };
  }
  const p = (stage) => (present[stage] || {}).params || {};
  if (present.noise) mic('noise', 'strength', 'noise_strength', p('noise').strength);
  if (present.gate) { mic('gate', 'threshold', 'gate_threshold_db', p('gate').threshold); mic('gate', 'release', 'gate_release_ms', p('gate').release); }
  if (present.compressor) { mic('compressor', 'threshold', 'comp_threshold_db', p('compressor').threshold); mic('compressor', 'ratio', 'comp_ratio', p('compressor').ratio); mic('compressor', 'makeup', 'comp_makeup_db', p('compressor').makeup); }
  if (present.leveler) mic('leveler', 'target', 'leveler_target_db', p('leveler').target);
  mic('hp', 'freq', 'high_pass_hz', hp ? hp.params.freq : 20);
  if (present.eq) warn.add('The equaliser runs with its default curve in the native engine. Your band settings are not sent yet.');

  for (let d = 0; d < 3; d++) {
    const n = destNode[d];
    req['dg:' + d] = { cmd: 'set_dest_gain', dst: d, gain: nativeRound(n && n.params && typeof n.params.gain === 'number' ? nativeLin(n.params.gain) : 1) };
  }
  // every send is written, so a send left over from the engine's starting profile is switched off
  for (let s = 0; s < 5; s++) for (let d = 0; d < 3; d++) {
    req['sd:' + s + ':' + d] = { cmd: 'set_send', src: s, dst: d, gain: nativeRound(Math.min(4, sendGain[s + ':' + d] || 0)) };
  }
  if (!claimed[0]) warn.add('No microphone in this setup, so there is nothing to clean up.');
  if (!Object.keys(destNode).length) warn.add('No output device node, so nothing is sent anywhere.');
  return { req, warnings: [...warn] };
}

/* [key, request] pairs that differ from what the engine already has */
function nativeDiff(sent, next) {
  return Object.keys(next).filter((k) => JSON.stringify(sent[k]) !== JSON.stringify(next[k])).map((k) => [k, next[k]]);
}

class NativeEngine {
  constructor() {
    this.running = false; this.sent = {}; this.warnings = []; this.state = null; this.err = '';
    this.cbs = new Set(); this.timer = null; this.pollT = null; this.polling = false; this.chain = Promise.resolve(); this.latest = null;
    try { const T = window.__TAURI__; T.event.listen('engine-exit', () => { if (this.running) this.halt('The audio engine stopped unexpectedly. Press Start to run it again.'); }); } catch (e) {}
  }
  static available() { try { return !!window.__TAURI__.core.invoke; } catch (e) { return false; } }
  invoke(cmd, args) { return window.__TAURI__.core.invoke(cmd, args); }
  on(fn) { this.cbs.add(fn); return () => this.cbs.delete(fn); }
  emit() { this.cbs.forEach((f) => f(this)); }

  async devices() { return JSON.parse(await this.invoke('engine_devices')); }
  async req(obj) {
    const r = JSON.parse(await this.invoke('engine_request', { line: JSON.stringify(obj) }));
    if (!r.ok) throw new Error(r.error || 'The engine refused a command.');
    return r.data;
  }

  async start(devs, graph) {
    await this.invoke('engine_start', { mic: devs.mic || null, out: devs.out || null, virtualMic: devs.vmic || null, system: devs.system || null });
    this.running = true; this.sent = {}; this.err = ''; this.state = null;
    clearInterval(this.pollT); this.pollT = setInterval(() => this.poll(), 66);
    await this.flush(graph);
    this.emit();
  }

  halt(msg) {
    try { if (S.engine && S.engine.ctx.state === 'suspended') S.engine.ctx.resume(); } catch (e) {} // never leave the user with no sound
    this.running = false; clearInterval(this.pollT); this.pollT = null; this.state = null; this.err = msg || ''; this.emit(); }
  async stop() { this.halt(''); try { await this.invoke('engine_stop'); } catch (e) {} }

  /* called after every graph change; coalesces a burst (a slider drag) into one update */
  sync(graph) {
    if (!this.running) return;
    this.latest = graph;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(this.latest); }, 20);
  }
  flush(graph) {
    this.chain = this.chain.then(async () => {
      if (!this.running) return;
      const plan = nativePlan(graph);
      this.warnings = plan.warnings;
      for (const [k, r] of nativeDiff(this.sent, plan.req)) { await this.req(r); this.sent[k] = r; }
      this.emit();
    }).catch((e) => { this.err = e.message; this.emit(); });
    return this.chain;
  }
  async poll() {
    if (this.polling || !this.running) return;
    this.polling = true;
    try { this.state = await this.req({ cmd: 'get_state' }); this.emit(); }
    catch (e) { if (this.running) { this.err = e.message; } }
    this.polling = false;
  }
}

/* ---- the card on the Devices page ---- */
function nativeLoadDevs() { try { return JSON.parse(localStorage.getItem('eddy.native.devs') || '{}'); } catch (e) { return {}; } }
function nativeSaveDevs(d) { try { localStorage.setItem('eddy.native.devs', JSON.stringify(d)); } catch (e) {} }

class NativeCard {
  constructor() {
    this.el = h('div', { class: 'card' });
    this.devs = nativeLoadDevs(); this.list = null; this.busy = false;
    S.native.on(() => this.paint());
    this.load();
  }
  async load() {
    try { this.list = await S.native.devices(); } catch (e) { this.list = []; this.loadErr = String(e); }
    this.render();
  }
  select(label, key, render, hint) {
    const opts = (this.list || []).filter((d) => d.render === render);
    const s = h('select', { 'aria-label': label, onchange: (e) => { this.devs[key] = e.target.value || undefined; nativeSaveDevs(this.devs); } },
      h('option', { value: '', text: key === 'vmic' || key === 'system' ? 'None' : 'Windows default' }),
      opts.map((d) => h('option', { value: d.id, text: d.name + (d.default ? ' (default)' : ''), selected: this.devs[key] === d.id })));
    return h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', { text: label }), s, hint && h('small', { class: 'sub', text: hint }));
  }
  render() {
    const N = S.native;
    this.status = h('div', { class: 'sub', 'aria-live': 'polite', style: { margin: '6px 0 10px' } });
    this.meters = h('div'); this.notes = h('div');
    this.btn = h('button', { class: 'btn primary', onclick: () => this.toggle() });
    this.el.replaceChildren(
      h('div', { class: 'hh', text: 'Native engine (beta)' }),
      h('div', { style: { padding: '4px 16px 16px' } },
        h('p', { class: 'sub', text: 'Runs the audio in a separate Rust process with lower delay, so it keeps working when this window is busy. Your graph is translated to its fixed mixer, and anything it cannot do is listed below.' }),
        this.select('Microphone', 'mic', false), this.select('Headphones', 'out', true),
        this.select('Virtual microphone output', 'vmic', true, 'A cable such as “CABLE Input”. Voice apps pick the matching “CABLE Output” as their microphone.'),
        this.select('System sound (a virtual output Windows plays to)', 'system', true, 'Optional. Never the same device as your headphones.'),
        this.btn, this.status, this.meters, this.notes));
    this.paint();
  }
  async toggle() {
    const N = S.native; if (this.busy) return; this.busy = true; this.paint();
    try {
      if (N.running) { await N.stop(); if (S.engine && S.engine.ctx.state === 'suspended') S.engine.ctx.resume(); toast('Back on the built-in engine.'); }
      else {
        const d = this.devs;
        if (d.out && d.out === d.vmic) throw new Error('Headphones and the virtual microphone are the same device.');
        if (d.system && (d.system === d.out || d.system === d.vmic)) throw new Error('The system sound device must differ from the other outputs.');
        if (S.engine) await S.engine.ctx.suspend(); // one engine at a time, or you hear everything twice
        await N.start(d, S.graph);
        toast('Native engine running.');
      }
    } catch (e) {
      N.err = (e && e.message) || String(e);
      if (!N.running && S.engine && S.engine.ctx.state === 'suspended') S.engine.ctx.resume();
    }
    this.busy = false; this.paint(); paintStatus();
  }
  paint() {
    if (!this.btn || !this.btn.isConnected) return;
    const N = S.native, st = N.state;
    this.btn.textContent = this.busy ? 'Please wait…' : N.running ? 'Stop native engine' : 'Start native engine';
    this.btn.disabled = this.busy;
    this.status.textContent = N.err ? N.err : N.running ? 'Running. Processor load ' + (st ? Math.round(st.cpu_percent) + '%' : '…') : 'Stopped. The built-in engine is in use.';
    this.status.style.color = N.err ? 'var(--red, #F87171)' : '';
    const bar = (name, pk, extra) => { const db = pk > 0.00001 ? 20 * Math.log10(pk) : -90; return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', margin: '3px 0' } },
      h('span', { style: { width: '130px', color: 'var(--txt2)' }, text: name }), h('span', { class: 'bar', style: { flex: 1 } }, h('i', { style: { width: Math.round(dbToPct(db) * 100) + '%' } })), h('span', { class: 'mono', style: { width: '46px', textAlign: 'right' }, text: db <= -89 ? '-inf' : db.toFixed(0) }), extra && h('span', { style: { color: 'var(--amber)' }, text: extra })); };
    this.meters.replaceChildren(...(st ? [...st.sources.map((s, i) => bar(s.name, s.peak, s.underruns ? s.underruns + ' dropouts' : '')), ...st.destinations.map((d) => bar(d.name, d.peak, d.overruns ? d.overruns + ' overruns' : ''))] : []));
    this.notes.replaceChildren(...N.warnings.map((w) => h('div', { class: 'sub', style: { margin: '4px 0' }, text: '• ' + w })));
  }
}

if (typeof module !== 'undefined') module.exports = { nativePlan, nativeDiff, NATIVE_SRC_NAMES, NATIVE_DST_NAMES };
