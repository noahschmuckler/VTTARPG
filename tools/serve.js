// Local server: the game's files plus the forum API on node:sqlite (data/forum.sqlite). npm start → http://localhost:8790
// FORUM_ADMIN_KEY sets a local admin key for trying developer replies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(fileURLToPath(import.meta.url), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/plain' };
const port = Number(process.env.PORT) || 8790;
const { DatabaseSync } = await import('node:sqlite');
const { handleForum, migrate } = await import('../worker/forum.js');
mkdirSync(join(root, 'data'), { recursive: true });
const sqlite = new DatabaseSync(join(root, 'data', 'forum.sqlite'));
const db = { all: (q, ...a) => sqlite.prepare(q).all(...a), run: (q, ...a) => { sqlite.prepare(q).run(...a); } };
migrate(db);
createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const admin = !!process.env.FORUM_ADMIN_KEY && req.headers['x-admin-key'] === process.env.FORUM_ADMIN_KEY;
    const out = await handleForum(r, db, { admin });
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, () => console.log(`Delvers' Descent: http://localhost:${port}`));
