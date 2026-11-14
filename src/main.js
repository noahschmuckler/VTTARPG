// Delvers' Descent: the controller. Input, HUD, screens, and the loop that plays the rules' effects.
import * as R from './game/rules.js';
import { View, fmt } from './game/render.js';
import { loadAssets, heroSheet, A } from './game/assets.js';
import { rngFrom, key, dist, pathTo, tile } from './game/grid.js';
import { HERO_COLOR, rosterFor } from './game/content.js';
import { cardSVG, cardBackSVG, consumableSVG } from './ledger/art.js';
import { LINES, pick as pickLine, newDeck, scoreHand, handName, compareHands, houseSwaps } from './ledger/merchant.js';
import { SLOT_LABEL, RARITIES, ENEMY_TYPES } from './ledger/engine.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SAVE = 'delvers-descent-v1';
const RC = { common: 'var(--common)', magic: 'var(--magic)', rare: 'var(--rare)', legendary: 'var(--legendary)' };
const rarityColor = it => (it.set ? R.SETS[it.set].color : RC[it.rarity] || 'var(--common)');

let G = null, rng = rngFrom(Date.now() & 0xffffffff), view, busy = false, mode = { kind: 'idle' }, speed = 1, hover = null;
let pendingLoot = [], lastSave = 0;

// ================================================================== boot
async function boot() {
  view = new View($('#view'));
  try {
    await loadAssets('assets/', p => { $('#loading .bar i').style.width = `${Math.round(p * 100)}%`; });
  } catch (e) {
    $('#loading .sub').textContent = `Could not load the art: ${e.message}. Serve this folder over http (npm start).`;
    return;
  }
  $('#loading').remove();
  let last = performance.now();
  const loop = now => {
    const dt = Math.min(0.05, (now - last) / 1000) * speed;
    last = now;
    view.update(dt);
    view.draw();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  bindInput();
  titleScreen();
}

// ================================================================== saving
function save() {
  if (!G) return;
  try {
    const { fx, ...rest } = G;
    localStorage.setItem(SAVE, JSON.stringify({ G: rest, rs: rng.state() }));
  } catch { /* private mode: no saves */ }
}
function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(SAVE) || 'null'); return s?.G?.hero ? s : null; } catch { return null; }
}
function clearSave() { try { localStorage.removeItem(SAVE); } catch { /* ignore */ } }

// ================================================================== modal helpers
function modal(html, { narrow = false, onClose = null } = {}) {
  const m = $('#modal'), p = m.querySelector('.panel');
  p.className = 'panel' + (narrow ? ' narrow' : '');
  p.innerHTML = html;
  m.hidden = false;
  m.onClose = onClose;
  return p;
}
function closeModal() {
  const m = $('#modal');
  if (m.hidden) return;
  m.hidden = true;
  const f = m.onClose; m.onClose = null;
  if (f) f();
}
const isModal = () => !$('#modal').hidden;
function narrate(title, text, button = 'Continue') {
  return new Promise(res => {
    const p = modal(`<h2>${esc(title)}</h2><div class="narr">${esc(text)}</div><div class="btnrow"><button class="primary" id="nOk">${esc(button)}</button></div>`, { narrow: true, onClose: res });
    p.querySelector('#nOk').onclick = closeModal;
  });
}

// ================================================================== title and class select
function heroPortrait(cls, w = 96, h = 120) {
  const c = document.createElement('canvas');
  c.width = w * 2; c.height = h * 2;
  const g = c.getContext('2d'), M = A.manifest.units.hero, img = heroSheet(cls);
  const row = ((M.base - 2) % 8 + 8) % 8, sc = 2.6;
  g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(w, h * 1.72, 40, 14, 0, 0, 7); g.fill();
  g.strokeStyle = HERO_COLOR[cls]; g.lineWidth = 3; g.stroke();
  g.drawImage(img, 0, row * M.fh, M.fw, M.fh, w - M.ax * sc, h * 1.72 - M.ay * sc, M.fw * sc, M.fh * sc);
  return c;
}
function titleScreen() {
  $('#hud').hidden = true;
  const saved = loadSave();
  let sel = 'ironclad';
  const cards = Object.entries(R.CLASSES).map(([k, C]) => `
    <div class="cls ${k === sel ? 'sel' : ''}" data-cls="${k}">
      <div class="pc" data-cls="${k}"></div>
      <h3 style="color:${HERO_COLOR[k]}">${C.glyph} ${esc(C.name)}</h3>
      <div class="role">${esc(C.role)}</div>
      <div class="stats"><span>❤ ${fmt(C.base.maxHp)}</span><span>⛨ ${C.base.armor}%</span><span>⚄ ${C.base.dice} dice</span><span>⚔ ${fmt(C.base.damage)}</span><span>➜ move ${C.base.move}</span><span>◎ ${C.base.reach ? 'reach ' + C.base.reach : 'melee'}</span></div>
      <ul>${C.abilities.map(a => `<li title="${esc(a.text)}"><b>${esc(a.name)}</b> <span class="dim">${a.cost}</span></li>`).join('')}</ul>
    </div>`).join('');
  const p = modal(`<div class="title-screen">
    <h1 class="logo">Delvers' Descent</h1>
    <div class="tag">A solo descent to the Eighth Gate · turn-based tactics on the Delvers' Ledger rules</div>
    <div class="classes">${cards}</div>
    <div class="name-row"><input id="hName" maxlength="20" placeholder="Name your hero"><button class="primary" id="go">Begin the descent</button></div>
    <div class="btnrow" style="justify-content:center">${saved ? `<button id="cont">Continue: ${esc(saved.G.hero.name)}, ${esc(R.CLASSES[saved.G.hero.cls].name)} (${esc(saved.G.adv.acts[saved.G.act]?.name || '')})</button>` : ''}<button id="howto">How to play</button></div>
    <div class="credits">Art: Kenney (CC0), Flare monster renders by johndh, Wciow and ryan.dansie on OpenGameArt (CC0 / CC-BY-SA 3.0). Rules: Delvers' Ledger. See CREDITS.md.</div>
  </div>`);
  p.querySelectorAll('.pc').forEach(el => el.appendChild(heroPortrait(el.dataset.cls)));
  p.querySelectorAll('.cls').forEach(el => el.onclick = () => {
    sel = el.dataset.cls;
    p.querySelectorAll('.cls').forEach(x => x.classList.toggle('sel', x === el));
  });
  p.querySelector('#go').onclick = () => {
    const name = p.querySelector('#hName').value.trim() || R.CLASSES[sel].name;
    clearSave();
    rng = rngFrom((Math.random() * 2 ** 32) >>> 0);
    G = R.newRun(name, sel, rng);
    $('#modal').hidden = true;
    beginScene();
  };
  p.querySelector('#hName').onkeydown = e => { if (e.key === 'Enter') p.querySelector('#go').click(); };
  p.querySelector('#howto').onclick = () => help(() => titleScreen());
  if (saved) p.querySelector('#cont').onclick = () => {
    G = { ...saved.G, fx: [] };
    rng = rngFrom(saved.rs);
    $('#modal').hidden = true;
    resume();
  };
}
async function resume() {
  if (G.stage === 'camp') return camp();
  if (G.stage === 'next') return beginScene();
  if (G.stage === 'victory') return victory();
  if (G.stage === 'dead') { enterScene(); return died(); }
  enterScene();
}

