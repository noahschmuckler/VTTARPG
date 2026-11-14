// Build dist/: the game files plus a Worker that serves them. Every file is bundled into the Worker as a
// binary module (stored as *.bin so the bundler treats the game's own JS as data) (no separate asset upload step), and dist/files.js maps URL paths to them.
import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/site', { recursive: true });
for (const p of ['index.html', 'src', 'assets', 'CREDITS.md']) cpSync(p, `dist/site/${p}`, { recursive: true });
const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { renameSync(p, p + '.bin'); files.push(relative('dist', p)); } } };
walk('dist/site');
const imports = files.map((f, i) => `import f${i} from './${f}.bin';`).join('\n');
const map = files.map((f, i) => `  ${JSON.stringify('/' + f.slice('site/'.length))}: f${i},`).join('\n');
writeFileSync('dist/files.js', `${imports}\nexport default {\n${map}\n};\n`);
writeFileSync('dist/worker.js', `import FILES from './files.js';
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', md: 'text/plain; charset=utf-8' };
export default {
  fetch(req) {
    let path = new URL(req.url).pathname;
    if (path.endsWith('/')) path += 'index.html';
    const body = FILES[path];
    if (!body) return new Response('Not found', { status: 404 });
    const ext = path.split('.').pop();
    const cache = /\\.(png|jpg)$/.test(path) ? 'public, max-age=86400' : 'no-cache';
    return new Response(body, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache } });
  },
};
`);
console.log(`staged ${files.length} files into dist/`);
