// The Native engine card against a fake Tauri backend: devices, start, translated commands, meters, stop.
const { chromium } = require('playwright'); const path = require('path');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('PASS', m); };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const c = await b.newContext({ viewport: { width: 1600, height: 960 }, permissions: ['microphone'] });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.addInitScript(() => {
    window.__calls = []; window.__running = false; window.__failStart = null;
    const devices = [
      { id: 'in1', name: 'USB Microphone', render: false, default: true },
      { id: 'out1', name: 'Headphones (Realtek)', render: true, default: true },
      { id: 'cab', name: 'CABLE Input (VB-Audio)', render: true, default: false },
    ];
    const state = () => ({ cpu_percent: 7.4, sources: [0, 1, 2, 3, 4].map((i) => ({ name: 'S' + i, gain: 1, muted: false, peak: i === 0 ? 0.5 : 0, underruns: 0 })), destinations: [0, 1, 2].map((i) => ({ name: 'D' + i, gain: 1, peak: i === 1 ? 0.25 : 0, overruns: 0 })) });
    window.__TAURI__ = { event: { listen: (n, f) => { window.__emit = window.__emit || {}; window.__emit[n] = f; return Promise.resolve(() => {}); } }, core: { invoke: async (cmd, args) => {
      if (cmd === 'engine_devices') return JSON.stringify(devices);
      if (cmd === 'engine_start') { if (window.__failStart) throw window.__failStart; window.__running = true; window.__calls.push({ cmd, args }); return null; }
      if (cmd === 'engine_stop') { window.__running = false; window.__calls.push({ cmd }); return null; }
      if (cmd === 'engine_request') {
        if (!window.__running) throw 'The audio engine is not running.';
        const r = JSON.parse(args.line);
        if (r.cmd === 'get_state') return JSON.stringify({ ok: true, data: state() });
        window.__calls.push({ cmd: 'req', r }); return JSON.stringify({ ok: true });
      }
      throw new Error('unexpected ' + cmd);
    } } };
  });
  await p.goto('file://' + path.resolve(__dirname, '../dist/eddy.html')); await p.waitForSelector('.welcome'); await p.click('text=Try the demo'); await p.waitForTimeout(800);
  await p.evaluate(() => __eddy.openGraph(__eddy.PRESETS.find((x) => x.id === 'streaming').make())); await p.waitForTimeout(500);
  await p.evaluate(() => __eddy.setTab('health')); await p.waitForTimeout(600);
  assert(await p.locator('text=Native engine (beta)').count() === 1, 'card is shown inside the desktop app');
  assert(await p.locator('select[aria-label="Microphone"] option').count() === 2, 'microphone list = default + 1 device');
  assert(await p.locator('select[aria-label="Virtual microphone output"] option').count() === 3, 'output list has headphones and cable');
  await p.selectOption('select[aria-label="Microphone"]', 'in1');
  await p.selectOption('select[aria-label="Headphones"]', 'out1');
  await p.selectOption('select[aria-label="Virtual microphone output"]', 'cab');
  await p.click('text=Start native engine'); await p.waitForTimeout(900);
  const calls = await p.evaluate(() => window.__calls);
  const start = calls.find((x) => x.cmd === 'engine_start');
  assert(start && start.args.mic === 'in1' && start.args.out === 'out1' && start.args.virtualMic === 'cab' && start.args.system === null, 'start gets the chosen devices ' + JSON.stringify(start && start.args));
  const reqs = calls.filter((x) => x.cmd === 'req').map((x) => x.r);
  assert(reqs.some((r) => r.cmd === 'set_stage' && r.stage === 'noise' && r.on === true), 'noise stage sent');
  assert(reqs.some((r) => r.cmd === 'set_send' && r.src === 0 && r.dst === 1 && r.gain === 1), 'mic -> Eddy Mic send sent');
  assert(reqs.filter((r) => r.cmd === 'set_send').length === 15, 'all 15 sends written on start (' + reqs.filter((r) => r.cmd === 'set_send').length + ')');
  assert(await p.locator('text=Running. Processor load 7%').count() === 1, 'status shows load from get_state');
  assert(await p.locator('text=Running (native)').count() >= 1, 'side bar says native');
  assert(await p.evaluate(() => __eddy.S.engine.ctx.state) === 'suspended', 'Web Audio is suspended so nothing plays twice');
  await p.mouse.click(5, 5); await p.waitForTimeout(300);
  assert(await p.evaluate(() => __eddy.S.engine.ctx.state) === 'suspended', 'a click does not wake Web Audio while native runs');
  // live edit goes over as ONE small update
  await p.evaluate(() => { window.__calls.length = 0; });
  await p.evaluate(() => { const n = __eddy.S.graph.nodes.find((x) => x.type === 'fx.denoise'); n.params.strength = 0.2; engineSync(); });
  await p.waitForTimeout(400);
  const upd = (await p.evaluate(() => window.__calls)).filter((x) => x.cmd === 'req').map((x) => x.r);
  assert(upd.length === 1 && upd[0].param === 'noise_strength' && upd[0].value === 0.2, 'slider change = one command ' + JSON.stringify(upd));
  assert(await p.locator('text=/recorder only works/').count() === 1, 'unsupported parts are listed');
  // mute hotkey path
  await p.evaluate(() => { window.__calls.length = 0; toggleMicMute(); }); await p.waitForTimeout(400);
  const mu = (await p.evaluate(() => window.__calls)).filter((x) => x.cmd === 'req').map((x) => x.r);
  assert(mu.length === 1 && mu[0].cmd === 'set_source_mute' && mu[0].mute === true, 'mic mute reaches the engine ' + JSON.stringify(mu));
  // engine dies
  await p.evaluate(() => { window.__running = false; window.__emit['engine-exit'](); }); await p.waitForTimeout(300);
  assert(await p.locator('text=stopped unexpectedly').count() >= 1, 'engine exit is reported');
  assert(await p.evaluate(() => __eddy.S.engine.ctx.state) === 'running', 'Web Audio resumes when the engine dies');
  // stop / start failure
  await p.evaluate(() => { window.__failStart = 'Audio device not found: Mic X'; });
  await p.click('text=Start native engine'); await p.waitForTimeout(600);
  assert(await p.locator('text=Audio device not found: Mic X').count() >= 1, 'start failure message is shown');
  assert(await p.evaluate(() => __eddy.S.engine.ctx.state) === 'running', 'Web Audio comes back after a failed start');
  await p.evaluate(() => { window.__failStart = null; });
  await p.click('text=Start native engine'); await p.waitForTimeout(700);
  await p.click('text=Stop native engine'); await p.waitForTimeout(500);
  assert(await p.evaluate(() => __eddy.S.engine.ctx.state) === 'running', 'built-in engine resumes after stop');
  console.log(errs.length ? errs.join('\n') : 'no errors'); if (errs.length) process.exitCode = 1;
  await b.close();
})();
