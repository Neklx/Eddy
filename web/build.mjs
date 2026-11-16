import fs from 'node:fs';
const r = (f) => fs.readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
const order = ['icons.js', 'worklets.js', 'nodes.js', 'engine.js', 'graph.js', 'ui.js', 'editor.js', 'views.js', 'mixview.js', 'app.js'];
const js = order.map((f) => '/* ==== ' + f + ' ==== */\n' + r(f)).join('\n').replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Eddy</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Crect width='32' height='32' rx='8' fill='%230B0A18'/%3E%3Cpath d='M4 18c4-9 14-12 21-6 4 4 2 10-3 11-4 1-7-2-6-5 1-3 5-3 6-1' stroke='%23A78BFA' stroke-width='2.2' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
${r('styles.css')}
</style></head>
<body><noscript>Eddy needs JavaScript.</noscript>
<script>
${js}
</script></body></html>`;
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/eddy.html', import.meta.url), html);
console.log('dist/eddy.html', (html.length / 1024).toFixed(0) + ' KB');
