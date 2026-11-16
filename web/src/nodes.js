/* Node type registry. Each type declares its parameters (the inspector and the pinned
   controls are generated from this) and a factory that builds the real Web Audio nodes. */
const NODE_TYPES = {};
const CATEGORIES = ['Sources', 'Clean up', 'Tone', 'Dynamics', 'Space', 'Routing', 'Outputs'];
const dB = (d) => Math.pow(10, d / 20);
const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-6));
const smooth = (ctx, param, v) => { if (ctx.currentTime > 0) param.setTargetAtTime(v, ctx.currentTime, 0.015); else param.value = v; };
const def = (id, o) => { NODE_TYPES[id] = Object.assign({ id, in: true, out: true, params: [] }, o); };
const LEVEL = { k: 'gain', label: 'Level', t: 'range', min: -60, max: 24, step: 0.1, def: 0, unit: 'dB' };

/* ---------- generated audio for demos and noise ---------- */
function makeRng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) / 16777216 * 2 - 1; }; }

function demoVoiceBuffers(ctx) {
  const sr = ctx.sampleRate, len = sr * 6;
  const voice = ctx.createBuffer(1, len, sr), noise = ctx.createBuffer(1, len, sr);
  const v = voice.getChannelData(0), nz = noise.getChannelData(0), rnd = makeRng(12345);
  const words = [[0.5, 1.1], [1.6, 2.2], [2.7, 3.3], [3.8, 4.4], [4.9, 5.5]];
  let rumble = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    if (words.some(([a, b]) => t >= a && t < b)) {
      const f0 = 120 + 12 * Math.sin(2 * Math.PI * 5 * t);
      const syl = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 4 * t));
      let s = 0;
      for (let h = 1; h <= 24; h++) { const f = f0 * h; if (f < 7000) s += Math.sin(2 * Math.PI * f * t) / h; }
      v[i] = s * 0.12 * syl;
    }
    rumble += 0.01 * (rnd() - rumble);
    const click = (t * 1.4) % 1 < 0.004 ? 0.25 * rnd() : 0;
    nz[i] = 0.012 * rnd() + 1.5 * rumble + click;
  }
  return { voice, noise };
}

function demoMusicBuffer(ctx) {
  const sr = ctx.sampleRate, secs = 8, buf = ctx.createBuffer(2, sr * secs, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1), rnd = makeRng(7);
  const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [261.6, 329.6, 392], [196, 246.9, 293.7]];
  for (let i = 0; i < L.length; i++) {
    const t = i / sr, ci = Math.floor(t / 2) % 4, ct = t % 2;
    const env = Math.min(1, ct * 6) * Math.exp(-ct * 0.6);
    let pad = 0;
    chords[ci].forEach((f, k) => { pad += Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(2 * Math.PI * f * 2 * t) * 0.15 * (k + 1) / 3; });
    pad *= 0.1 * env;
    const bt = t % 0.5, kick = Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 9) * 0.5;
    const ht = (t + 0.25) % 0.5, hat = rnd() * Math.exp(-ht * 60) * 0.08;
    const bass = Math.sin(2 * Math.PI * chords[ci][0] / 2 * t) * 0.18 * Math.exp(-bt * 3);
    L[i] = pad + kick + hat + bass; R[i] = pad * 0.95 + kick + hat * 0.8 + bass;
  }
  return buf;
}

function noiseBuffer(ctx, color) {
  const sr = ctx.sampleRate, buf = ctx.createBuffer(2, sr * 4, sr), rnd = makeRng(99);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rnd();
      if (color === 'pink') { b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; }
      else if (color === 'brown') { brown = (brown + 0.02 * w) / 1.02; d[i] = brown * 3.5; }
      else d[i] = w * 0.5;
    }
  }
  return buf;
}

function reverbIR(ctx, seconds) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * seconds)), ir = ctx.createBuffer(2, len, sr), rnd = makeRng(4242);
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = rnd() * Math.pow(1 - i / len, 3); }
  return ir;
}