// ================================================================== scenes
async function beginScene() {
  R.startScene(G, rng);
  const sc = R.sceneDef(G);
  G.fx = G.fx.filter(e => e.t !== 'spawn' && e.t !== 'log');
  save();
  enterScene();
  if (G.scene === 0) await banner(G.adv.acts[G.act].name, sc.name);
  if (sc.intro) await narrate(sc.name, sc.intro, 'Fight');
  refresh();
}
function enterScene() {
  $('#hud').hidden = false;
  $('#log').innerHTML = '';
  for (const l of G.log.slice(0, 8).reverse()) addLog(l.text, l.kind);
  view.attach(G);
  mode = { kind: 'idle' };
  refresh();
}
async function afterStage() {
  if (G.stage === 'dead') return died();
  if (G.stage === 'next' || G.stage === 'camp' || G.stage === 'victory') {
    const prevAct = G.stage === 'camp' ? G.act - 1 : G.act;
    const prevScene = G.stage === 'next' ? G.scene - 1 : G.adv.acts[prevAct].scenes.length - 1;
    const sc = G.adv.acts[prevAct].scenes[prevScene];
    if (sc?.outro) await narrate(sc.name, sc.outro);
    save();
    if (G.stage === 'victory') return victory();
    if (G.stage === 'camp') return camp();
    return beginScene();
  }
}
function died() {
  refresh();
  const p = modal(`<h2>You have fallen</h2><div class="narr">${esc(G.hero.name)} lies still on the cold stones of ${esc(R.sceneDef(G)?.name || 'the deep')}. But the Ledger does not close an account so easily…</div>
    <div class="btnrow"><button id="newrun">New run</button><button class="primary" id="retry">Rise again (retry the scene)</button></div>`, { narrow: true });
  p.querySelector('#retry').onclick = () => { $('#modal').hidden = true; R.retryScene(G, rng); G.fx = G.fx.filter(e => e.t !== 'spawn' && e.t !== 'log'); save(); enterScene(); };
  p.querySelector('#newrun').onclick = () => { clearSave(); titleScreen(); };
}
function victory() {
  const t = G.hero.tally || {};
  const p = modal(`<h2>The Eighth Gate is shut</h2><div class="narr">${esc(G.hero.name)} the ${esc(R.CLASSES[G.hero.cls].name)} walked into the dark alone and came back out.</div>
    <div class="statgrid" style="max-width:320px"><span>Scenes cleared</span><span>${G.stats.scenes}</span><span>Rounds fought</span><span>${G.stats.rounds}</span><span>Minions slain</span><span>${t.minion || 0}</span><span>Elites slain</span><span>${t.elite || 0}</span><span>Bosses slain</span><span>${t.boss || 0}</span></div>
    <div class="btnrow"><button class="primary" id="again">Another descent</button></div>`, { narrow: true });
  clearSave();
  p.querySelector('#again').onclick = () => titleScreen();
}

// ================================================================== acting
async function act(fn, { quiet = false } = {}) {
  if (busy || !G) return;
  busy = true;
  const r = fn();
  if (r && !r.ok) { if (!quiet) toast(r.error, '', 'err'); G.fx.length = 0; busy = false; refresh(); return r; }
  refresh();
  await playFx();
  busy = false;
  if (mode.kind === 'power' && !R.powerUsable(G, mode.p) && !mode.keep) mode = { kind: 'idle' };
  refresh();
  save();
  if (pendingLoot.length) showLoot();
  await afterStage();
  return r;
}
async function playFx() {
  while (G.fx.length) {
    const e = G.fx.shift();
    switch (e.t) {
      case 'log': addLog(e.text, e.kind); break;
      case 'dice': await showDice(e); break;
      case 'toast': toast(e.title, e.text); break;
      case 'unlock': toast(e.title, e.text, 'unlock', 9000); break;
      case 'ability': toast(`${e.icon} ${foeName(e.id)}: ${e.name}`, e.text, 'foe', 5000); await view.wait(0.25); break;
      case 'loot': pendingLoot.push(e); break;
      case 'phase': if (e.name === 'Enemy phase') { if (R.living(G).length) await banner('Enemy phase'); } else await banner(e.name, e.energy ? `+${e.energy} energy` : ''); break;
      case 'power': await banner(e.name, '', 0.8); break;
      case 'cleared': await banner('Scene clear', 'The stair down glows in the west wall'); toast('Scene clear', `You catch your breath (+${Math.round(R.SOLO.breather * 100)}% health). Open the chests, then take the spiral stair.`); break;
      default: await view.play(e);
    }
    refresh(true);
  }
}
const foeName = id => G.foes.find(f => f.id === id)?.name || 'Foe';

