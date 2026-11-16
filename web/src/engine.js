/* The engine turns a graph (plain data) into real Web Audio nodes and keeps them in sync.
   It works on a live AudioContext and on an OfflineAudioContext, which is how it is tested
   and how "render to file" will work. */
class Engine {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.inst = new Map();
    this.edges = new Map();
    this.files = new Map();
    this.listeners = new Set();
    this.toastFn = opts.toast || (() => {});
    this.listenId = null;
    this.monitor = ctx.createGain();
    this.monitor.connect(ctx.destination);
    this.sinkBus = ctx.createGain();
    this.sinkBus.connect(ctx.destination);
    this.buf = new Float32Array(2048); // matches the analyser window, so a 30 fps meter never skips samples
    this.env = { offline: this.offline, offlineSink: this.sinkBus, status: (id) => this.emit('status', id), toast: (m) => this.toastFn(m) };
    this.ready = this.loadWorklets();
  }

  async loadWorklets() {
    // data: URLs load from file:// pages (blob: URLs do not), so the app works by double-click
    const url = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC);
    await this.ctx.audioWorklet.addModule(url);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, id) { this.listeners.forEach((f) => f(type, id)); }

  /* ---- nodes ---- */
  addNode(node) {
    const type = NODE_TYPES[node.type];
    if (!type) throw new Error('Unknown node type ' + node.type);
    const core = type.create(this.ctx, node, this.env);
    const inst = { id: node.id, type: node.type, core, applied: JSON.stringify(node.params), flags: '', status: core.status, error: core.error };
    const ctx = this.ctx;
    inst.wrapIn = type.in ? ctx.createGain() : null;
    inst.wrapOut = type.out ? ctx.createGain() : null;
    if (type.in && type.out) {
      inst.wet = ctx.createGain(); inst.dry = ctx.createGain(); inst.dry.gain.value = 0;
      inst.wrapIn.connect(core.in); core.out.connect(inst.wet); inst.wet.connect(inst.wrapOut);
      inst.wrapIn.connect(inst.dry); inst.dry.connect(inst.wrapOut);
    } else if (type.in) {
      inst.wrapIn.connect(core.in);
    } else {
      core.out.connect(inst.wrapOut);
    }
    inst.in = inst.wrapIn; inst.out = inst.wrapOut;
    inst.tap = ctx.createAnalyser(); inst.tap.fftSize = 2048; inst.tap.smoothingTimeConstant = 0.8; inst.tap.minDecibels = -90; inst.tap.maxDecibels = -10;
    (inst.out || inst.in).connect(inst.tap);
    this.inst.set(node.id, inst);
    return inst;
  }

  removeNode(id) {
    const inst = this.inst.get(id);
    if (!inst) return;
    for (const [eid, e] of [...this.edges]) if (e.from === id || e.to === id) this.removeEdge(eid);
    if (this.listenId === id) this.listen(null);
    try { inst.core.dispose(); } catch (e) {}
    [inst.wrapIn, inst.wrapOut, inst.wet, inst.dry, inst.tap].forEach((n) => n && n.disconnect());
    this.inst.delete(id);
  }

  applyNode(inst, node) {
    const now = JSON.stringify(node.params);
    if (now !== inst.applied) {
      const old = JSON.parse(inst.applied);
      for (const k of Object.keys(node.params)) if (old[k] !== node.params[k]) inst.core.update(node.params, k);
      inst.applied = now;
    }
    const type = NODE_TYPES[node.type];
    const flags = (node.bypass ? 'b' : '') + (node.mute ? 'm' : '');
    if (flags !== inst.flags) {
      inst.flags = flags;
      const t = this.ctx.currentTime, bypass = !!node.bypass && type.in && type.out;
      if (inst.wet) { smooth(this.ctx, inst.wet.gain, bypass ? 0 : 1); smooth(this.ctx, inst.dry.gain, bypass ? 1 : 0); }
      const muteNode = inst.wrapOut || inst.wrapIn;
      smooth(this.ctx, muteNode.gain, node.mute ? 0 : 1);
    }
  }

  /* ---- edges ---- */
  addEdge(e) {
    const a = this.inst.get(e.from), b = this.inst.get(e.to);
    if (!a || !b || !a.out || !b.in) return null;
    const g = this.ctx.createGain(); g.gain.value = e.mute ? 0 : e.gain;
    a.out.connect(g); g.connect(b.in);
    const ei = { from: e.from, to: e.to, g };
    this.edges.set(e.id, ei);
    return ei;
  }

  removeEdge(id) {
    const e = this.edges.get(id);
    if (!e) return;
    const a = this.inst.get(e.from);
    try { a && a.out.disconnect(e.g); } catch (err) {}
    e.g.disconnect();
    this.edges.delete(id);
  }

  sync(graph) {
    const seen = new Set();
    for (const n of graph.nodes) {
      seen.add(n.id);
      let i = this.inst.get(n.id);
      if (i && i.type !== n.type) { this.removeNode(n.id); i = null; }
      if (!i) i = this.addNode(n);
      this.applyNode(i, n);
    }
    for (const id of [...this.inst.keys()]) if (!seen.has(id)) this.removeNode(id);
    const eseen = new Set();
    for (const e of graph.edges) {
      eseen.add(e.id);
      let ei = this.edges.get(e.id);
      if (ei && (ei.from !== e.from || ei.to !== e.to)) { this.removeEdge(e.id); ei = null; }
      if (!ei) ei = this.addEdge(e);
      if (ei) smooth(this.ctx, ei.g.gain, e.mute ? 0 : e.gain);
    }
    for (const id of [...this.edges.keys()]) if (!eseen.has(id)) this.removeEdge(id);
    this.emit('synced');
  }

  /* Hear one node's output on the monitor, whatever the rest of the graph does. */
  listen(id) {
    const prev = this.inst.get(this.listenId);
    if (prev && prev.out) { try { prev.out.disconnect(this.monitor); } catch (e) {} }
    this.listenId = null;
    const i = this.inst.get(id);
    if (i && (i.out || i.in)) { (i.out || i.in).connect(this.monitor); this.listenId = id; }
    this.emit('listen', id);
  }

  /* ---- readings for the UI ---- */
  level(id) {
    const i = this.inst.get(id);
    if (!i) return null;
    i.tap.getFloatTimeDomainData(this.buf);
    let peak = 0, sum = 0;
    for (let k = 0; k < this.buf.length; k++) { const v = this.buf[k]; const a = v < 0 ? -v : v; if (a > peak) peak = a; sum += v * v; }
    return { peak, rms: Math.sqrt(sum / this.buf.length) };
  }
  spectrum(id, out) { const i = this.inst.get(id); if (!i) return false; i.tap.getByteFrequencyData(out); return true; }
  waveform(id, out) { const i = this.inst.get(id); if (!i) return false; i.tap.getByteTimeDomainData(out); return true; }
  get(id) { return this.inst.get(id); }
  status(id) { const i = this.inst.get(id); return i ? { status: i.core.status, error: i.core.error } : null; }
  latencyMs() { return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000; }

  dispose() { for (const id of [...this.inst.keys()]) this.removeNode(id); this.monitor.disconnect(); this.sinkBus.disconnect(); }

  /* Render a graph without sound hardware. Used by tests and "export processed audio". */
  static async renderOffline(graph, seconds, sampleRate = 48000) {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const eng = new Engine(ctx);
    await eng.ready;
    eng.sync(graph);
    const buf = await ctx.startRendering();
    return buf;
  }
}