/* ---------- Sources ---------- */
def('source.mic', {
  cat: 'Sources', title: 'Microphone', icon: 'mic', color: '#8B5CF6', in: false,
  blurb: 'Your real microphone, with Windows processing turned off so Eddy hears it raw.',
  params: [{ k: 'device', label: 'Input device', t: 'device-in', def: 'default' }, LEVEL],
  create(ctx, node, env) {
    const out = ctx.createGain(); out.gain.value = dB(node.params.gain);
    const inst = { out, status: 'connecting' };
    let stream = null, src = null, token = 0;
    const close = () => { try { src && src.disconnect(); } catch (e) {} stream && stream.getTracks().forEach((t) => t.stop()); stream = src = null; };
    const open = async (dev) => {
      const t = ++token;
      if (env.offline) { inst.status = 'idle'; return; }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: dev && dev !== 'default' ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
        if (t !== token) { s.getTracks().forEach((x) => x.stop()); return; }
        close(); stream = s; src = ctx.createMediaStreamSource(s); src.connect(out);
        inst.status = 'live'; inst.error = null;
      } catch (e) { inst.status = 'error'; inst.error = e.name === 'NotAllowedError' ? 'Microphone access was blocked' : e.name === 'NotFoundError' ? 'No microphone found' : e.message; }
      env.status(node.id);
    };
    open(node.params.device);
    inst.update = (p, k) => { if (k === 'gain') smooth(ctx, out.gain, dB(p.gain)); if (k === 'device') open(p.device); };
    inst.retry = () => open(node.params.device);
    inst.actions = { retry: () => open(node.params.device) };
    inst.dispose = () => { token++; close(); out.disconnect(); };
    return inst;
  },
});

def('source.voice', {
  cat: 'Sources', title: 'Demo voice', icon: 'wave', color: '#A78BFA', in: false,
  blurb: 'A noisy test voice (hiss, fan rumble, key clicks). Lets you try the cleanup tools without a microphone.',
  params: [{ k: 'noise', label: 'Room noise', t: 'range', min: 0, max: 2, step: 0.01, def: 1, fmt: (v) => Math.round(v * 100) + '%' }, LEVEL],
  create(ctx, node) {
    const { voice, noise } = demoVoiceBuffers(ctx), out = ctx.createGain(), ng = ctx.createGain();
    const mk = (b) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.start(0); return s; };
    const sv = mk(voice), sn = mk(noise);
    sv.connect(out); sn.connect(ng); ng.connect(out);
    ng.gain.value = node.params.noise; out.gain.value = dB(node.params.gain);
    return {
      out, status: 'live',
      update(p, k) { if (k === 'noise') smooth(ctx, ng.gain, p.noise); if (k === 'gain') smooth(ctx, out.gain, dB(p.gain)); },
      dispose() { try { sv.stop(); sn.stop(); } catch (e) {} out.disconnect(); },
    };
  },
});

def('source.music', {
  cat: 'Sources', title: 'Music player', icon: 'music', color: '#F472B6', in: false,
  blurb: 'Plays a demo loop, or any audio file you pick. Stands in for an app like Spotify.',
  params: [{ k: 'play', label: 'Playing', t: 'toggle', def: true }, { k: 'file', label: 'Audio file', t: 'file', def: '' }, LEVEL],
  create(ctx, node, env) {
    const out = ctx.createGain(), play = ctx.createGain();
    play.connect(out); out.gain.value = dB(node.params.gain); play.gain.value = node.params.play ? 1 : 0;
    const demo = ctx.createBufferSource(); demo.buffer = demoMusicBuffer(ctx); demo.loop = true; demo.start(0); demo.connect(play);
    let el = null, msrc = null;
    const inst = { out, status: 'demo loop' };
    inst.actions = {
      setFile(file) {
        if (env.offline) return;
        if (el) { el.pause(); URL.revokeObjectURL(el.src); }
        el = new Audio(URL.createObjectURL(file)); el.loop = true;
        if (!msrc) msrc = ctx.createMediaElementSource(el);
        msrc.connect(play); demo.disconnect();
        if (node.params.play) el.play().catch(() => {});
        inst.status = file.name; env.status(node.id);
      },
    };
    inst.update = (p, k) => {
      if (k === 'gain') smooth(ctx, out.gain, dB(p.gain));
      if (k === 'play') { smooth(ctx, play.gain, p.play ? 1 : 0); if (el) (p.play ? el.play().catch(() => {}) : el.pause()); }
    };
    inst.dispose = () => { try { demo.stop(); } catch (e) {} el && el.pause(); out.disconnect(); };
    return inst;
  },
});

