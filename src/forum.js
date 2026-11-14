// The playtest forum inside the game: browse threads, read and reply, +1, and file bugs, ideas, feedback or questions
// (with the game's state and an optional screenshot attached). The server side is worker/forum.js.
import { BUILD } from './version.js';

const KIND = { bug: ['🐞', 'Bug'], idea: ['💡', 'Idea'], feedback: ['💬', 'Feedback'], question: ['❓', 'Question'] };
const STATUS = { open: 'Open', planned: 'Planned', fixed: 'Fixed', wontfix: "Won't fix", answered: 'Answered' };
const store = {
  get(k, d) { try { const v = localStorage.getItem('dd-forum-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dd-forum-' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const device = () => { let d = store.get('device'); if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('device', d); } return d; };
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const textHTML = (esc, s) => esc(s).replace(/\n/g, '<br>');

async function call(method, path, body) {
  const r = await fetch('/api/' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify({ device: device(), ...body }) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error (${r.status})`);
  return j;
}

// Threads this browser started or replied to: a dot on the forum button when the developer has answered since.
export async function checkReplies() {
  const mine = store.get('mine', {});
  const ids = Object.keys(mine);
  if (!ids.length) return false;
  try {
    const { threads } = await call('GET', `threads?ids=${ids.join(',')}`);
    return threads.some(t => t.devReplied && t.updated > (mine[t.id] || 0));
  } catch { return false; }
}
const seen = id => { const mine = store.get('mine', {}); mine[id] = Date.now() + 1000; store.set('mine', mine); };

// ui: { modal, closeModal, esc, toast, context() → string, screenshot() → data URL | null, onClose }
export function openForum(ui, view = { kind: 'list' }) {
  const { esc } = ui;
  const state = { filter: store.get('filter', 'all'), status: store.get('status', 'open'), sort: store.get('sort', 'recent') };
  const go = v => openForum(ui, v);
  const shell = (inner, back = false) => {
    const p = ui.modal(`<button class="close">✕</button><div class="forum">${back ? '<button class="fback">‹ All threads</button>' : ''}${inner}</div>`, { onClose: ui.onClose });
    p.querySelector('.close').onclick = ui.closeModal;
    const b = p.querySelector('.fback'); if (b) b.onclick = () => go({ kind: 'list' });
    return p;
  };

  if (view.kind === 'list') {
    const p = shell(`<div class="fhead"><h2>Playtest forum</h2><button class="primary" id="fNew">+ New post</button></div>
      <p class="dim">Report bugs, suggest ideas, give feedback or ask questions. Everyone can read every thread; the developer replies here. Build ${esc(BUILD)}.</p>
      <div class="fbar"><div class="chips">${[['all', 'All'], ...Object.entries(KIND).map(([k, [i, l]]) => [k, `${i} ${l}s`])].map(([k, l]) => `<button data-f="${k}" class="${state.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="chips">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'Everything']].map(([k, l]) => `<button data-s="${k}" class="${state.status === k ? 'on' : ''}">${l}</button>`).join('')}
      <button data-o="${state.sort === 'votes' ? 'recent' : 'votes'}">Sort: ${state.sort === 'votes' ? 'most +1' : 'latest'}</button></div></div>
      <div class="flist"><p class="dim">Loading…</p></div>`);
    p.querySelector('#fNew').onclick = () => go({ kind: 'new' });
    p.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { store.set('filter', b.dataset.f); go(view); });
    p.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { store.set('status', b.dataset.s); go(view); });
    p.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { store.set('sort', b.dataset.o); go(view); });
    const q = new URLSearchParams({ sort: state.sort, ...(state.filter !== 'all' ? { kind: state.filter } : {}), ...(state.status !== 'all' ? { status: state.status } : {}) });
    call('GET', 'threads?' + q).then(({ threads }) => {
      const mine = store.get('mine', {});
      const el = p.querySelector('.flist');
      if (!el) return;
      el.innerHTML = threads.length ? threads.map(t => `<button class="frow ${t.pinned ? 'pinned' : ''}" data-id="${t.id}">
          <span class="fk">${KIND[t.kind]?.[0] || '💬'}</span>
          <span class="ft"><b>${t.pinned ? '📌 ' : ''}${esc(t.title)}</b><span class="dim">${esc(t.author)} · ${ago(t.updated)}${mine[t.id] ? ' · yours' : ''}</span></span>
          <span class="fm"><span class="st st-${t.status}">${STATUS[t.status] || t.status}</span><span class="dim">+${t.votes} · 💬 ${t.replies}${t.devReplied ? ' · <span class="devdot">dev</span>' : ''}</span></span></button>`).join('')
        : '<p class="dim">Nothing here yet. Be the first!</p>';
      el.querySelectorAll('.frow').forEach(b => b.onclick = () => go({ kind: 'thread', id: Number(b.dataset.id) }));
    }).catch(e => { const el = p.querySelector('.flist'); if (el) el.innerHTML = `<p class="dim">Couldn't load the forum: ${esc(e.message)}</p>`; });
    return;
  }

  if (view.kind === 'new') {
    const kind = view.preset || 'bug', name = store.get('name', '');
    const p = shell(`<h2>New post</h2>
      <div class="chips kinds">${Object.entries(KIND).map(([k, [i, l]]) => `<button data-k="${k}" class="${k === kind ? 'on' : ''}">${i} ${l}</button>`).join('')}</div>
      <label>Title<input id="fTitle" maxlength="120" placeholder="${kind === 'bug' ? 'What went wrong, in a few words' : kind === 'idea' ? 'Your idea in a few words' : 'In a few words'}"></label>
      <label>Details<textarea id="fBody" rows="6" maxlength="4000" placeholder="${kind === 'bug' ? 'What did you do, what happened, what did you expect?' : 'Tell us more…'}"></textarea></label>
      <label>Your name<input id="fName" maxlength="40" value="${esc(name)}" placeholder="Shown with your posts"></label>
      <label class="chk"><input type="checkbox" id="fShot" ${kind === 'bug' ? 'checked' : ''}> Attach a screenshot of the game</label>
      <label class="chk"><input type="checkbox" id="fCtx" checked> Attach game details (build, scene, party, device)</label>
      <div class="dim fctx">${esc(ui.context())}</div>
      <div class="btnrow"><button id="fCancel">Cancel</button><button class="primary" id="fSend">Post</button></div>`, true);
    p.querySelectorAll('[data-k]').forEach(b => b.onclick = () => go({ kind: 'new', preset: b.dataset.k }));
    p.querySelector('#fCancel').onclick = () => go({ kind: 'list' });
    p.querySelector('#fSend').onclick = async e => {
      const btn = e.currentTarget, author = p.querySelector('#fName').value.trim();
      btn.disabled = true; btn.textContent = 'Posting…';
      try {
        store.set('name', author);
        const shot = p.querySelector('#fShot').checked ? ui.screenshot() : null;
        const { id } = await call('POST', 'threads', { kind, title: p.querySelector('#fTitle').value, body: p.querySelector('#fBody').value, author, ctx: p.querySelector('#fCtx').checked ? ui.context() : '', shot });
        seen(id);
        ui.toast('Posted', 'Thanks! You can follow the thread here; a dot on 💬 means the developer replied.');
        go({ kind: 'thread', id });
      } catch (err) { ui.toast(err.message, '', 'err'); btn.disabled = false; btn.textContent = 'Post'; }
    };
    return;
  }

  if (view.kind === 'thread') {
    const p = shell('<p class="dim">Loading…</p>', true);
    call('GET', `threads/${view.id}?device=${device()}`).then(({ thread: t, posts }) => {
      const mine = store.get('mine', {});
      if (mine[t.id]) seen(t.id);
      const box = p.querySelector('.forum');
      box.innerHTML = `<button class="fback">‹ All threads</button>
        <div class="fthread"><div class="fk big">${KIND[t.kind]?.[0] || '💬'}</div><div><h2>${t.pinned ? '📌 ' : ''}${esc(t.title)}</h2>
        <div class="dim">${KIND[t.kind]?.[1] || ''} · <span class="st st-${t.status}">${STATUS[t.status] || t.status}</span> · ${esc(t.author)} · ${ago(t.created)}</div></div></div>
        <div class="fpost first">${t.body ? textHTML(esc, t.body) : '<span class="dim">(no details)</span>'}
          ${t.shot ? `<a href="/api/threads/${t.id}/shot" target="_blank" rel="noopener"><img class="fshot" src="/api/threads/${t.id}/shot" alt="Screenshot" loading="lazy"></a>` : ''}
          ${t.ctx ? `<div class="dim fctx">${esc(t.ctx)}</div>` : ''}
          <div><button class="vote ${t.voted ? 'on' : ''}" id="fVote">+1 · ${t.votes}</button> <span class="dim">${t.kind === 'bug' ? 'Seen it too?' : 'Want this?'}</span> <button id="fLink" class="link">🔗 Copy link</button></div></div>
        ${posts.map(x => `<div class="fpost ${x.role === 'dev' ? 'dev' : ''}"><div class="fwho"><b>${esc(x.author)}</b>${x.role === 'dev' ? ' <span class="devdot">developer</span>' : ''} <span class="dim">· ${ago(x.created)}</span></div>${textHTML(esc, x.body)}</div>`).join('')}
        <div class="freply"><textarea id="fReply" rows="3" maxlength="4000" placeholder="Add to the thread…"></textarea>
          <div class="btnrow"><input id="fName" maxlength="40" value="${esc(store.get('name', ''))}" placeholder="Your name"><button class="primary" id="fSend">Reply</button></div></div>`;
      box.querySelector('.fback').onclick = () => go({ kind: 'list' });
      box.querySelector('#fLink').onclick = async () => { const u = `${location.origin}/#thread-${t.id}`; try { await navigator.clipboard.writeText(u); ui.toast('Link copied', u); } catch { ui.toast('Link', u); } };
      box.querySelector('#fVote').onclick = async e => {
        try { const r = await call('POST', `threads/${t.id}/vote`, {}); e.currentTarget.classList.toggle('on', r.voted); e.currentTarget.textContent = `+1 · ${r.votes}`; } catch (err) { ui.toast(err.message, '', 'err'); }
      };
      box.querySelector('#fSend').onclick = async e => {
        const btn = e.currentTarget, author = box.querySelector('#fName').value.trim();
        btn.disabled = true;
        try {
          store.set('name', author);
          await call('POST', `threads/${t.id}/posts`, { body: box.querySelector('#fReply').value, author });
          seen(t.id);
          go({ kind: 'thread', id: t.id });
        } catch (err) { ui.toast(err.message, '', 'err'); btn.disabled = false; }
      };
    }).catch(e => { p.querySelector('.forum').innerHTML = `<button class="fback">‹ All threads</button><p class="dim">Couldn't load that thread: ${esc(e.message)}</p>`; p.querySelector('.fback').onclick = () => go({ kind: 'list' }); });
  }
}
