# Eddy (web build)

Open `dist/eddy.html` in Chrome or Edge. Double-click is enough, no install, no server.

- Real Web Audio engine: noise removal, gate, EQ, compressor, auto level, limiter, echo, reverb, pan, recorder.
- Graph editor: drag nodes, drag wires from dots, double-click to add, double-click a cable to insert, pin settings onto cards, rename/recolour/re-icon every node, save your own nodes.
- Send a result to another app as a microphone: add an Output node, pick "CABLE Input" (VB-Cable) as its device, then choose "CABLE Output" as the mic in that app.

Rebuild after editing `src/`: `node build.mjs`. Tests: `node test/engine.test.js`, `node test/ui2.test.js`, `node test/ui3.test.js` (need Playwright + Chromium).