def('source.system', {
  cat: 'Sources', title: 'System sound', icon: 'monitor', color: '#4C8DFF', in: false,
  blurb: 'Captures a tab or screen with sound through the browser. In the desktop app this is the Windows output.',
  params: [{ t: 'button', k: 'capture', label: 'Capture sound…', action: 'capture' }, LEVEL],
  create(ctx, node, env) {
    const out = ctx.createGain(); out.gain.value = dB(node.params.gain);
    const inst = { out, status: 'not capturing' };
    let src = null, stream = null;
    inst.actions = {
      async capture() {
        if (env.offline) return;
        try {
          const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
          s.getVideoTracks().forEach((t) => t.stop());
          if (!s.getAudioTracks().length) { inst.status = 'error'; inst.error = 'No sound was shared. Tick "Share audio" in the picker.'; env.status(node.id); return; }
          src && src.disconnect(); stream = new MediaStream(s.getAudioTracks()); src = ctx.createMediaStreamSource(stream); src.connect(out);
          inst.status = 'live'; inst.error = null; stream.getAudioTracks()[0].onended = () => { inst.status = 'not capturing'; env.status(node.id); };
        } catch (e) { inst.status = 'not capturing'; if (e.name !== 'NotAllowedError') inst.error = e.message; }
        env.status(node.id);
      },
    };
    inst.update = (p, k) => { if (k === 'gain') smooth(ctx, out.gain, dB(p.gain)); };
    inst.dispose = () => { stream && stream.getTracks().forEach((t) => t.stop()); out.disconnect(); };
    return inst;
  },
});

