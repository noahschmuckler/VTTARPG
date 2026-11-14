// The playtest forum: threads (bugs, ideas, feedback, questions), replies, +1s and optional screenshots.
// Storage-agnostic: `db` is { all(sql, ...args) → rows, run(sql, ...args) }. On Cloudflare it wraps a Durable Object's
// SQLite; locally (tools/serve.js) it wraps node:sqlite. Players never send a role: only requests carrying the admin
// key (the Worker secret ADMIN_KEY, see tools/forum.js) can post as the developer, change status or delete.

export const KINDS = ['bug', 'idea', 'feedback', 'question'];
export const STATUSES = ['open', 'planned', 'fixed', 'wontfix', 'answered'];
const LIMITS = { title: 120, body: 4000, author: 40, ctx: 2000, shot: 400_000, threadsPerHour: 8, postsPerHour: 40 };

export function migrate(db) {
  db.run(`CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, body TEXT, author TEXT,
    device TEXT, ip TEXT, status TEXT DEFAULT 'open', pinned INTEGER DEFAULT 0, created INTEGER, updated INTEGER,
    replies INTEGER DEFAULT 0, dev_replied INTEGER DEFAULT 0, votes INTEGER DEFAULT 0, ctx TEXT, shot INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, thread INTEGER, author TEXT, role TEXT,
    body TEXT, device TEXT, ip TEXT, created INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS shots (thread INTEGER PRIMARY KEY, data TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS votes (thread INTEGER, device TEXT, PRIMARY KEY (thread, device))`);
  db.run(`CREATE INDEX IF NOT EXISTS posts_thread ON posts (thread)`);
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (error, status = 400) => json({ error }, status);
const clean = (v, n) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const reserved = (name, admin) => !admin && /claude|\bdev\b|developer|admin|moderator/i.test(name);
const threadOut = t => ({ id: t.id, kind: t.kind, title: t.title, author: t.author, status: t.status, pinned: !!t.pinned, created: t.created, updated: t.updated, replies: t.replies, devReplied: !!t.dev_replied, votes: t.votes, shot: !!t.shot });

async function hashIp(ip) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('delvers:' + ip));
  return [...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// path: the part after /api/ ; admin: true when the request carried the right admin key
export async function handleForum(req, db, { admin = false, now = Date.now() } = {}) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method;
  const ip = await hashIp(req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local');
  const body = method === 'POST' || method === 'PATCH' ? await req.json().catch(() => ({})) : {};
  const device = clean(body.device || url.searchParams.get('device'), 40);
  const hourAgo = now - 3600_000;
  const tooMany = (table, max) => !admin && db.all(`SELECT COUNT(*) AS n FROM ${table} WHERE (ip = ? OR (device != '' AND device = ?)) AND created > ?`, ip, device, hourAgo)[0].n >= max;

  // GET /api/threads?kind=&status=&sort=recent|votes&ids=1,2
  if (parts[0] === 'threads' && parts.length === 1 && method === 'GET') {
    const where = [], args = [];
    const kind = url.searchParams.get('kind'), status = url.searchParams.get('status');
    if (KINDS.includes(kind)) { where.push('kind = ?'); args.push(kind); }
    if (status === 'open') where.push(`status IN ('open', 'planned')`);
    else if (status === 'closed') where.push(`status IN ('fixed', 'wontfix', 'answered')`);
    const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter(Boolean).slice(0, 100);
    if (ids.length) where.push(`id IN (${ids.map(() => '?').join(',')})`), args.push(...ids);
    const order = url.searchParams.get('sort') === 'votes' ? 'pinned DESC, votes DESC, updated DESC' : 'pinned DESC, updated DESC';
    const rows = db.all(`SELECT * FROM threads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 200`, ...args);
    return json({ threads: rows.map(threadOut) });
  }
  // POST /api/threads { kind, title, body, author, device, ctx, shot }
  if (parts[0] === 'threads' && parts.length === 1 && method === 'POST') {
    const kind = KINDS.includes(body.kind) ? body.kind : 'feedback';
    const title = clean(body.title, LIMITS.title), text = clean(body.body, LIMITS.body), author = clean(body.author, LIMITS.author) || 'Anonymous';
    if (title.length < 3) return fail('Give it a short title');
    if (reserved(author, admin)) return fail('That name is reserved for the developer. Pick another.');
    if (tooMany('threads', LIMITS.threadsPerHour)) return fail('That is a lot of posts in an hour. Try again a little later.', 429);
    const ctx = clean(body.ctx, LIMITS.ctx);
    const shot = typeof body.shot === 'string' && body.shot.startsWith('data:image/jpeg;base64,') && body.shot.length < LIMITS.shot ? body.shot : '';
    db.run(`INSERT INTO threads (kind, title, body, author, device, ip, created, updated, ctx, shot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, kind, title, text, author, device, ip, now, now, ctx, shot ? 1 : 0);
    const id = db.all('SELECT last_insert_rowid() AS id')[0].id;
    if (shot) db.run('INSERT INTO shots (thread, data) VALUES (?, ?)', id, shot);
    return json({ id }, 201);
  }
  const id = Number(parts[1]);
  const thread = parts[0] === 'threads' && id ? db.all('SELECT * FROM threads WHERE id = ?', id)[0] : null;
  if (parts[0] === 'threads' && id && !thread) return fail('No such thread', 404);
  // GET /api/threads/:id
  if (thread && parts.length === 2 && method === 'GET') {
    const posts = db.all('SELECT id, author, role, body, created FROM posts WHERE thread = ? ORDER BY id', id);
    const voted = device ? db.all('SELECT 1 FROM votes WHERE thread = ? AND device = ?', id, device).length > 0 : false;
    return json({ thread: { ...threadOut(thread), body: thread.body, ctx: thread.ctx, voted, ...(admin ? { device: thread.device, ip: thread.ip } : {}) }, posts });
  }
  // GET /api/threads/:id/shot
  if (thread && parts[2] === 'shot' && method === 'GET') {
    const row = db.all('SELECT data FROM shots WHERE thread = ?', id)[0];
    if (!row) return fail('No screenshot', 404);
    const bin = Uint8Array.from(atob(row.data.split(',')[1]), c => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
  }
  // POST /api/threads/:id/posts { body, author, device } — admin posts are the developer's
  if (thread && parts[2] === 'posts' && method === 'POST') {
    const text = clean(body.body, LIMITS.body), author = clean(body.author, LIMITS.author) || (admin ? 'Claude (dev)' : 'Anonymous');
    if (!text) return fail('Write something first');
    if (reserved(author, admin)) return fail('That name is reserved for the developer. Pick another.');
    if (tooMany('posts', LIMITS.postsPerHour)) return fail('That is a lot of replies in an hour. Try again a little later.', 429);
    const role = admin ? 'dev' : 'player';
    db.run('INSERT INTO posts (thread, author, role, body, device, ip, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, author, role, text, device, ip, now);
    db.run(`UPDATE threads SET replies = replies + 1, updated = ?, dev_replied = CASE WHEN ? THEN 1 ELSE dev_replied END WHERE id = ?`, now, admin ? 1 : 0, id);
    if (admin && STATUSES.includes(body.status)) db.run('UPDATE threads SET status = ? WHERE id = ?', body.status, id);
    return json({ ok: true }, 201);
  }
  // POST /api/threads/:id/vote { device } — toggles a +1
  if (thread && parts[2] === 'vote' && method === 'POST') {
    if (!device) return fail('No device id');
    const had = db.all('SELECT 1 FROM votes WHERE thread = ? AND device = ?', id, device).length > 0;
    if (had) db.run('DELETE FROM votes WHERE thread = ? AND device = ?', id, device);
    else db.run('INSERT INTO votes (thread, device) VALUES (?, ?)', id, device);
    db.run('UPDATE threads SET votes = (SELECT COUNT(*) FROM votes WHERE thread = ?) WHERE id = ?', id, id);
    return json({ voted: !had, votes: db.all('SELECT votes FROM threads WHERE id = ?', id)[0].votes });
  }
  // admin: PATCH /api/threads/:id { status, pinned, kind }, DELETE /api/threads/:id, DELETE /api/posts/:id
  if (admin && thread && parts.length === 2 && method === 'PATCH') {
    if (STATUSES.includes(body.status)) db.run('UPDATE threads SET status = ?, updated = ? WHERE id = ?', body.status, now, id);
    if (body.pinned != null) db.run('UPDATE threads SET pinned = ? WHERE id = ?', body.pinned ? 1 : 0, id);
    if (KINDS.includes(body.kind)) db.run('UPDATE threads SET kind = ? WHERE id = ?', body.kind, id);
    return json({ ok: true });
  }
  if (admin && thread && parts.length === 2 && method === 'DELETE') {
    for (const t of ['posts', 'votes']) db.run(`DELETE FROM ${t} WHERE thread = ?`, id);
    db.run('DELETE FROM shots WHERE thread = ?', id);
    db.run('DELETE FROM threads WHERE id = ?', id);
    return json({ ok: true });
  }
  if (admin && parts[0] === 'posts' && Number(parts[1]) && method === 'DELETE') {
    const p = db.all('SELECT thread FROM posts WHERE id = ?', Number(parts[1]))[0];
    if (!p) return fail('No such post', 404);
    db.run('DELETE FROM posts WHERE id = ?', Number(parts[1]));
    db.run('UPDATE threads SET replies = (SELECT COUNT(*) FROM posts WHERE thread = ?), dev_replied = (SELECT COUNT(*) > 0 FROM posts WHERE thread = ? AND role = ?) WHERE id = ?', p.thread, p.thread, 'dev', p.thread);
    return json({ ok: true });
  }
  if (parts[0] === 'whoami') return json({ admin });
  return fail('Not found', 404);
}
