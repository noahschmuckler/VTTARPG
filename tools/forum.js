#!/usr/bin/env node
// The developer's side of the playtest forum. Claude uses this (with the owner's direction) to read reports and reply.
//
//   node tools/forum.js key                      make a fresh admin key, store it as the Worker secret ADMIN_KEY
//                                                (Cloudflare API) and in .forum-key (git-ignored)
//   node tools/forum.js list [open|closed|all] [bug|idea|feedback|question]
//   node tools/forum.js show <id>                thread, context, replies (and screenshot URL)
//   node tools/forum.js reply <id> "text" [--status fixed|planned|wontfix|answered|open] [--as "Name"]
//   node tools/forum.js status <id> <status>     pin <id> / unpin <id> / delete <id> / delete-post <id>
//
// FORUM_URL overrides the site (default: the live Worker; http://localhost:8790 with FORUM_ADMIN_KEY for local tests).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SITE = process.env.FORUM_URL || 'https://delvers-descent.noah-schmuckler.workers.dev';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || 'a05002437e81e8e703e76f628668b8e7';
const SCRIPT = 'delvers-descent';
const KEYFILE = new URL('../.forum-key', import.meta.url);
const key = () => process.env.FORUM_ADMIN_KEY || (existsSync(KEYFILE) ? readFileSync(KEYFILE, 'utf8').trim() : '');
const [cmd, ...args] = process.argv.slice(2);
const flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };

async function api(method, path, body) {
  const r = await fetch(SITE + '/api/' + path, { method, headers: { 'content-type': 'application/json', 'x-admin-key': key() }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.error || ''}`);
  return j;
}
const when = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

if (cmd === 'key') {
  const k = randomBytes(24).toString('base64url');
  // curl, not fetch: it honours HTTPS_PROXY (in Claude's sessions the proxy adds the Cloudflare credentials);
  // elsewhere set CLOUDFLARE_API_TOKEN
  const out = execFileSync('curl', ['-s', '-X', 'PUT', `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}/secrets`,
    '-H', 'content-type: application/json', ...(process.env.CLOUDFLARE_API_TOKEN ? ['-H', `authorization: Bearer ${process.env.CLOUDFLARE_API_TOKEN}`] : []),
    '--data', JSON.stringify({ name: 'ADMIN_KEY', text: k, type: 'secret_text' })]).toString();
  const j = JSON.parse(out || '{}');
  if (!j.success) { console.error('Could not set the secret:', JSON.stringify(j.errors)); process.exit(1); }
  writeFileSync(KEYFILE, k + '\n');
  console.log('New admin key set on the Worker and saved to .forum-key. (Any earlier key no longer works.)');
} else if (cmd === 'list') {
  const status = ['open', 'closed', 'all'].find(s => args.includes(s)) || 'open';
  const kind = args.find(a => ['bug', 'idea', 'feedback', 'question'].includes(a));
  const q = new URLSearchParams({ ...(status !== 'all' ? { status } : {}), ...(kind ? { kind } : {}) });
  const { threads } = await api('GET', 'threads?' + q);
  if (!threads.length) console.log('(nothing)');
  for (const t of threads) console.log(`#${String(t.id).padEnd(4)} ${t.kind.padEnd(8)} ${t.status.padEnd(8)} +${t.votes} 💬${t.replies}${t.devReplied ? ' ✓dev' : '     '} ${when(t.updated)}  ${t.title}  — ${t.author}`);
} else if (cmd === 'show') {
  const { thread: t, posts } = await api('GET', `threads/${args[0]}`);
  console.log(`#${t.id} [${t.kind}, ${t.status}${t.pinned ? ', pinned' : ''}] ${t.title}\nby ${t.author} · ${when(t.created)} · +${t.votes}${t.shot ? `\nscreenshot: ${SITE}/api/threads/${t.id}/shot` : ''}\ncontext: ${t.ctx || '-'}\n\n${t.body}\n`);
  for (const p of posts) console.log(`--- #${p.id} ${p.role === 'dev' ? '[DEV] ' : ''}${p.author} · ${when(p.created)}\n${p.body}\n`);
} else if (cmd === 'reply') {
  const status = flag('status'), as = flag('as');
  await api('POST', `threads/${args[0]}/posts`, { body: args.slice(1).join(' '), status, ...(as ? { author: as } : {}) });
  console.log('Replied' + (status ? ` and marked ${status}` : '') + '.');
} else if (cmd === 'status') { await api('PATCH', `threads/${args[0]}`, { status: args[1] }); console.log('OK'); }
else if (cmd === 'pin' || cmd === 'unpin') { await api('PATCH', `threads/${args[0]}`, { pinned: cmd === 'pin' }); console.log('OK'); }
else if (cmd === 'delete') { await api('DELETE', `threads/${args[0]}`); console.log('Deleted.'); }
else if (cmd === 'delete-post') { await api('DELETE', `posts/${args[0]}`); console.log('Deleted.'); }
else console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