def('source.tone', {
  cat: 'Sources', title: 'Tone generator', icon: 'activity', color: '#22D3EE', in: false,
  blurb: 'A test tone for checking levels and routing.',
  params: [
    { k: 'wave', label: 'Shape', t: 'select', def: 'sine', opts: [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square'], ['sawtooth', 'Saw']] },
    { k: 'freq', label: 'Frequency', t: 'range', min: 20, max: 12000, step: 1, def: 440, unit: 'Hz', log: true },
    { ...LEVEL, def: -18 },
  ],
  create(ctx, node) {
    const o = ctx.createOscillator(), out = ctx.createGain();
    o.type = node.params.wave; o.frequency.value = node.params.freq; out.gain.value = dB(node.params.gain); o.connect(out); o.start();
    return {
      out, status: 'live',
      update(p, k) { if (k === 'wave') o.type = p.wave; if (k === 'freq') smooth(ctx, o.frequency, p.freq); if (k === 'gain') smooth(ctx, out.gain, dB(p.gain)); },
      dispose() { try { o.stop(); } catch (e) {} out.disconnect(); },
    };
  },
});

def('source.noise', {
  cat: 'Sources', title: 'Noise generator', icon: 'wind', color: '#94A3B8', in: false,
  blurb: 'White, pink or brown noise. Useful for testing and masking.',
  params: [{ k: 'color', label: 'Colour', t: 'select', def: 'pink', opts: [['white', 'White'], ['pink', 'Pink'], ['brown', 'Brown']] }, { ...LEVEL, def: -24 }],
  create(ctx, node) {
    const out = ctx.createGain(); out.gain.value = dB(node.params.gain);
    let s = null;
    const make = (c) => { if (s) { try { s.stop(); } catch (e) {} s.disconnect(); } s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, c); s.loop = true; s.connect(out); s.start(0); };
    make(node.params.color);
    return {
      out, status: 'live',
      update(p, k) { if (k === 'color') make(p.color); if (k === 'gain') smooth(ctx, out.gain, dB(p.gain)); },
      dispose() { try { s.stop(); } catch (e) {} out.disconnect(); },
    };
  },
});

/* ---------- helpers for simple effects ---------- */
function simple(ctx, core, update) { const i = ctx.createGain(), o = ctx.createGain(); i.connect(core); core.connect(o); return { in: i, out: o, core, update, dispose() { i.disconnect(); core.disconnect(); o.disconnect(); } }; }

/* ---------- Clean up ---------- */
def('fx.denoise', {
  cat: 'Clean up', title: 'Noise removal', icon: 'sparkles', color: '#34D399',
  blurb: 'Removes steady background noise (fans, hiss, room tone) and keeps the voice. Runs on your computer.',
  params: [{ k: 'strength', label: 'Strength', t: 'range', min: 0, max: 1, step: 0.01, def: 0.7, fmt: (v) => Math.round(v * 100) + '%' }],
  create(ctx, node) {
    const n = new AudioWorkletNode(ctx, 'eddy-denoise', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    n.parameters.get('strength').value = node.params.strength;
    return { in: n, out: n, latencyMs: 16, update(p) { n.parameters.get('strength').value = p.strength; }, dispose() { n.disconnect(); } };
  },
});

def('fx.gate', {
  cat: 'Clean up', title: 'Noise gate', icon: 'gate', color: '#2DD4BF',
  blurb: 'Closes softly when you stop talking, so quiet sounds do not leak through.',
  params: [
    { k: 'threshold', label: 'Threshold', t: 'range', min: -90, max: 0, step: 0.5, def: -50, unit: 'dB' },
    { k: 'range', label: 'Reduction', t: 'range', min: -90, max: 0, step: 0.5, def: -60, unit: 'dB' },
    { k: 'attack', label: 'Attack', t: 'range', min: 0.5, max: 100, step: 0.5, def: 5, unit: 'ms', log: true },
    { k: 'hold', label: 'Hold', t: 'range', min: 0, max: 500, step: 1, def: 80, unit: 'ms' },
    { k: 'release', label: 'Release', t: 'range', min: 10, max: 1500, step: 1, def: 120, unit: 'ms', log: true },
  ],
  create(ctx, node) {
    const n = new AudioWorkletNode(ctx, 'eddy-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const inst = { in: n, out: n, meter: { gate: 1 }, dispose() { n.disconnect(); } };
    inst.update = (p) => ['threshold', 'range', 'attack', 'hold', 'release'].forEach((k) => (n.parameters.get(k).value = p[k]));
    inst.update(node.params);
    n.port.onmessage = (e) => { inst.meter.gate = e.data.gate; };
    return inst;
  },
});

def('fx.filter', {
  cat: 'Clean up', title: 'Filter', icon: 'filter', color: '#38BDF8',
  blurb: 'Cuts rumble (high-pass) or hiss (low-pass), or notches out a whine.',
  params: [
    { k: 'type', label: 'Type', t: 'select', def: 'highpass', opts: [['highpass', 'High-pass'], ['lowpass', 'Low-pass'], ['bandpass', 'Band-pass'], ['notch', 'Notch']] },
    { k: 'freq', label: 'Frequency', t: 'range', min: 20, max: 20000, step: 1, def: 80, unit: 'Hz', log: true },
    { k: 'q', label: 'Sharpness', t: 'range', min: 0.1, max: 12, step: 0.01, def: 0.71, log: true },
  ],
  create(ctx, node) {
    const f = ctx.createBiquadFilter(); f.type = node.params.type; f.frequency.value = node.params.freq; f.Q.value = node.params.q;
    return { in: f, out: f, update(p, k) { if (k === 'type') f.type = p.type; if (k === 'freq') smooth(ctx, f.frequency, p.freq); if (k === 'q') smooth(ctx, f.Q, p.q); }, dispose() { f.disconnect(); } };
  },
});

/* ---------- Tone ---------- */
const EQ_BANDS = [['lowshelf', 120], ['peaking', 400], ['peaking', 1500], ['peaking', 4000], ['highshelf', 10000]];
def('fx.eq', {
  cat: 'Tone', title: 'Equalizer', icon: 'eq', color: '#A78BFA',
  blurb: 'Five bands to shape the tone. Drag the points on the curve.',
  params: EQ_BANDS.flatMap(([, f], i) => [
    { k: 'f' + i, label: 'Band ' + (i + 1) + ' frequency', t: 'range', min: 20, max: 20000, step: 1, def: f, unit: 'Hz', log: true, hidden: true },
    { k: 'g' + i, label: 'Band ' + (i + 1) + ' gain', t: 'range', min: -18, max: 18, step: 0.1, def: [1.5, -1.5, 0, 2, 1.5][i], unit: 'dB', hidden: true },
    { k: 'q' + i, label: 'Band ' + (i + 1) + ' width', t: 'range', min: 0.2, max: 8, step: 0.01, def: 1, log: true, hidden: true },
  ]).concat([{ t: 'eq', k: '_eq', label: 'Curve' }]),
  create(ctx, node) {
    const fs = EQ_BANDS.map(([t], i) => { const f = ctx.createBiquadFilter(); f.type = t; f.frequency.value = node.params['f' + i]; f.gain.value = node.params['g' + i]; f.Q.value = node.params['q' + i]; return f; });
    for (let i = 1; i < fs.length; i++) fs[i - 1].connect(fs[i]);
    return {
      in: fs[0], out: fs[4], filters: fs,
      response(freqs) {
        const out = new Float32Array(freqs.length), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
        fs.forEach((f) => { f.getFrequencyResponse(freqs, mag, ph); for (let i = 0; i < freqs.length; i++) out[i] += toDb(mag[i]); });
        return out;
      },
      update(p, k) { const i = +k[1]; if (!fs[i]) return; if (k[0] === 'f') smooth(ctx, fs[i].frequency, p[k]); if (k[0] === 'g') smooth(ctx, fs[i].gain, p[k]); if (k[0] === 'q') smooth(ctx, fs[i].Q, p[k]); },
      dispose() { fs.forEach((f) => f.disconnect()); },
    };
  },
});

def('fx.pan', {
  cat: 'Tone', title: 'Stereo pan', icon: 'pan', color: '#FB923C',
  blurb: 'Moves the sound left or right.',
  params: [{ k: 'pan', label: 'Position', t: 'range', min: -1, max: 1, step: 0.01, def: 0, fmt: (v) => (v === 0 ? 'Centre' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)) }],
  create(ctx, node) {
    const p = ctx.createStereoPanner(); p.pan.value = node.params.pan;
    return { in: p, out: p, update(pr) { smooth(ctx, p.pan, pr.pan); }, dispose() { p.disconnect(); } };
  },
});

/* ---------- Dynamics ---------- */
def('fx.comp', {
  cat: 'Dynamics', title: 'Compressor', icon: 'gauge', color: '#FBBF24',
  blurb: 'Evens out loud and quiet moments so you stay easy to listen to.',
  params: [
    { k: 'threshold', label: 'Threshold', t: 'range', min: -60, max: 0, step: 0.5, def: -24, unit: 'dB' },
    { k: 'ratio', label: 'Ratio', t: 'range', min: 1, max: 20, step: 0.1, def: 4, fmt: (v) => v.toFixed(1) + ':1' },
    { k: 'knee', label: 'Knee', t: 'range', min: 0, max: 40, step: 1, def: 12, unit: 'dB' },
    { k: 'attack', label: 'Attack', t: 'range', min: 0, max: 200, step: 1, def: 10, unit: 'ms' },
    { k: 'release', label: 'Release', t: 'range', min: 10, max: 1000, step: 1, def: 160, unit: 'ms', log: true },
    { k: 'makeup', label: 'Make-up gain', t: 'range', min: 0, max: 24, step: 0.1, def: 4, unit: 'dB' },
  ],
  create(ctx, node) {
    const c = ctx.createDynamicsCompressor(), m = ctx.createGain(), i = ctx.createGain();
    i.connect(c); c.connect(m);
    const apply = (p, k) => {
      const set = (prm, v) => (k ? smooth(ctx, prm, v) : (prm.value = v));
      if (!k || k === 'threshold') set(c.threshold, p.threshold);
      if (!k || k === 'ratio') set(c.ratio, p.ratio);
      if (!k || k === 'knee') set(c.knee, p.knee);
      if (!k || k === 'attack') set(c.attack, p.attack / 1000);
      if (!k || k === 'release') set(c.release, p.release / 1000);
      if (!k || k === 'makeup') set(m.gain, dB(p.makeup));
    };
    apply(node.params);
    return { in: i, out: m, reduction: () => c.reduction, update: apply, dispose() { i.disconnect(); c.disconnect(); m.disconnect(); } };
  },
});

def('fx.leveler', {
  cat: 'Dynamics', title: 'Auto level', icon: 'bolt', color: '#F59E0B',
  blurb: 'Slowly rides the volume toward a target, so you stay steady when you lean in or away.',
  params: [
    { k: 'target', label: 'Target level', t: 'range', min: -40, max: -6, step: 0.5, def: -16, unit: 'dB' },
    { k: 'maxGain', label: 'Max boost', t: 'range', min: 0, max: 24, step: 0.5, def: 12, unit: 'dB' },
  ],
  create(ctx, node) {
    const n = new AudioWorkletNode(ctx, 'eddy-leveler', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const inst = { in: n, out: n, meter: { gain: 0 }, dispose() { n.disconnect(); } };
    inst.update = (p) => { n.parameters.get('target').value = p.target; n.parameters.get('maxGain').value = p.maxGain; };
    inst.update(node.params);
    n.port.onmessage = (e) => { inst.meter.gain = e.data.gain; };
    return inst;
  },
});

def('fx.limiter', {
  cat: 'Dynamics', title: 'Limiter', icon: 'limiter', color: '#F87171',
  blurb: 'A safety ceiling. Nothing gets louder than this, so nobody gets a blast in their ears.',
  params: [{ k: 'ceiling', label: 'Ceiling', t: 'range', min: -24, max: 0, step: 0.1, def: -1.5, unit: 'dB' }],
  create(ctx, node) {
    const c = ctx.createDynamicsCompressor(); c.ratio.value = 20; c.knee.value = 0; c.attack.value = 0.002; c.release.value = 0.12; c.threshold.value = node.params.ceiling;
    return { in: c, out: c, reduction: () => c.reduction, update(p) { smooth(ctx, c.threshold, p.ceiling); }, dispose() { c.disconnect(); } };
  },
});

/* ---------- Space ---------- */
def('fx.delay', {
  cat: 'Space', title: 'Echo', icon: 'clock', color: '#22D3EE',
  blurb: 'Repeats the sound after a short time.',
  params: [
    { k: 'time', label: 'Time', t: 'range', min: 10, max: 1000, step: 1, def: 280, unit: 'ms', log: true },
    { k: 'feedback', label: 'Repeats', t: 'range', min: 0, max: 0.9, step: 0.01, def: 0.35, fmt: (v) => Math.round(v * 100) + '%' },
    { k: 'mix', label: 'Mix', t: 'range', min: 0, max: 1, step: 0.01, def: 0.3, fmt: (v) => Math.round(v * 100) + '%' },
  ],
  create(ctx, node) {
    const i = ctx.createGain(), o = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), d = ctx.createDelay(2), fb = ctx.createGain();
    i.connect(dry); dry.connect(o); i.connect(d); d.connect(wet); wet.connect(o); d.connect(fb); fb.connect(d);
    const apply = (p) => { d.delayTime.value = p.time / 1000; fb.gain.value = p.feedback; wet.gain.value = p.mix; dry.gain.value = 1 - p.mix * 0.5; };
    apply(node.params);
    return { in: i, out: o, update: apply, dispose() { [i, o, dry, wet, d, fb].forEach((x) => x.disconnect()); } };
  },
});

def('fx.reverb', {
  cat: 'Space', title: 'Reverb', icon: 'rings', color: '#C084FC',
  blurb: 'Adds the feel of a room or hall.',
  params: [
    { k: 'decay', label: 'Room size', t: 'range', min: 0.2, max: 6, step: 0.1, def: 1.8, unit: 's' },
    { k: 'mix', label: 'Mix', t: 'range', min: 0, max: 1, step: 0.01, def: 0.25, fmt: (v) => Math.round(v * 100) + '%' },
  ],
  create(ctx, node) {
    const i = ctx.createGain(), o = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain(), conv = ctx.createConvolver();
    i.connect(dry); dry.connect(o); i.connect(conv); conv.connect(wet); wet.connect(o);
    conv.buffer = reverbIR(ctx, node.params.decay); wet.gain.value = node.params.mix; dry.gain.value = 1;
    let timer = null;
    return {
      in: i, out: o,
      update(p, k) { if (k === 'mix') smooth(ctx, wet.gain, p.mix); if (k === 'decay') { clearTimeout(timer); timer = setTimeout(() => { conv.buffer = reverbIR(ctx, p.decay); }, 120); } },
      dispose() { clearTimeout(timer); [i, o, dry, wet, conv].forEach((x) => x.disconnect()); },
    };
  },
});

/* ---------- Routing ---------- */
def('fx.gain', {
  cat: 'Routing', title: 'Volume', icon: 'sliders', color: '#94A3B8',
  blurb: 'Turns the sound up or down.',
  params: [{ ...LEVEL }],
  create(ctx, node) { const g = ctx.createGain(); g.gain.value = dB(node.params.gain); return { in: g, out: g, update(p) { smooth(ctx, g.gain, dB(p.gain)); }, dispose() { g.disconnect(); } }; },
});

def('fx.bus', {
  cat: 'Routing', title: 'Mix bus', icon: 'merge', color: '#8B5CF6',
  blurb: 'Combines everything connected to it into one signal, with its own volume.',
  params: [{ ...LEVEL }, { k: 'mono', label: 'Mono', t: 'toggle', def: false }],
  create(ctx, node) {
    const g = ctx.createGain(); g.gain.value = dB(node.params.gain);
    const apply = (p, k) => { if (k === 'gain') smooth(ctx, g.gain, dB(p.gain)); if (!k || k === 'mono') { g.channelCount = p.mono ? 1 : 2; g.channelCountMode = p.mono ? 'explicit' : 'max'; } };
    apply(node.params);
    return { in: g, out: g, update: apply, dispose() { g.disconnect(); } };
  },
});

def('viz.spectrum', {
  cat: 'Routing', title: 'Spectrum', icon: 'bars', color: '#2DD4BF', viz: true,
  blurb: 'Passes sound through unchanged and shows what is in it.',
  params: [],
  create(ctx) { const g = ctx.createGain(); return { in: g, out: g, update() {}, dispose() { g.disconnect(); } }; },
});

/* ---------- Outputs ---------- */
function sinkRouting(ctx, env, gain, dev) {
  let msd = null, el = null;
  const route = async (d) => {
    try { gain.disconnect(); } catch (e) {}
    if (env.offline) { gain.connect(env.offlineSink); return; }
    if (el) { el.pause(); el.srcObject = null; el = null; }
    if (!d || d === 'default') { gain.connect(ctx.destination); return; }
    msd = msd || ctx.createMediaStreamDestination();
    gain.connect(msd);
    el = new Audio(); el.srcObject = msd.stream;
    try { await el.setSinkId(d); await el.play(); } catch (e) { gain.disconnect(); gain.connect(ctx.destination); env.toast('Could not use that output device, using the default.'); }
  };
  route(dev);
  return { route, dispose() { if (el) { el.pause(); el.srcObject = null; } } };
}

def('out.speakers', {
  cat: 'Outputs', title: 'Output device', icon: 'headphones', color: '#4C8DFF', out: false,
  blurb: 'Plays to a real output: your headphones, speakers, or a virtual cable that voice apps use as a microphone.',
  params: [{ k: 'device', label: 'Output device', t: 'device-out', def: 'default' }, LEVEL, { k: 'safe', label: 'Safety limiter', t: 'toggle', def: true }],
  create(ctx, node, env) {
    // a transparent brick-wall at -1 dB so a loud moment can never hurt anyone's ears
    const g = ctx.createGain(); g.gain.value = dB(node.params.gain);
    const lim = ctx.createDynamicsCompressor(); lim.ratio.value = 20; lim.knee.value = 0; lim.attack.value = 0.001; lim.release.value = 0.1;
    const dry = ctx.createGain(), wet = ctx.createGain(), end = ctx.createGain();
    g.connect(lim); lim.connect(wet); g.connect(dry); wet.connect(end); dry.connect(end);
    const safe = (on) => { lim.threshold.value = on ? -1 : 0; wet.gain.value = on ? 1 : 0; dry.gain.value = on ? 0 : 1; };
    safe(node.params.safe !== false);
    const s = sinkRouting(ctx, env, end, node.params.device);
    return { in: g, update(p, k) { if (k === 'gain') smooth(ctx, g.gain, dB(p.gain)); if (k === 'device') s.route(p.device); if (k === 'safe') safe(p.safe); }, dispose() { s.dispose(); [g, lim, dry, wet, end].forEach((x) => x.disconnect()); } };
  },
});

def('out.record', {
  cat: 'Outputs', title: 'Recorder', icon: 'record', color: '#F87171', out: false,
  blurb: 'Records whatever reaches it to a file you can download.',
  params: [{ t: 'button', k: 'toggle', label: 'Start / stop recording', action: 'toggle' }, LEVEL],
  create(ctx, node, env) {
    const g = ctx.createGain(); g.gain.value = dB(node.params.gain);
    const inst = { in: g, status: 'ready' };
    if (env.offline) { g.connect(env.offlineSink); return Object.assign(inst, { update() {}, dispose() { g.disconnect(); } }); }
    const msd = ctx.createMediaStreamDestination(); g.connect(msd);
    let rec = null, chunks = [], t0 = 0, timer = null;
    inst.actions = {
      toggle() {
        if (rec && rec.state === 'recording') { rec.stop(); return; }
        chunks = []; rec = new MediaRecorder(msd.stream); rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = () => { clearInterval(timer); inst.recording = false; inst.blob = new Blob(chunks, { type: 'audio/webm' }); inst.status = 'saved, ' + (inst.blob.size / 1024 | 0) + ' KB'; env.status(node.id); };
        rec.start(250); t0 = performance.now(); inst.recording = true;
        timer = setInterval(() => { inst.status = 'recording ' + ((performance.now() - t0) / 1000 | 0) + ' s'; env.status(node.id); }, 500);
        inst.status = 'recording'; env.status(node.id);
      },
      download() {
        if (!inst.blob) return;
        const a = document.createElement('a'); a.href = URL.createObjectURL(inst.blob); a.download = 'eddy-recording.webm'; a.click();
      },
    };
    inst.update = (p, k) => { if (k === 'gain') smooth(ctx, g.gain, dB(p.gain)); };
    inst.dispose = () => { clearInterval(timer); if (rec && rec.state === 'recording') rec.stop(); g.disconnect(); };
    return inst;
  },
});
