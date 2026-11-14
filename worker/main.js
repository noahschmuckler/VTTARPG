// The Cloudflare Worker: serves the game's files (bundled in by tools/stage.js as files.js) and the forum API,
// which lives in one Durable Object with its own SQLite storage.
import { DurableObject } from 'cloudflare:workers';
import FILES from './files.js';
import { handleForum, migrate } from './forum.js';

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', md: 'text/plain; charset=utf-8' };

export class Forum extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.db = { all: (q, ...a) => sql.exec(q, ...a).toArray(), run: (q, ...a) => { sql.exec(q, ...a); } };
    migrate(this.db);
  }
  async fetch(req) {
    return handleForum(req, this.db, { admin: req.headers.get('x-admin-verified') === '1' });
  }
}

// Constant-time-ish comparison of the admin key.
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers(req.headers);
      headers.delete('x-admin-verified');
      if (same(req.headers.get('x-admin-key') || '', env.ADMIN_KEY || '')) headers.set('x-admin-verified', '1');
      const stub = env.FORUM.get(env.FORUM.idFromName('forum'));
      return stub.fetch(new Request(req, { headers }));
    }
    let path = url.pathname;
    if (path.endsWith('/')) path += 'index.html';
    const body = FILES[path];
    if (!body) return new Response('Not found', { status: 404 });
    const ext = path.split('.').pop();
    const cache = /\.(png|jpg)$/.test(path) ? 'public, max-age=86400' : 'no-cache';
    return new Response(body, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache } });
  },
};