// ================================================================== HUD
function addLog(text, kind) {
  const el = document.createElement('div');
  el.className = kind || '';
  el.textContent = text;
  const log = $('#log');
  log.prepend(el);
  while (log.children.length > 9) log.lastChild.remove();
}
function toast(title, text = '', kind = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${esc(text)}`;
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), ms / Math.max(1, speed * 0.7));
  while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove();
}
function banner(text, sub = '', secs = 1.1) {
  const b = $('#banner');
  b.hidden = false;
  b.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = `banner ${1.4 / speed}s ease forwards`;
  return view.wait(secs);
}
const pip = { 1: [[50, 50]], 2: [[25, 25], [75, 75]], 3: [[25, 25], [50, 50], [75, 75]], 4: [[25, 25], [75, 25], [25, 75], [75, 75]], 5: [[25, 25], [75, 25], [50, 50], [25, 75], [75, 75]], 6: [[25, 22], [75, 22], [25, 50], [75, 50], [25, 78], [75, 78]] };
const dieHTML = (v, cls) => `<div class="die ${cls}">${pip[v].map(([x, y]) => `<i style="left:calc(${x}% - 3px);top:calc(${y}% - 3px)"></i>`).join('')}</div>`;
let diceTimer = 0;
async function showDice(e) {
  const el = $('#dice');
  let res;
  if (e.defense) {
    const landed = e.dice.filter(d => d <= e.landOn).length;
    res = `${landed ? `<span style="color:var(--bad)">${landed} blow${landed > 1 ? 's' : ''} land</span>` : '<span style="color:var(--good)">All blocked</span>'} <span class="dim">(lands on 1–${e.landOn})</span>`;
    el.innerHTML = `<div class="who">${esc(e.label)}</div><div class="row">${e.dice.map(d => dieHTML(d, d <= e.landOn ? 'land' : 'miss')).join('')}</div><div class="res">${res}</div>`;
  } else {
    const need = e.hitOn || 4;
    const hits = e.dice.filter(d => d >= need).length, sixes = e.dice.filter(d => d === 6).length;
    res = e.label.startsWith('Climb') ? (hits ? '<span style="color:var(--good)">You haul yourself out!</span>' : '<span style="color:var(--bad)">You slip back</span>') : `${hits} hit${hits === 1 ? '' : 's'}${sixes ? `, ${sixes} crit${sixes > 1 ? 's' : ''}` : ''}`;
    el.innerHTML = `<div class="who">${esc(e.label)}</div><div class="row">${e.dice.map(d => dieHTML(d, d === 6 && need === 4 ? 'crit' : d >= need ? 'hit' : 'miss')).join('')}</div><div class="res">${res}</div>`;
  }
  el.hidden = false;
  clearTimeout(diceTimer);
  diceTimer = setTimeout(() => { el.hidden = true; }, 1600 / speed);
  await view.wait(e.defense ? 0.55 : 0.75);
}

function refresh(light = false) {
  if (!G || !G.map) return;
  const s = R.heroStats(G), h = G.hero;
  // orbs
  $('#orbHp .fill').style.height = `${(h.hp / s.maxHp) * 100}%`;
  $('#orbHp span').textContent = `${fmt(h.hp)}\n/ ${fmt(s.maxHp)}`;
  $('#orbHp .ward').style.boxShadow = h.ward > 0 ? `inset 0 0 0 ${Math.min(10, 3 + h.ward / 150)}px var(--brass2)` : 'none';
  $('#orbHp').title = `Health ${fmt(h.hp)} / ${fmt(s.maxHp)}${h.ward ? ` · Ward ${fmt(h.ward)}` : ''} · Armor ${s.armor}%`;
  $('#orbEn .fill').style.height = `${(h.energy / s.maxEnergy) * 100}%`;
  $('#orbEn span').textContent = `${h.energy}\n/ ${s.maxEnergy}`;
  $('#orbEn').title = `Energy: +${s.energyPerRound} per round, +${s.energyPerKill} per kill`;
  // where
  const sc = R.sceneDef(G);
  $('#sceneName').textContent = `${sc?.name || ''}`;
  const left = R.living(G).length, waves = G.waves.length;
  const next = G.waves[0] ? Math.max(0, G.waves[0].due - G.round + 1) : 0;
  $('#sceneSub').textContent = `${G.adv.acts[G.act]?.name || ''} · Round ${G.round} · ${G.cleared ? 'Clear: take the stair (west wall)' : `${left} foe${left === 1 ? '' : 's'}${waves ? ` · reinforcements in ${next} round${next === 1 ? '' : 's'}` : ''}`}`;
  if (light) return;
  // turn info
  const t = G.turn, acted = t.acted;
  $('#turnInfo').innerHTML = G.pit
    ? `<span>🕳 <b>In the chasm</b>: climbing out is your action (d6 4+, +${G.pit.tries} from failed tries)</span>`
    : `<span>Move <b>${t.move}</b></span><span>Action <b>${!acted ? 'ready' : acted === 'attackPower' ? 'attack primed' : 'used'}</b></span><span>Dice <b>${R.attackPool(G).total}</b>${h.buffs?.bonusDice ? ` <span style="color:var(--good)">(+${h.buffs.bonusDice})</span>` : ''}${h.buffs?.damageMult > 1 ? ` <span style="color:var(--rare)">×${h.buffs.damageMult} dmg</span>` : ''}</span><span>Reach <b>${R.heroReach(G) === 1 ? 'melee' : R.heroReach(G)}</b></span>${G.hidden ? '<span style="color:#b88cff">Hidden (+3 dice)</span>' : ''}`;
  // actions
  const busyOr = c => busy || !c;
  const inReach = R.foesInReach(G).length;
  const acts = $('#actions');
  acts.innerHTML = '';
  const btn = (label, title, on, fn, cls = '') => { const b = document.createElement('button'); b.innerHTML = label; b.title = title; b.disabled = busyOr(on); b.className = cls; b.onclick = fn; acts.appendChild(b); return b; };
  if (G.pit) btn('🧗 Climb out', 'Roll a d6: 4+ climbs out (each failed try adds +1)', !G.turn.acted && G.stage === 'scene', () => act(() => R.climb(G, rng)));
  else {
    btn(`⚔ Attack <small>${R.attackPool(G).total}d6</small>`, inReach ? 'Roll your dice pool; every 4+ is a hit you can spend on foes in reach (A). Or just click a foe in reach.' : 'No foe in reach', R.canAttack(G) && inReach && !R.strikeLeft(G), () => act(() => R.attack(G, rng)));
    btn('» Sprint', `Your action: +${s.move} move (S)`, R.canAct(G), () => act(() => R.sprint(G)));
  }
  btn('End turn ⏎', 'Foes act, then a new round (E)', G.stage === 'scene', () => endTurn(), 'end');
  // powers
  const pw = $('#powers');
  pw.innerHTML = '';
  R.powerList(G).forEach((p, i) => {
    const b = document.createElement('button');
    const spec = R.powerSpec(G, p);
    b.innerHTML = `${esc(p.name)}<small>${p.cost} energy${p.attack ? ' · attack' : ''}</small>`;
    b.title = `${p.name} (${i + 1}) · ${p.cost} energy\n${p.text}${spec.text && spec.text !== p.text ? `\n▸ ${spec.text}` : ''}${p.boosted?.length ? `\nBoosted by: ${p.boosted.join(', ')}` : ''}`;
    b.disabled = busyOr(R.powerUsable(G, p));
    if (p.set) { b.classList.add('set'); b.style.setProperty('--setc', R.SETS[p.set].color); }
    if (mode.kind === 'power' && mode.p.key === p.key) b.classList.add('active');
    b.onclick = () => startPower(p);
    pw.appendChild(b);
  });
  // wares
  const wa = $('#wares');
  wa.innerHTML = '';
  for (const w of h.consumables || []) {
    const C = R.CONSUMABLES[w.key]; if (!C) continue;
    const b = document.createElement('button');
    b.innerHTML = `${consumableSVG(w.key, 22)}${esc(C.name)}`;
    b.title = `${C.name}: ${C.text} (free, one ware per turn)`;
    b.disabled = busy || G.turn.ware || G.stage !== 'scene';
    b.onclick = () => act(() => R.useWare(G, w.id, rng));
    wa.appendChild(b);
  }
  // strike pool
  const st = $('#strike');
  if (G.strike && R.strikeLeft(G)) {
    const S = G.strike;
    st.hidden = false;
    st.innerHTML = `<span>Hits to spend:</span><span class="n">${S.hits}</span><span>hit${S.hits === 1 ? '' : 's'}</span>${S.crits ? `<span class="n" style="color:var(--legendary)">${S.crits}</span><span>crit${S.crits === 1 ? '' : 's'}</span>` : ''}${S.minion ? `<span class="n" style="color:var(--good)">${S.minion}</span><span>minion-only</span>` : ''}<span class="dim">Click foes in reach (red rings). Big foes take every hit; minions take one.</span><button id="stDone">Done</button>`;
    st.querySelector('#stDone').onclick = () => { G.strike = null; refresh(); };
  } else st.hidden = true;
  // targeting bar
  const tg = $('#targeting');
  if (mode.kind === 'power') {
    tg.hidden = false;
    const spec = R.powerSpec(G, mode.p);
    tg.innerHTML = `<b style="font-family:var(--serif);color:var(--brass2)">${esc(mode.p.name)}</b><span>${esc(spec.text)}</span>${spec.mode === 'foes' ? `<button class="primary" id="tgGo" ${mode.picked.length ? '' : 'disabled'}>Confirm (${mode.picked.length})</button>` : ''}${spec.mode === 'self' ? '<button class="primary" id="tgGo">Use</button>' : ''}<button id="tgX">Cancel <kbd>Esc</kbd></button>`;
    tg.querySelector('#tgX').onclick = cancelMode;
    const go = tg.querySelector('#tgGo');
    if (go) go.onclick = () => firePower(spec.mode === 'foes' ? { ids: mode.picked } : null);
  } else tg.hidden = true;
  updateHighlights();
}

// ================================================================== highlights and hover
function updateHighlights() {
  if (!G?.map) return;
  const hl = {};
  hl.inReach = new Set(R.foesInReach(G).map(f => f.id));
  if (busy || G.stage !== 'scene') { view.hl = { hover: hover && { ...hover } }; return; }
  if (mode.kind === 'power') {
    const spec = R.powerSpec(G, mode.p);
    const targets = R.powerTargets(G, mode.p);
    hl.targets = new Set(targets.map(c => key(c.x, c.y)));
    if (spec.mode === 'self' && spec.radius) hl.area = areaKeys(G.pos, spec.radius);
    if (spec.mode === 'point' && hover && hl.targets.has(key(hover.x, hover.y))) hl.area = areaKeys(hover, spec.radius);
    if (spec.mode === 'foes') hl.picked = new Set(mode.picked.map(id => { const f = G.foes.find(q => q.id === id); return key(f.x, f.y); }));
    hl.inReach = new Set();
  } else if (!G.pit) {
    const nodes = R.heroMoves(G);
    hl.move = new Set([...nodes.keys()].filter(k => k !== key(G.pos.x, G.pos.y)));
    if (hover && hl.move.has(key(hover.x, hover.y)) && !R.foeAt(G, hover.x, hover.y)) {
      const path = pathTo(nodes, hover.x, hover.y);
      hl.path = new Set(path.slice(1).map(p => key(p.x, p.y)));
      const blows = R.freeBlowsOn(G, path);
      hl.pathDanger = new Set(blows.map(b => key(path[b.at + 1].x, path[b.at + 1].y)));
      note(blows.length ? `⚠ ${blows.length} free blow${blows.length > 1 ? 's' : ''} (breaking away)` : `Move ${nodes.get(key(hover.x, hover.y)).cost}`, blows.length ? 'warn' : '');
    }
  }
  hl.hover = hover && { ...hover };
  const f = hover && R.foeAt(G, hover.x, hover.y);
  if (f) hl.hoverColor = hl.inReach.has(f.id) ? '#ff5a4a' : '#ffb347';
  view.hl = hl;
}
function areaKeys(c, r) {
  const s = new Set();
  for (let y = c.y - r; y <= c.y + r; y++) for (let x = c.x - r; x <= c.x + r; x++) s.add(key(x, y));
  return s;
}
let noteText = '', noteCls = '';
function note(text, cls = '') { noteText = text; noteCls = cls; }
function showTip(px, py) {
  const tip = $('#tip'), cn = $('#cursorNote');
  const f = hover && R.foeAt(G, hover.x, hover.y);
  if (f && !isModal()) {
    const s = R.heroStats(G), D = R.foeAttackDice(G, f);
    const abil = (f.abilities || []).map(k => `<div class="abil">${R.FOE_ABILITIES[k].icon} <b style="color:#ffcfa0;font-size:12px">${esc(R.FOE_ABILITIES[k].name)}</b>: ${esc(R.FOE_ABILITIES[k].text)}</div>`).join('');
    const reach = R.inReach(G, G.pos, f, R.heroReach(G));
    tip.innerHTML = `<b>${esc(f.name)}</b> <span class="dim">${ENEMY_TYPES[f.type].label}${f.pinned ? ' · Pinned' : ''}${f.enraged ? ' · Enraged' : ''}</span>
      ${f.type !== 'minion' ? `<div class="hpbar"><i style="width:${(f.hp / f.maxHp) * 100}%"></i></div>${fmt(f.hp)} / ${fmt(f.maxHp)} health · armor ${f.armor}%` : '<div>Dies to any hit</div>'}
      <div>${D.n} attack${D.n === 1 ? '' : 's'} × ${fmt(f.damage)} · lands on 1–${D.landOn} · ${f.reach > 1 ? `ranged ${f.reach}` : 'melee'} · move ${f.move}</div>
      ${f.type !== 'minion' ? `<div class="dim">Your hit: ${fmt(Math.round(s.damage * (1 - f.armor / 100)))} (crit ${fmt(Math.round(s.damage * s.critMult * (1 - f.armor / 100)))})</div>` : ''}
      ${f.ability ? `<div class="dim"><i>${esc(f.ability)}</i></div>` : ''}${abil}
      <div style="margin-top:4px;color:${reach ? 'var(--bad)' : 'var(--dim)'}">${reach ? (R.strikeLeft(G) ? 'Click to spend hits on it' : R.canAttack(G) ? 'In reach: click to attack it' : 'In reach') : 'Out of your reach'}</div>`;
    tip.hidden = false;
    tip.style.left = Math.min(innerWidth - 320, px + 18) + 'px';
    tip.style.top = Math.min(innerHeight - 200, py + 12) + 'px';
  } else tip.hidden = true;
  const chest = hover && G.map.chests.find(c => c.x === hover.x && c.y === hover.y && !c.opened);
  const exit = hover && G.cleared && hover.x === G.map.exit.x && hover.y === G.map.exit.y;
  if (!f && (chest || exit) && !isModal()) note(chest ? '✦ Chest: click to open (walks next to it)' : '⇣ Spiral stair: click to descend');
  if (noteText && !f && !isModal() && mode.kind === 'idle') {
    cn.hidden = false; cn.textContent = noteText; cn.className = noteCls;
    cn.style.left = px + 16 + 'px'; cn.style.top = py - 24 + 'px';
  } else cn.hidden = true;
  noteText = '';
}

// ================================================================== input
function bindInput() {
  const cv = $('#view');
  let down = null, dragging = false;
  cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, b: e.button }; dragging = false; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (dragging || Math.hypot(dx, dy) > 7) { dragging = true; view.pan(dx, dy); down.x = e.clientX; down.y = e.clientY; cv.style.cursor = 'grabbing'; }
    }
    if (!G?.map) return;
    const t = view.pick(e.clientX, e.clientY);
    if ((t?.x !== hover?.x || t?.y !== hover?.y)) { hover = t; updateHighlights(); }
    else updateHighlights();
    showTip(e.clientX, e.clientY);
  });
  cv.addEventListener('pointerup', e => {
    cv.style.cursor = 'default';
    const was = down; down = null;
    if (!was || dragging) return;
    if (was.b === 2) { cancelMode(); return; }
    const t = view.pick(e.clientX, e.clientY);
    if (t) clickTile(t);
  });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => { e.preventDefault(); view.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') { if (isModal() && $('#modal .close')) return closeModal(); return cancelMode(); }
    if (isModal() || !G?.map || $('#hud').hidden) return;
    const k = e.key.toLowerCase();
    const P = 60;
    if (e.key === 'ArrowLeft') view.pan(P, 0); else if (e.key === 'ArrowRight') view.pan(-P, 0);
    else if (e.key === 'ArrowUp') view.pan(0, P); else if (e.key === 'ArrowDown') view.pan(0, -P);
    else if (k === 'a' && R.canAttack(G) && R.foesInReach(G).length && !R.strikeLeft(G)) act(() => R.attack(G, rng));
    else if (k === 's' && R.canAct(G)) act(() => R.sprint(G));
    else if (k === 'e' || e.key === 'Enter') endTurn();
    else if (k === 'i') inventory();
    else if (k === 'h' || k === '?') help();
    else if (k === 'c') view.centerOn(G.pos);
    else if (/^[1-9]$/.test(k)) { const p = R.powerList(G)[Number(k) - 1]; if (p) startPower(p); }
  });
  $('#btnInv').onclick = () => inventory();
  $('#btnHelp').onclick = () => help();
  $('#btnCenter').onclick = () => view.centerOn(G.pos);
  $('#btnSpeed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 3 : 1; $('#btnSpeed').textContent = `${speed}×`; };
  $('#btnMenu').onclick = () => menu();
  $('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal' && $('#modal .close')) closeModal(); });
}
function cancelMode() { if (mode.kind !== 'idle') { mode = { kind: 'idle' }; refresh(); } }
async function endTurn() {
  if (busy || !G || G.stage !== 'scene') return;
  if (G.cleared) return toast('The scene is clear', 'Open the chests, then take the spiral stair in the west wall.');
  mode = { kind: 'idle' };
  await act(() => R.endTurn(G, rng));
  if (G.stage === 'scene') view.centerOn(G.pos);
}
async function clickTile(t) {
  if (busy || !G || G.stage !== 'scene') return;
  if (mode.kind === 'power') return clickPower(t);
  const f = R.foeAt(G, t.x, t.y);
  if (f) {
    if (R.strikeLeft(G)) { if (R.inReach(G, G.pos, f, R.heroReach(G))) return act(() => R.spend(G, f.id, rng)); return toast(`${f.name} is out of reach`, 'Move closer, or spend your hits on a foe with a red ring.', 'err'); }
    if (R.canAttack(G) && R.inReach(G, G.pos, f, R.heroReach(G))) {
      await act(() => R.attack(G, rng));
      if (R.strikeLeft(G) && !f.dead) await act(() => R.spend(G, f.id, rng), { quiet: true });
      return;
    }
    return;
  }
  const chest = G.map.chests.find(c => c.x === t.x && c.y === t.y && !c.opened);
  if (chest) return walkThen(chest, () => R.openChest(G, chest.x, chest.y, rng));
  if (G.cleared && t.x === G.map.exit.x && t.y === G.map.exit.y) return walkThen(G.map.exit, () => R.takeExit(G), 0);
  const nodes = R.heroMoves(G);
  if (nodes.has(key(t.x, t.y)) && (t.x !== G.pos.x || t.y !== G.pos.y)) return act(() => R.moveHero(G, t.x, t.y, rng));
}
// Walk next to a target (if needed and possible), then do something.
async function walkThen(target, fn, near = 1) {
  if (dist(G.pos, target) <= Math.max(near, 1) && (near || dist(G.pos, target) <= 1)) return act(fn);
  const nodes = R.heroMoves(G);
  let best = null;
  for (const n of nodes.values()) if (dist(n, target) <= Math.max(near, 1) && (!best || n.cost < best.cost)) best = n;
  if (!best) return toast('Too far', 'Walk closer first.', 'err');
  await act(() => R.moveHero(G, best.x, best.y, rng));
  if (G.stage === 'scene' && dist(G.pos, target) <= 1) await act(fn);
}
function startPower(p) {
  if (busy || !G) return;
  if (!R.powerUsable(G, p)) return toast(p.name, G.hero.energy < p.cost ? `Needs ${p.cost} energy.` : 'You have already acted this turn.', 'err');
  if (mode.kind === 'power' && mode.p.key === p.key) return cancelMode();
  const spec = R.powerSpec(G, p);
  if (spec.mode === 'self' && !spec.radius) { mode = { kind: 'idle' }; return firePower(null, p); }
  if (spec.mode !== 'self' && !R.powerTargets(G, p).length) return toast(p.name, 'No valid target from here.', 'err');
  mode = { kind: 'power', p, picked: [] };
  refresh();
}
async function clickPower(t) {
  const p = mode.p, spec = R.powerSpec(G, p);
  if (spec.mode === 'self') return firePower(null);
  const valid = R.powerTargets(G, p);
  if (spec.mode === 'foe' || spec.mode === 'foes') {
    const f = R.foeAt(G, t.x, t.y);
    if (!f || !valid.some(c => c.id === f.id)) return toast(p.name, 'Pick a highlighted foe.', 'err');
    if (spec.mode === 'foe') return firePower({ ids: [f.id] });
    mode.picked = mode.picked.includes(f.id) ? mode.picked.filter(x => x !== f.id) : [...mode.picked, f.id].slice(-(spec.max || 2));
    if (mode.picked.length >= (spec.max || 2)) return firePower({ ids: mode.picked });
    return refresh();
  }
  if (!valid.some(c => c.x === t.x && c.y === t.y)) return toast(p.name, 'Pick a highlighted square.', 'err');
  return firePower({ x: t.x, y: t.y });
}
async function firePower(target, p = mode.p) {
  mode = { kind: 'idle' };
  const r = await act(() => R.usePower(G, p.key, target, rng));
  if (r?.ok && r.attack && G.stage === 'scene') {
    toast(p.name, R.foesInReach(G).length ? 'Attack primed: click a foe in reach (or press A) to roll.' : 'Attack primed: move into reach, then attack.');
  }
}

// ================================================================== items
function itemCard(it, { actions = '', compare = true } = {}) {
  const set = it.set && R.SETS[it.set];
  const diff = compare && G ? R.compareItem(G, it) : null;
  const stats = Object.entries(it.stats).map(([k, v]) => {
    const d = diff?.find(x => x.k === k);
    const delta = d ? d.then - d.now : 0;
    return `<div>${esc(R.statsText({ [k]: v }))}${diff && delta ? ` <span class="${delta > 0 ? 'up' : 'down'}">(${delta > 0 ? '▲' : '▼'})</span>` : ''}</div>`;
  }).join('');
  const lost = diff ? diff.filter(d => !it.stats[d.k] && d.now).map(d => `<div class="down">−${esc(R.statsText({ [d.k]: d.now }))}</div>`).join('') : '';
  const setLine = set ? `<div class="dim" style="color:${set.color}">${esc(set.name)} set · ${esc(set.power.name)}</div>` : '';
  return `<div class="item" style="--rc:${rarityColor(it)}" data-id="${it.id}"><div class="nm">${esc(it.name)}</div><div class="meta">${esc(RARITIES[it.rarity]?.label || it.rarity)} ${esc(SLOT_LABEL[it.slot])}</div>${setLine}<div class="st">${stats}${lost}</div>${actions ? `<div class="acts">${actions}</div>` : ''}</div>`;
}
function showLoot() {
  const all = pendingLoot.splice(0);
  const items = all.flatMap(l => l.items).filter(it => G.hero.bag.some(b => b.id === it.id));
  if (!items.length) return;
  const p = modal(`<button class="close">✕</button><h2>${esc(all.map(l => l.from).join(' · '))}</h2>
    <div class="items">${items.map(it => itemCard(it, { actions: `<button class="primary" data-eq="${it.id}">Equip</button>` })).join('')}</div>
    <div class="btnrow"><button id="lootOk" class="primary">Into the satchel</button></div>`, { onClose: () => refresh() });
  p.querySelector('.close').onclick = closeModal;
  p.querySelector('#lootOk').onclick = closeModal;
  p.querySelectorAll('[data-eq]').forEach(b => b.onclick = async () => {
    R.equip(G, b.dataset.eq);
    b.closest('.item').style.opacity = 0.4; b.disabled = true; b.textContent = 'Equipped';
    await playFx(); refresh(); save();
  });
}
function inventory(tab = 'gear') {
  if (!G) return;
  const h = G.hero, s = R.heroStats(G);
  const slots = R.SLOTS.map(sl => `<div class="slot"><div class="lbl">${esc(SLOT_LABEL[sl])}</div>${h.gear[sl] ? itemCard(h.gear[sl], { compare: false, actions: `<button data-un="${sl}">Unequip</button>` }) : '<span class="dim">empty</span>'}</div>`).join('');
  const counts = {};
  for (const it of Object.values(h.gear)) if (it?.set) counts[it.set] = (counts[it.set] || 0) + 1;
  const setRows = Object.entries(counts).map(([k, n]) => `<div style="color:${R.SETS[k].color}">${esc(R.SETS[k].name)} ${n}/4 · ${esc(R.SETS[k].power.name)}${R.SETS[k].bonuses.map(b => ` <span class="${n >= b.n ? '' : 'dim'}">[${b.n}: ${esc(R.statsText(b.stats))}]</span>`).join('')}</div>`).join('') || '<div class="dim">No set pieces equipped. One piece of a set unlocks its power.</div>';
  const syn = R.SYNERGIES.filter(sy => (h.unlocked || []).includes(`syn:${sy.key}`)).map(sy => `<div>✦ <b>${esc(sy.name)}</b>: ${esc(R.synergyText(sy))}</div>`).join('') || `<div class="dim">${R.SYNERGIES.length} hidden synergies wait to be discovered by mixing sets.</div>`;
  const stat = (l, v) => `<span>${l}</span><span>${v}</span>`;
  const p = modal(`<button class="close">✕</button><h2>${esc(h.name)} <span class="dim" style="font-size:14px">${h.name === R.CLASSES[h.cls].name ? '' : `the ${esc(R.CLASSES[h.cls].name)} · `}${h.favour || 0} Favour</span></h2>
    <div class="inv"><div>
      <div class="statgrid">${stat('Max health', fmt(s.maxHp))}${stat('Armor', s.armor + '%')}${stat('Attack dice', s.dice)}${stat('Damage per hit', fmt(s.damage))}${stat('Crit multiplier', '×' + s.critMult)}${stat('Cleave', s.cleave || 0)}${stat('Energy per round', s.energyPerRound)}${stat('Energy per kill', s.energyPerKill)}${stat('Max energy', s.maxEnergy)}${stat('Move', s.move)}${stat('Reach', s.reach || 'melee')}</div>
      <h3>Sets</h3><div class="sets">${setRows}</div>
      <h3 style="margin-top:10px">Synergies</h3><div class="sets">${syn}</div>
      <h3 style="margin-top:10px">Equipped</h3><div class="slots">${slots}</div>
    </div><div>
      <h3>Satchel (${(h.bag || []).length})</h3>
      <div class="items">${(h.bag || []).map(it => itemCard(it, { actions: `<button class="primary" data-eq="${it.id}">Equip</button>${G.stage === 'camp' ? `<button data-sell="${it.id}">Sell ${R.SELL_VALUE[it.rarity]}✦</button>` : `<button data-drop="${it.id}">Drop</button>`}` })).join('') || '<div class="dim">Empty. Chests, elites and bosses carry loot.</div>'}</div>
    </div></div>`, { onClose: () => refresh() });
  p.querySelector('.close').onclick = closeModal;
  const again = () => { const m = $('#modal'); const oc = m.onClose; m.onClose = null; inventory(); $('#modal').onClose = oc; };
  p.querySelectorAll('[data-eq]').forEach(b => b.onclick = async () => { R.equip(G, b.dataset.eq); await playFx(); save(); again(); });
  p.querySelectorAll('[data-un]').forEach(b => b.onclick = () => { R.unequip(G, b.dataset.un); save(); again(); });
  p.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { R.discard(G, b.dataset.drop); save(); again(); });
  p.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => { R.sell(G, b.dataset.sell); save(); again(); });
}

// ================================================================== the Rakshasa's camp
function camp(tab = 'sell', line = pickLine(LINES.open, rng)) {
  $('#hud').hidden = true;
  const h = G.hero;
  const tabs = ['sell', 'boons', 'wares', 'crown'].map(t => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${{ sell: 'Sell gear', boons: 'Boons', wares: 'Wares', crown: 'Three-Card Crown' }[t]}</button>`).join('');
  let body = '';
  if (tab === 'sell') body = `<div class="items">${(h.bag || []).map(it => itemCard(it, { actions: `<button class="primary" data-sell="${it.id}">Sell for ${R.SELL_VALUE[it.rarity]} Favour</button><button data-eq="${it.id}">Equip</button>` })).join('') || '<div class="dim">Your satchel is empty.</div>'}</div>`;
  if (tab === 'boons') body = `<div class="shop">${Object.entries(R.BOONS).map(([k, B]) => { const price = R.boonPrice(h, k), locked = R.boonLocked(h, k); return `<div class="ware"><div><b>${esc(B.name)}</b>${esc(B.text)}${B.once ? ' <span class="dim">(once)</span>' : ''}${h.boonBuys?.[k] ? ` <span class="dim">· owned ×${h.boonBuys[k]}</span>` : ''}</div><button data-boon="${k}" ${locked || (h.favour || 0) < price ? 'disabled' : ''}>${locked ? 'Owned' : price + ' ✦'}</button></div>`; }).join('')}</div>`;
  if (tab === 'wares') body = `<div class="shop">${Object.entries(R.CONSUMABLES).map(([k, C]) => `<div class="ware">${consumableSVG(k, 44)}<div><b>${esc(C.name)}</b>${esc(C.text)}</div><button data-ware="${k}" ${(h.favour || 0) < C.cost ? 'disabled' : ''}>${C.cost} ✦</button></div>`).join('')}</div><p class="dim">Wares are free to use in a fight, one per turn. You carry ${(h.consumables || []).length}.</p>`;
  if (tab === 'crown') body = crownHTML();
  const p = modal(`<div class="rak"><img src="assets/rakshasa-face.jpg" alt="The Rakshasa"><div><h2>The Rakshasa's Rug</h2><div class="line">“${esc(line)}”</div><div class="dim" style="margin-top:4px">You rest by his lamp: health restored. Favour: <b style="color:var(--brass2)">${h.favour || 0} ✦</b></div></div></div>
    <div class="tabs">${tabs}<span style="flex:1"></span><button id="campInv">🎒 Gear</button><button class="primary" id="campGo">Onward: ${esc(G.adv.acts[G.act].name)}</button></div>${body}`);
  p.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => camp(b.dataset.tab, line));
  p.querySelector('#campGo').onclick = () => { R.leaveCamp(G); $('#modal').hidden = true; save(); toast('The Rakshasa', pickLine(LINES.close, rng)); beginScene(); };
  p.querySelector('#campInv').onclick = () => { $('#modal').onClose = null; inventory(); $('#modal').onClose = () => camp(tab, line); };
  p.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => { const r = R.sell(G, b.dataset.sell); save(); camp(tab, pickLine(LINES.sell[r.rarity] || LINES.sell.common, rng)); });
  p.querySelectorAll('[data-eq]').forEach(b => b.onclick = async () => { R.equip(G, b.dataset.eq); G.fx = G.fx.filter(e => { if (e.t === 'unlock') toast(e.title, e.text, 'unlock', 9000); return false; }); save(); camp(tab, line); });
  p.querySelectorAll('[data-boon]').forEach(b => b.onclick = () => { const r = R.buyBoon(G, b.dataset.boon); save(); camp(tab, r.ok ? pickLine(LINES.boon, rng) : r.error); });
  p.querySelectorAll('[data-ware]').forEach(b => b.onclick = () => { const r = R.buyWare(G, b.dataset.ware); save(); camp(tab, r.ok ? pickLine(LINES.buy, rng) : r.error); });
  if (tab === 'crown') bindCrown(p, line);
}
// Three-Card Crown against the house: 3 cards, one redraw of up to 2, ties go to the house.
let crown = null;
function crownHTML() {
  const h = G.hero;
  G.camp = G.camp || {};
  const played = G.camp.hands || 0;
  if (!crown || crown.phase === 'done') {
    const last = crown?.phase === 'done' ? `<div class="cards">${crown.house.map(c => cardSVG(c, { width: 70 })).join('')}</div><p style="text-align:center">House: <b>${esc(crown.houseHand)}</b> · You: <b>${esc(crown.hand)}</b> · <b style="color:${crown.win ? 'var(--good)' : 'var(--bad)'}">${crown.win ? 'You win' : 'The house wins'}</b>${crown.prizeText ? ` · ${esc(crown.prizeText)}` : ''}</p><div class="cards">${crown.cards.map(c => cardSVG(c, { width: 70 })).join('')}</div>` : '';
    return `${last}<p>Three cards each; you may redraw up to two, once. Best hand wins (three of a kind, run, flush, pair, high card); ties go to the house. ${3 - played} hand${3 - played === 1 ? '' : 's'} left tonight.</p>
      <div class="btnrow" style="justify-content:flex-start">${[1, 2, 3].map(w => `<button data-wager="${w}" ${played >= 3 || (h.favour || 0) < w ? 'disabled' : ''}>Wager ${w} ✦</button>`).join('')}<button data-wager="0" ${played >= 3 ? 'disabled' : ''}>Play for a prize (a ware)</button></div>`;
  }
  return `<p>Your hand. Click up to two cards to redraw, then reveal. Wager: ${crown.wager ? crown.wager + ' ✦' : 'a prize'}.</p>
    <div class="cards">${crown.house.map(() => cardBackSVG({ width: 70 })).join('')}</div>
    <div class="cards" id="hand">${crown.cards.map((c, i) => `<span class="card ${crown.pick.includes(i) ? 'pick' : ''}" data-i="${i}">${cardSVG(c, { width: 84 })}</span>`).join('')}</div>
    <div class="btnrow" style="justify-content:center"><button class="primary" id="reveal">${crown.pick.length ? `Redraw ${crown.pick.length} and reveal` : 'Stand and reveal'}</button></div>`;
}
function bindCrown(p, line) {
  p.querySelectorAll('[data-wager]').forEach(b => b.onclick = () => {
    const deck = newDeck(rng);
    crown = { wager: Number(b.dataset.wager), deck, cards: deck.splice(0, 3), house: deck.splice(0, 3), pick: [], phase: 'draw' };
    G.camp.hands = (G.camp.hands || 0) + 1;
    camp('crown', pickLine(LINES.deal, rng));
  });
  p.querySelectorAll('#hand .card').forEach(el => el.onclick = () => {
    const i = Number(el.dataset.i);
    crown.pick = crown.pick.includes(i) ? crown.pick.filter(x => x !== i) : [...crown.pick, i].slice(-2);
    camp('crown', line);
  });
  const rv = p.querySelector('#reveal');
  if (rv) rv.onclick = () => {
    for (const i of crown.pick) crown.cards[i] = crown.deck.shift();
    for (const i of houseSwaps(crown.house)) crown.house[i] = crown.deck.shift();
    const ps = scoreHand(crown.cards), hs = scoreHand(crown.house);
    crown.hand = handName(ps); crown.houseHand = handName(hs);
    crown.win = compareHands(ps, hs) > 0;
    const h = G.hero;
    if (crown.wager) h.favour = Math.max(0, (h.favour || 0) + (crown.win ? crown.wager : -crown.wager));
    else if (crown.win) {
      const keys = Object.keys(R.CONSUMABLES), k = keys[Math.floor(rng() * keys.length)];
      (h.consumables ||= []).push({ id: 'w' + Date.now().toString(36), key: k });
      crown.prizeText = `you win a ${R.CONSUMABLES[k].name}`;
    }
    crown.phase = 'done';
    save();
    camp('crown', pickLine(crown.win ? LINES.houseLoses : LINES.houseWins, rng));
  };
}

