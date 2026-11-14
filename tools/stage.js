// Build dist/: the game files plus the Worker (worker/main.js) that serves them and the forum API. Every file is bundled into the Worker as a
// binary module (stored as *.bin so the bundler treats the game's own JS as data) (no separate asset upload step), and dist/files.js maps URL paths to them.
import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/site', { recursive: true });
for (const p of ['index.html', 'src', 'assets', 'CREDITS.md']) cpSync(p, `dist/site/${p}`, { recursive: true });
const files = [];
const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else { renameSync(p, p + '.bin'); files.push(relative('dist', p)); } } };
walk('dist/site');
const imports = files.map((f, i) => `import f${i} from './${f}.bin';`).join('\n');
const map = files.map((f, i) => `  ${JSON.stringify('/' + f.slice('site/'.length))}: f${i},`).join('\n');
writeFileSync('dist/files.js', `${imports}\nexport default {\n${map}\n};\n`);
for (const f of ['main.js', 'forum.js']) cpSync(`worker/${f}`, `dist/${f}`);
// a build stamp the game shows and attaches to playtest reports
let hash = 'local';
try { hash = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* not a git checkout */ }
const stamp = `${hash} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
const vfile = files.find(f => f === 'site/src/version.js');
writeFileSync(`dist/${vfile}.bin`, `export const BUILD = ${JSON.stringify(stamp)};\n`);
console.log(`staged ${files.length} files into dist/`);
