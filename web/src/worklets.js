/* AudioWorklet processors, shipped as a string so the app stays one file.
   Ported from the Rust DSP crate (gate, spectral noise suppressor, auto leveler). */
const WORKLET_SRC = String.raw`
const DB = (d) => Math.pow(10, d / 20);
const LIN2DB = (v) => 20 * Math.log10(Math.max(v, 1e-6));

class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -90, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: -60, minValue: -90, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 5, minValue: 0.1, maxValue: 200, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 120, minValue: 5, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 80, minValue: 0, maxValue: 1000, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.gain = 0; this.holdLeft = 0; this.tick = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, sr = sampleRate;
    const thr = DB(p.threshold[0]), floor = DB(p.range[0]);
    const ac = Math.exp(-1 / (p.attack[0] * 0.001 * sr)), rc = Math.exp(-1 / (p.release[0] * 0.001 * sr));
    const holdN = (p.hold[0] * 0.001 * sr) | 0;
    const envUp = Math.exp(-1 / (0.001 * sr)), envDn = Math.exp(-1 / (0.02 * sr));
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < inp.length; c++) a = Math.max(a, Math.abs(inp[c][i]));
      const k = a > this.env ? envUp : envDn;
      this.env = k * this.env + (1 - k) * a;
      const open = this.env >= thr;
      if (open) this.holdLeft = holdN; else if (this.holdLeft > 0) this.holdLeft--;
      const target = open || this.holdLeft > 0 ? 1 : floor;
      const g = target > this.gain ? ac : rc;
      this.gain = g * this.gain + (1 - g) * target;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    if ((this.tick++ & 7) === 0) this.port.postMessage({ gate: this.gain });
    return true;
  }
}
registerProcessor('eddy-gate', Gate);

class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) { this.cos[k] = Math.cos(2 * Math.PI * k / n); this.sin[k] = -Math.sin(2 * Math.PI * k / n); }
  }
  run(re, im, inverse) {
    const n = this.n;
    for (let i = 0; i < n; i++) { const j = this.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
        const wr = this.cos[k * step], wi = inverse ? -this.sin[k * step] : this.sin[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

class Suppressor {
  constructor() {
    this.n = 512; this.hop = 256; this.fft = new FFT(512);
    this.win = new Float32Array(512);
    for (let i = 0; i < 512; i++) this.win[i] = Math.sin(Math.PI * (i + 0.5) / 512);
    this.inBuf = new Float32Array(512); this.ola = new Float32Array(512);
    this.noise = new Float32Array(257); this.gPrev = new Float32Array(257).fill(1);
    this.re = new Float32Array(512); this.im = new Float32Array(512);
    this.frames = 0;
  }
  hopProcess(input, output, strength) {
    const n = this.n, hop = this.hop;
    this.inBuf.copyWithin(0, hop); this.inBuf.set(input, n - hop);
    for (let i = 0; i < n; i++) { this.re[i] = this.inBuf[i] * this.win[i]; this.im[i] = 0; }
    this.fft.run(this.re, this.im, false);
    const over = 1 + 3 * strength, floor = Math.pow(10, -(6 + 24 * strength) / 20);
    for (let k = 0; k <= n / 2; k++) {
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      if (this.frames < 4) this.noise[k] = this.frames === 0 ? p : 0.5 * (this.noise[k] + p);
      else if (p < 4 * this.noise[k]) this.noise[k] += (p - this.noise[k]) * 0.05;
      else this.noise[k] += (p - this.noise[k]) * 0.00003;
      const raw = Math.max(Math.sqrt(Math.max(0, (p - over * this.noise[k]) / Math.max(p, 1e-12))), floor);
      const g = raw > this.gPrev[k] ? 0.6 * this.gPrev[k] + 0.4 * raw : 0.85 * this.gPrev[k] + 0.15 * raw;
      this.gPrev[k] = g; this.re[k] *= g; this.im[k] *= g;
      if (k !== 0 && k !== n / 2) { this.re[n - k] = this.re[k]; this.im[n - k] = -this.im[k]; }
    }
    this.frames++;
    this.fft.run(this.re, this.im, true);
    for (let i = 0; i < n; i++) this.ola[i] += this.re[i] * this.win[i];
    output.set(this.ola.subarray(0, hop));
    this.ola.copyWithin(0, hop); this.ola.fill(0, n - hop);
  }
}

class Denoise extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'strength', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }
  constructor() { super(); this.ch = []; }
  chan(c) {
    if (!this.ch[c]) this.ch[c] = { s: new Suppressor(), pend: new Float32Array(256), np: 0, outq: new Float32Array(4096), r: 0, w: 0, tmp: new Float32Array(256) };
    return this.ch[c];
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const strength = p.strength[0];
    for (let c = 0; c < out.length; c++) {
      const x = inp[c] || inp[0], st = this.chan(c), n = x.length;
      for (let i = 0; i < n; i++) {
        st.pend[st.np++] = x[i];
        if (st.np === 256) {
          st.s.hopProcess(st.pend, st.tmp, strength);
          for (let j = 0; j < 256; j++) st.outq[(st.w + j) & 4095] = st.tmp[j];
          st.w += 256; st.np = 0;
        }
      }
      for (let i = 0; i < n; i++) {
        if (st.r < st.w) { out[c][i] = st.outq[st.r & 4095]; st.r++; } else out[c][i] = 0;
      }
    }
    return true;
  }
}
registerProcessor('eddy-denoise', Denoise);

class Leveler extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'target', defaultValue: -16, minValue: -40, maxValue: 0, automationRate: 'k-rate' },
      { name: 'maxGain', defaultValue: 12, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.gdb = 0; this.tick = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, sr = sampleRate;
    const eu = Math.exp(-1 / (0.005 * sr)), ed = Math.exp(-1 / (0.3 * sr));
    const gu = Math.exp(-1 / (1.5 * sr)), gd = Math.exp(-1 / (0.2 * sr));
    const target = p.target[0], maxG = p.maxGain[0];
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let c = 0; c < inp.length; c++) a = Math.max(a, Math.abs(inp[c][i]));
      const k = a > this.env ? eu : ed;
      this.env = k * this.env + (1 - k) * a;
      const lvl = LIN2DB(this.env);
      if (lvl > -50) {
        const want = Math.min(maxG, Math.max(-maxG, target - lvl));
        const c = want < this.gdb ? gd : gu;
        this.gdb = c * this.gdb + (1 - c) * want;
      }
      const g = DB(this.gdb);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * g;
    }
    if ((this.tick++ & 7) === 0) this.port.postMessage({ gain: this.gdb });
    return true;
  }
}
registerProcessor('eddy-leveler', Leveler);
`;