// ================================================================== help and menu
function help(after) {
  const foes = Object.entries(R.FOE_ABILITIES).map(([, A]) => `<p>${A.icon} <b>${esc(A.name)}</b>: ${esc(A.text.replace(/″/g, ' squares'))}</p>`).join('');
  const p = modal(`<button class="close">✕</button><h2>How to play</h2><div class="help">
    <h3>Your turn</h3><p>A <b>move</b> and <b>one action</b> (Attack, a Power, or Sprint), in any order. Blue squares show where you can walk. Climbing one level costs an extra square; rough ground costs 2. Ledges two levels high need a leap, grapple or teleport.</p>
    <h3>Attacking</h3><p>Click a foe with a red ring (in reach), or press <kbd>A</kbd>. You roll your <b>dice pool</b> of d6s: every 4+ is a hit, every 6 a crit. The hits form a pool you spend by clicking foes in reach: a minion dies to one hit; an elite or boss takes all your remaining hits (crits first). Damage per hit is reduced by the foe's armor. <b>High ground</b> (you stand above a foe in reach) adds a die; attacking <b>from hiding</b> adds 3.</p>
    <h3>Powers</h3><p>Powers cost energy and use your action. You gain energy every round and for every kill. <b>Attack powers</b> (marked "attack") prime your attack instead: use one, then attack in the same turn. Positional powers move you or your foes: hurl them into walls (<b>slammed</b>: +1 hit), into chasms, or pin them in place. Gear from an <b>item set</b> unlocks that set's power with just one piece.</p>
    <h3>Breaking away</h3><p>Walking away from a foe beside you gives it a <b>free blow</b> (the path turns red). Leaps, teleports and Vanish avoid it.</p>
    <h3>Defending</h3><p>In the enemy phase each foe rolls one die per attack: every 1–3 lands (1–2 if your armor is 30%+). You take an extra die when <b>surrounded</b> (3+ foes beside you) or attacked <b>from higher ground</b>. Armor reduces the damage; a <b>ward</b> soaks the rest.</p>
    <h3>Chasms</h3><p>A Slam can hurl you into a chasm: a fall costs 10% of your health and foes lose you. Climbing out is your action: d6 4+, with +1 for each failed try. Minions pushed into a chasm are gone; elites climb out hurt.</p>
    <h3>Waves and scenes</h3><p>Each scene comes from the Delvers' Ledger adventure planner: skirmishes, swarms, elite packs, gauntlets and bosses, sized to your gear when each act began. Reinforcements arrive at the end of later rounds. Clear every foe, open the chests, then take the glowing spiral stair in the west wall. Between acts the Rakshasa buys your spare gear for Favour and sells boons and wares.</p>
    <h3>Foe abilities</h3>${foes}
    <h3>Keys</h3><p><kbd>A</kbd> attack · <kbd>S</kbd> sprint · <kbd>1</kbd>–<kbd>9</kbd> powers · <kbd>E</kbd>/<kbd>Enter</kbd> end turn · <kbd>I</kbd> gear · <kbd>C</kbd> centre · arrows or drag to pan · wheel to zoom · <kbd>Esc</kbd>/right-click cancels.</p>
    </div><div class="credits">Art: Kenney "Isometric Miniature Dungeon" (CC0) · Flare-format monster renders from OpenGameArt: orcs, spiders and werebear by johndh and Wciow (CC-BY-SA 3.0), slime and demon by ryan.dansie (CC0 / CC-BY-SA 3.0) · Rakshasa portrait from Delvers' Ledger · cliffs, effects, dice and cards drawn in code.</div>`, { onClose: after });
  p.querySelector('.close').onclick = closeModal;
}
function menu() {
  const p = modal(`<button class="close">✕</button><h2>Menu</h2><div class="btnrow" style="justify-content:flex-start">
    <button id="mHelp">How to play</button><button id="mRetry">Restart this scene</button><button id="mTitle" class="danger">Abandon run</button></div>
    <p class="dim">Your run is saved in this browser after every action.</p>`, { narrow: true });
  p.querySelector('.close').onclick = closeModal;
  p.querySelector('#mHelp').onclick = () => help();
  p.querySelector('#mRetry').onclick = () => { $('#modal').hidden = true; R.retryScene(G, rng); G.fx = G.fx.filter(e => e.t !== 'spawn' && e.t !== 'log'); save(); enterScene(); };
  p.querySelector('#mTitle').onclick = () => { if (confirm('Abandon this run? Your hero will be lost.')) { clearSave(); G = null; view.G = null; titleScreen(); } };
}

// expose for debugging and automated play-tests
window.__game = { get G() { return G; }, get view() { return view; }, R, act, rng: () => rng, camp, inventory, beginScene, enterScene, help, refresh, playFx };
boot();
