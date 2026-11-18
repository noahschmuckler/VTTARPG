// Delvers' Descent: the controller. Input, HUD, screens, and the loop that plays the rules' effects.
import * as R from './game/rules.js';
import { View, fmt } from './game/render.js';
import { loadAssets, heroSheet, heroSheetName, A } from './game/assets.js';
import { rngFrom, key, dist, pathTo, tile } from './game/grid.js';
import { HERO_COLOR, rosterFor } from './game/content.js';
import { cardSVG, cardBackSVG, consumableSVG } from './ledger/art.js';
import { LINES, pick as pickLine, newDeck, scoreHand, handName, compareHands, houseSwaps } from './ledger/merchant.js';
import { SLOT_LABEL, RARITIES, ENEMY_TYPES } from './ledger/engine.js';
import { openForum, checkReplies } from './forum.js';
import { BUILD } from './version.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SAVE = 'delvers-descent-v2'; // v2: parties
const RC = { common: 'var(--common)', magic: 'var(--magic)', rare: 'var(--rare)', legendary: 'var(--legendary)' };
const armourText = rating => `${rating} (${Math.round(R.armourCut(rating) * 100)}%)`; // armour is a rating; the % is what it blocks
const rarityColor = it => (it.set ? R.SETS[it.set].color : RC[it.rarity] || 'var(--common)');

let G = null, rng = rngFrom(Date.now() & 0xffffffff), view, busy = false, mode = { kind: 'idle' }, speed = 1, hover = null;
let pendingLoot = [], lastSave = 0, shown = null, spendKind = null;
const TOUCH = matchMedia('(pointer: coarse)').matches;
if (TOUCH) document.documentElement.classList.add('touch');

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
  // shared links straight into the forum: #forum or #thread-12
  const fromHash = () => { const m = location.hash.match(/^#(forum|thread-(\d+))$/); if (m) forum(m[2] ? { kind: 'thread', id: Number(m[2]) } : { kind: 'list' }); };
  fromHash();
  addEventListener('hashchange', fromHash);
  forumDot();
  setInterval(forumDot, 120_000);
}

// ================================================================== the playtest forum
async function forumDot() { $('#btnForum .dot').hidden = !(await checkReplies()); }
function gameContext() {
  const bits = [`build ${BUILD}`];
  if (G) {
    const sc = R.sceneDef(G);
    bits.push(`${G.adv.acts[G.act]?.name || ''} / ${sc?.name || ''}`, G.map ? `round ${G.round}` : '', `stage ${G.stage}`);
    bits.push('party ' + G.party.map(h => `${h.name} (${R.CLASSES[h.cls].name}, ${h.hp}/${R.derive(h).maxHp})`).join(', '));
  }
  bits.push(`${innerWidth}×${innerHeight}${TOUCH ? ' touch' : ''}`, navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 160));
  return bits.filter(Boolean).join(' · ');
}
function gameScreenshot() {
  try {
    const src = $('#view');
    if (!G?.map || !src.width) return null;
    const w = Math.min(640, src.width), h = Math.round(src.height * w / src.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}
function forum(view) {
  // where to return when the forum closes: the title screen, the Rakshasa's camp, or the fight
  const back = !$('#hud').hidden ? 'game' : G?.stage === 'camp' ? 'camp' : 'title';
  if (back === 'game') mode = { kind: 'idle' };
  openForum({ modal, closeModal, esc, toast, context: gameContext, screenshot: gameScreenshot, onClose: () => {
    forumDot();
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (back === 'camp') camp(); else if (back === 'title') titleScreen(); else refresh();
  } }, view);
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
  try { const s = JSON.parse(localStorage.getItem(SAVE) || 'null'); return s?.G?.party?.length ? s : null; } catch { return null; }
}
function clearSave() { try { localStorage.removeItem(SAVE); } catch { /* ignore */ } }

// ================================================================== modal helpers
function modal(html, { narrow = false, onClose = null } = {}) {
  const m = $('#modal'), p = m.querySelector('.panel');
  p.className = 'panel' + (narrow ? ' narrow' : '');
  p.scrollTop = 0;
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
  const g = c.getContext('2d'), M = A.manifest.units[heroSheetName(cls)], img = heroSheet(cls);
  const row = ((M.base - 2) % 8 + 8) % 8, sc = 1.25 * (M.scale || 1);
  g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(w, h * 1.72, 40, 14, 0, 0, 7); g.fill();
  g.strokeStyle = HERO_COLOR[cls]; g.lineWidth = 3; g.stroke();
  g.drawImage(img, 0, row * M.fh, M.fw, M.fh, w - M.ax * sc, h * 1.72 - M.ay * sc, M.fw * sc, M.fh * sc);
  return c;
}
let picks = ['ironclad', 'ranger', 'runepriest'];
const partyLabel = list => list.map(c => `${R.DEFAULT_NAMES[c]} the ${R.CLASSES[c].name}`).join(', ');
function titleScreen() {
  $('#hud').hidden = true;
  const saved = loadSave();
  const cards = Object.entries(R.CLASSES).map(([k, C]) => `
    <div class="cls" data-cls="${k}">
      <div class="badge"></div>
      <div class="pc" data-cls="${k}"></div>
      <h3 style="color:${HERO_COLOR[k]}">${C.glyph} ${esc(C.name)}</h3>
      <div class="role">${esc(C.role)}</div>
      <div class="stats"><span>❤ ${fmt(C.base.maxHp)}</span><span>⛨ ${armourText(C.base.armor)}</span><span>⚄ ${C.base.dice} dice</span><span>⚔ ${fmt(C.base.damage)}</span><span>➜ move ${C.base.move}</span><span>◎ ${C.base.reach ? 'reach ' + C.base.reach : 'melee'}</span></div>
      <ul>${C.abilities.map(a => `<li title="${esc(a.text)}"><b>${esc(a.name)}</b> <span class="dim">${a.cost}</span></li>`).join('')}</ul>
    </div>`).join('');
  const savedParty = saved ? saved.G.party.map(h => h.name).join(', ') : '';
  const p = modal(`<div class="title-screen">
    <h1 class="logo">Delvers' Descent</h1>
    <div class="tag">Lead a party down to the Eighth Gate · turn-based tactics on the Delvers' Ledger rules</div>
    <p class="pick-help">Tap callings to add them to your party (1 to ${R.SOLO.maxParty}); tap again to remove. You control every hero.</p>
    <div class="classes">${cards}</div>
    <div class="name-row"><span id="partyNames"></span><button class="primary" id="go">Begin the descent</button></div>
    <div class="btnrow" style="justify-content:center">${saved ? `<button id="cont">Continue: ${esc(savedParty)} (${esc(saved.G.adv.acts[saved.G.act]?.name || '')})</button>` : ''}<button id="howto">How to play</button><button id="tForum">💬 Bugs, ideas & feedback</button></div>
    <div class="credits">Art: Kenney (CC0); heroes from the Flare game by Clint Bellanger and contributors (CC-BY-SA 3.0); monster renders by johndh, Wciow and ryan.dansie on OpenGameArt (CC0 / CC-BY-SA 3.0). Rules: Delvers' Ledger. See CREDITS.md.</div>
  </div>`);
  const show = () => {
    p.querySelectorAll('.cls').forEach(el => {
      const i = picks.indexOf(el.dataset.cls);
      el.classList.toggle('sel', i >= 0);
      el.querySelector('.badge').textContent = i >= 0 ? i + 1 : '';
    });
    p.querySelector('#partyNames').textContent = picks.length ? `Party: ${partyLabel(picks)}` : 'Pick at least one calling';
    p.querySelector('#go').disabled = !picks.length;
  };
  p.querySelectorAll('.pc').forEach(el => el.appendChild(heroPortrait(el.dataset.cls)));
  p.querySelectorAll('.cls').forEach(el => el.onclick = () => {
    const c = el.dataset.cls;
    picks = picks.includes(c) ? picks.filter(x => x !== c) : [...picks, c].slice(-R.SOLO.maxParty);
    show();
  });
  show();
  p.querySelector('#go').onclick = () => {
    if (!picks.length) return;
    clearSave();
    rng = rngFrom((Math.random() * 2 ** 32) >>> 0);
    G = R.newRun(picks.map(cls => ({ cls })), rng);
    $('#modal').hidden = true;
    beginScene();
  };
  p.querySelector('#howto').onclick = () => help(() => titleScreen());
  p.querySelector('#tForum').onclick = () => forum({ kind: 'list' });
  if (saved) p.querySelector('#cont').onclick = () => {
    G = R.bindParty({ ...saved.G, fx: [] });
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
  view.faceOpponents();
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
  const who = G.party.length > 1 ? `${G.party.map(h => h.name).join(', ')} lie still` : `${G.hero.name} lies still`;
  const p = modal(`<h2>${G.party.length > 1 ? 'The party has fallen' : 'You have fallen'}</h2><div class="narr">${esc(who)} on the cold stones of ${esc(R.sceneDef(G)?.name || 'the deep')}. But the Ledger does not close an account so easily…</div>
    <div class="btnrow"><button id="newrun">New run</button><button class="primary" id="retry">Rise again (retry the scene)</button></div>`, { narrow: true });
  p.querySelector('#retry').onclick = () => { $('#modal').hidden = true; R.retryScene(G, rng); G.fx = G.fx.filter(e => e.t !== 'spawn' && e.t !== 'log'); save(); enterScene(); };
  p.querySelector('#newrun').onclick = () => { clearSave(); titleScreen(); };
}
function victory() {
  const t = {};
  for (const h of G.party) for (const [k, v] of Object.entries(h.tally || {})) t[k] = (t[k] || 0) + v;
  const names = G.party.map(h => `${h.name} the ${R.CLASSES[h.cls].name}`).join(', ');
  const p = modal(`<h2>The Eighth Gate is shut</h2><div class="narr">${esc(names)} walked into the dark${G.party.length > 1 ? ' together' : ' alone'} and came back out.</div>
    <div class="statgrid" style="max-width:320px"><span>Scenes cleared</span><span>${G.stats.scenes}</span><span>Rounds fought</span><span>${G.stats.rounds}</span><span>Minions slain</span><span>${t.minion || 0}</span><span>Elites slain</span><span>${t.elite || 0}</span><span>Bosses slain</span><span>${t.boss || 0}</span></div>
    <div class="btnrow"><button class="primary" id="again">Another descent</button></div>`, { narrow: true });
  clearSave();
  p.querySelector('#again').onclick = () => titleScreen();
}

// ================================================================== acting
async function act(fn, { quiet = false } = {}) {
  if (busy || !G) return;
  if (sel) clearSel();
  if (mode.kind === 'ware') mode = { kind: 'idle' };
  busy = true;
  shown = view.shown = Object.fromEntries(G.party.map(h => [h.hid, { hp: h.hp, ward: h.ward || 0, rune: h.rune || 0, energy: h.energy }])); // the HUD follows the effects, not the final state
  const r = fn();
  if (r && !r.ok) { if (!quiet) toast(r.error, '', 'err'); G.fx.length = 0; busy = false; shown = view.shown = null; refresh(); return r; }
  refresh();
  await playFx();
  view.faceOpponents();
  shown = view.shown = null;
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
    const sh = shown && shown[e.id];
    if (sh) {
      if (e.t === 'dmg') { sh.hp = Math.max(0, sh.hp - e.n); sh.ward = Math.max(0, sh.ward - (e.normal ?? e.warded ?? 0)); sh.rune = Math.max(0, sh.rune - (e.rune || 0)); }
      if (e.t === 'heal') sh.hp += e.n;
      if (e.t === 'ward') { if (e.rune) sh.rune += e.n; else sh.ward += e.n; }
      if (e.t === 'wardfade') { sh.ward = e.ward; sh.rune = e.rune; }
      if (e.t === 'energy') sh.energy += e.n;
      if (e.t === 'revive') { const h = G.party.find(q => q.hid === e.id); sh.hp = h.hp; }
    }
    switch (e.t) {
      case 'log': addLog(e.text, e.kind); break;
      case 'dice': await showDice(e); break;
      case 'toast': toast(e.title, e.text); break;
      case 'unlock': toast(e.title, e.text, 'unlock', 9000); break;
      case 'ability': toast(`${e.icon} ${foeName(e.id)}: ${e.name}`, e.text, 'foe', 5000); await view.wait(0.25); break;
      case 'loot': pendingLoot.push(e); break;
      case 'phase': if (e.name === 'Enemy phase') { if (R.living(G).length) await banner('Enemy phase'); } else await banner(e.name, e.energy ? `+${e.energy} energy` : ''); break;
      case 'power': await banner(e.name, '', 0.8); break;
      case 'cleared': {
        await banner('Scene clear', 'Walk freely: no more turns');
        toast('Scene clear', `You catch your breath (+${Math.round(R.SOLO.breather * 100)}% health). Gold beacons mark the chests; the spiral stair glows in the west wall. Use the buttons below to go straight there.`, '', 7000);
        const c = G.map.chests.find(q => !q.opened);
        if (c) view.centerOn(c);
        break;
      }
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
    const landed = e.dice.filter(d => d >= e.hitOn).length, crits = e.dice.filter(d => d === 6).length;
    res = `${landed ? `<span style="color:var(--bad)">${landed} blow${landed > 1 ? 's' : ''} land${crits ? `, ${crits} crit${crits > 1 ? 's' : ''}` : ''}</span>` : '<span style="color:var(--good)">All blocked</span>'} <span class="dim">(hits on ${e.hitOn}+, 6 crits)</span>`;
    el.innerHTML = `<div class="who">${esc(e.label)}</div><div class="row">${e.dice.map(d => dieHTML(d, d === 6 ? 'land crit' : d >= e.hitOn ? 'land' : 'miss')).join('')}</div><div class="res">${res}</div>`;
  } else {
    const need = e.hitOn || 4, critOn = e.critOn || 6;
    const hits = e.dice.filter(d => d >= need).length, sixes = need <= 4 ? e.dice.filter(d => d >= critOn).length : 0;
    res = e.label.startsWith('Climb') ? (hits ? '<span style="color:var(--good)">You haul yourself out!</span>' : '<span style="color:var(--bad)">You slip back</span>') : `${hits} hit${hits === 1 ? '' : 's'}${sixes ? `, ${sixes} crit${sixes > 1 ? 's' : ''}` : ''}`;
    el.innerHTML = `<div class="who">${esc(e.label)}</div><div class="row">${e.dice.map(d => dieHTML(d, need <= 4 && d >= critOn ? 'crit' : d >= need ? 'hit' : 'miss')).join('')}</div><div class="res">${res}</div>`;
  }
  el.hidden = false;
  clearTimeout(diceTimer);
  diceTimer = setTimeout(() => { el.hidden = true; }, 1600 / speed);
  await view.wait(e.defense ? 0.55 : 0.75);
}

function refresh(light = false) {
  if (!G || !G.map) return;
  const sh = shown?.[G.hero.hid];
  const s = R.heroStats(G), h = sh ? { ...G.hero, hp: Math.min(sh.hp, R.heroStats(G).maxHp), ward: sh.ward, rune: sh.rune, energy: Math.max(0, Math.min(sh.energy, R.heroStats(G).maxEnergy)) } : G.hero;
  partyStrip();
  // orbs
  $('#orbHp').style.setProperty('--pct', `${(h.hp / s.maxHp) * 100}%`);
  $('#orbEn').style.setProperty('--pct', `${(h.energy / s.maxEnergy) * 100}%`);
  $('#orbHp .fill').style.height = `${(h.hp / s.maxHp) * 100}%`;
  $('#orbHp span').textContent = `${fmt(h.hp)}\n/ ${fmt(s.maxHp)}`;
  const wsum = (h.ward || 0) + (h.rune || 0);
  $('#orbHp .ward').style.boxShadow = wsum > 0 ? `inset 0 0 0 ${Math.min(innerWidth < 700 ? 3 : 10, 3 + wsum / 150)}px var(--brass2)` : 'none';
  const wn = $('#wardNum');
  wn.hidden = !(wsum > 0);
  wn.textContent = [h.ward > 0 && `🛡 ${fmt(h.ward)}`, h.rune > 0 && `ᛟ ${fmt(h.rune)} rune`].filter(Boolean).join(' · ') + (h.rune > 0 ? '' : ' ward');
  $('#orbHp').title = `Health ${fmt(h.hp)} / ${fmt(s.maxHp)}${h.ward ? ` · Ward ${fmt(h.ward)}` : ''}${h.rune ? ` · Rune ward ${fmt(h.rune)}` : ''} · Armour ${armourText(s.armor)}`;
  $('#orbEn .fill').style.height = `${(h.energy / s.maxEnergy) * 100}%`;
  $('#orbEn span').textContent = `${h.energy}\n/ ${s.maxEnergy}`;
  $('#orbEn').title = `Energy: +${s.energyPerRound} per round, +${s.energyPerKill} per kill`;
  // where
  const sc = R.sceneDef(G);
  $('#sceneName').textContent = `${sc?.name || ''}`;
  const left = R.living(G).length, waves = G.waves.length;
  const next = G.waves[0] ? Math.max(0, G.waves[0].due - G.round + 1) : 0;
  const unopened = G.map.chests.filter(c => !c.opened).length;
  $('#sceneSub').textContent = `${TOUCH ? '' : (G.adv.acts[G.act]?.name || '') + ' · '}Round ${G.round} · ${G.cleared ? `Clear${unopened ? ` · ${unopened} chest${unopened > 1 ? 's' : ''} (gold beacons)` : ''}${TOUCH ? '' : ' · stair glows in the west wall'}` : `${left} foe${left === 1 ? '' : 's'}${waves ? ` · reinforcements in ${next} round${next === 1 ? '' : 's'}` : ''}`}`;
  if (light) return;
  // turn info
  const t = G.turn, acted = t.acted;
  $('#turnInfo').innerHTML = G.cleared ? '<span><b>Scene clear</b>: walk anywhere, open chests, then descend</span>' : G.pit
    ? `<span>🕳 <b>In the chasm</b>: climbing out is your action (d6 4+, +${G.pit.tries} from failed tries)</span>`
    : `<span>Move <b>${t.move}</b></span><span>Action <b>${!acted ? 'ready' : acted === 'attackPower' ? 'attack primed' : 'used'}</b></span><span>Dice <b>${R.attackPool(G).total}</b>${h.buffs?.bonusDice ? ` <span style="color:var(--good)">(+${h.buffs.bonusDice})</span>` : ''}${h.buffs?.damageMult > 1 ? ` <span style="color:var(--rare)">×${h.buffs.damageMult} dmg</span>` : ''}</span><span>Reach <b>${R.heroReach(G) === 1 ? 'melee' : R.heroReach(G)}</b></span>${G.hidden ? '<span style="color:#b88cff">Hidden (+3 dice)</span>' : ''}`;
  // actions
  const busyOr = c => busy || !c;
  const inReach = R.foesInReach(G).length;
  const acts = $('#actions');
  acts.innerHTML = '';
  const btn = (label, title, on, fn, cls = '') => { const b = document.createElement('button'); b.innerHTML = label; b.title = title; b.disabled = busyOr(on); b.className = cls; b.onclick = fn; acts.appendChild(b); return b; };
  if (G.cleared) {
    const chests = G.map.chests.filter(c => !c.opened);
    if (chests.length) btn(`✦ Open chest${chests.length > 1 ? ` (${chests.length})` : ''}`, 'Walk to the nearest unopened chest and open it', true, () => { const c = chests.sort((a, b) => dist(a, G.pos) - dist(b, G.pos))[0]; view.centerOn(c); walkThen(c, () => R.openChest(G, c.x, c.y, rng)); }, 'primary');
    btn('⇣ Descend', 'Walk to the glowing spiral stair and take it', true, () => { view.centerOn(G.map.exit); walkThen(G.map.exit, () => R.takeExit(G), 0); }, chests.length ? '' : 'primary');
  } else if (G.pit) btn('🧗 Climb out', 'Roll a d6: 4+ climbs out (each failed try adds +1)', !G.turn.acted && G.stage === 'scene', () => act(() => R.climb(G, rng)));
  else {
    btn(`⚔ ${G.turn.acted === 'attackPower' ? 'Strike' : 'Attack'} <small>${R.attackPool(G).total}d6</small>`, inReach ? 'Roll your dice pool; every 4+ is a hit you can spend on foes in reach (A). Or just click a foe in reach.' : 'No foe in reach', R.canAttack(G) && inReach && !R.strikeLeft(G), () => act(() => R.attack(G, rng)));
    btn('» Sprint', `Your action: +${s.move} move (S)`, R.canAct(G), () => act(() => R.sprint(G)));
    if (G.turn.acted && !G.turn.surged && G.turn.acted !== 'down') btn(`⚡ Surge <small>${R.ENERGY.surge}</small>`, `Once per round: spend ${R.ENERGY.surge} energy to take another action`, R.canSurge(G), () => act(() => R.surge(G)));
  }
  if (!G.cleared && G.party.length > 1) {
    const nxt = nextHero();
    btn('Next ▸', nxt >= 0 ? `Switch to ${G.party[nxt].name} (Tab)` : 'Every hero has acted', nxt >= 0, () => switchHero(nxt), R.heroDone(G, G.hero) && nxt >= 0 ? 'primary' : '');
  }
  if (!G.cleared) btn(G.party.length > 1 ? 'End round ⏎' : 'End turn ⏎', G.party.length > 1 ? 'Every hero is done: the foes act, then a new round (E)' : 'Foes act, then a new round (E)', G.stage === 'scene', () => endTurn(), nextHero() < 0 || G.party.length < 2 ? 'end' : '');
  document.documentElement.style.setProperty('--dock', $('#bar').offsetHeight + 'px');
  // powers
  const pw = $('#powers');
  pw.innerHTML = '';
  if (!G.cleared) R.powerList(G).forEach((p, i) => {
    const b = document.createElement('button');
    const spec = R.powerSpec(G, p);
    b.innerHTML = `${esc(p.name)}<small>${p.cost} energy${p.attack ? ' · attack' : spec.strike ? ' · + strike' : ''}</small>`;
    b.title = `${p.name} (${i + 1}) · ${p.cost} energy\n${R.powerText(p)}${p.boosted?.length ? `\nBoosted by: ${p.boosted.join(', ')}` : ''}`;
    b.disabled = busy;
    if (!R.powerUsable(G, p)) b.classList.add('unusable');
    if (p.set) { b.classList.add('set'); b.style.setProperty('--setc', R.SETS[p.set].color); }
    if (mode.kind === 'power' && mode.p.key === p.key) b.classList.add('active');
    b.onclick = () => startPower(p);
    pw.appendChild(b);
  });
  // wares
  const wa = $('#wares');
  wa.innerHTML = '';
  const byKey = new Map();
  for (const w of G.wares || []) if (R.CONSUMABLES[w.key]) (byKey.get(w.key) || byKey.set(w.key, []).get(w.key)).push(w);
  for (const [k, list] of byKey) {
    const w = list[0], C = R.CONSUMABLES[k];
    const b = document.createElement('button');
    b.innerHTML = `${consumableSVG(w.key, 22)}${esc(C.name)}${list.length > 1 ? ` <b>×${list.length}</b>` : ''}`;
    b.title = `${C.name}: ${C.text} (free; one ware per hero per turn; the party shares the pouch)`;
    b.disabled = busy || G.turn.ware || G.stage !== 'scene';
    if (mode.kind === 'ware' && mode.w.key === w.key) b.classList.add('active');
    b.onclick = () => { if (mode.kind === 'ware' && mode.w.id === w.id) return cancelMode(); mode = { kind: 'ware', w, opened: performance.now() }; refresh(); };
    wa.appendChild(b);
  }
  // the Runepriest's reactions: on another hero's turn, his runes can help them (free, from his energy, once each per round)
  const rx = $('#reactions');
  rx.innerHTML = '';
  const priest = R.priestsOf(G).find(p => p !== G.hero);
  if (priest && !G.cleared) {
    const list = R.reactionsFor(G, priest, G.hero);
    rx.insertAdjacentHTML('beforeend', `<span class="rxlab">ᛟ ${esc(priest.name)} <small>${priest.energy}⚡</small></span>`);
    for (const r of list) {
      const b = document.createElement('button');
      b.innerHTML = `${esc(r.name.replace('Rune of ', ''))} <small>${r.cost}</small>`;
      b.title = `${r.name} (${r.cost} energy, free, once per round): ${r.text}${r.why ? `\nNot now: ${r.why}` : ''}`;
      b.disabled = busy || !r.ok;
      b.onclick = () => act(() => R.react(G, priest.hid, r.key, G.hero.hid));
      rx.appendChild(b);
    }
    const t = document.createElement('button');
    t.className = 'toggle' + (priest.turningOff ? '' : ' on');
    t.innerHTML = `Turning ${priest.turningOff ? 'off' : 'armed'}`;
    t.title = `${R.REACTIONS.turning.name} (${R.REACTIONS.turning.cost} energy, once per round): ${R.REACTIONS.turning.text}`;
    t.onclick = () => { R.setTurning(G, priest.hid, !!priest.turningOff); save(); refresh(); };
    rx.appendChild(t);
  }
  // strike pool
  const st = $('#strike');
  if (G.strike && R.strikeLeft(G)) {
    const S = G.strike;
    st.hidden = false;
    if (spendKind && !{ crit: S.crits, hit: S.hits, minion: S.minion }[spendKind]) spendKind = null;
    const chip = (k, n, label, color) => n ? `<button class="sk ${spendKind === k ? 'on' : ''}" data-k="${k}" style="--c:${color}"><b>${n}</b> ${label}${n === 1 ? '' : 's'}</button>` : '';
    st.innerHTML = `<span>Next ${TOUCH ? 'tap' : 'click'} spends:</span>
      <button class="sk ${!spendKind ? 'on' : ''}" data-k="">Auto</button>${chip('crit', S.crits, 'crit', 'var(--legendary)')}${chip('hit', S.hits, 'hit', 'var(--brass2)')}${chip('minion', S.minion, 'minion-only hit', 'var(--good)')}
      <span class="dim">One hit per ${TOUCH ? 'tap' : 'click'} on a red-ringed foe. Auto puts crits on elites and bosses and plain hits on minions. Hits keep until ${G.party.length > 1 ? 'End round' : 'End turn'}.</span>`;
    st.querySelectorAll('.sk').forEach(b => b.onclick = () => { spendKind = b.dataset.k || null; refresh(); });  } else st.hidden = true;
  // targeting bar
  const tg = $('#targeting');
  const T = R.throwPending(G);
  if (T) {
    if (mode.kind !== 'throw') mode = { kind: 'throw', seq: [] };
    const total = T.hits + T.crits, names = mode.seq.map(id => G.foes.find(f => f.id === id)?.name || '?');
    tg.hidden = false;
    tg.innerHTML = `<b style="font-family:var(--serif);color:var(--brass2)">Hammer throw <span class="dim" style="font:12px var(--sans)">${total} hit${total > 1 ? 's' : ''}${T.crits ? `, the first ${T.crits} crit${T.crits > 1 ? 's' : ''} ×${+T.critMult.toFixed(2)}` : ''}</span></b>
      <span class="desc">${TOUCH ? 'Tap' : 'Click'} foes within 6 squares in the order the hammer should strike them (not the same foe twice in a row), then confirm. ${mode.seq.length}/${total}: ${esc(names.join(' → ') || 'none yet')}</span>
      <button class="primary" id="thGo" ${mode.seq.length ? '' : 'disabled'}>Throw (${mode.seq.length})</button><button id="thUndo" ${mode.seq.length ? '' : 'disabled'}>Undo</button>`;
    tg.querySelector('#thGo').onclick = () => { const seq = mode.seq; mode = { kind: 'idle' }; act(() => R.throwHammer(G, seq, rng)); };
    tg.querySelector('#thUndo').onclick = () => { mode.seq.pop(); refresh(); };
  } else if (mode.kind === 'throw') { mode = { kind: 'idle' }; tg.hidden = true; }
  if (T) { /* the throw panel is showing */ } else if (mode.kind === 'power') {
    tg.hidden = false;
    const spec = R.powerSpec(G, mode.p);
    const usable = R.powerUsable(G, mode.p), none = spec.mode !== 'self' && !R.powerTargets(G, mode.p).length;
    const why = !usable ? (G.hero.energy < mode.p.cost ? `Needs ${mode.p.cost} energy (you have ${G.hero.energy}).` : 'You have already acted this turn.') : none ? 'Nothing in range from here: move first.' : '';
    const stepFoe = spec.landing && mode.foe && G.foes.find(f => f.id === mode.foe);
    const howTo = stepFoe ? `Now pick the square beside ${stepFoe.name} to appear on (tap another foe to switch).` : spec.mode !== 'self' || R.powerText(mode.p) === mode.p.text ? (spec.text !== mode.p.text ? spec.text : '') : '';
    const modes = mode.p.key === 'hammer' ? `<span class="hmodes">${[['strike', 'Strike'], ['slam', 'Slam'], ['throw', 'Throw']].map(([k, l]) => `<button data-hm="${k}" class="${(mode.p.hmode || 'strike') === k ? 'on' : ''}">${l}</button>`).join('')}</span>` : '';
    tg.innerHTML = `<b style="font-family:var(--serif);color:var(--brass2)">${esc(mode.p.name)} <span class="dim" style="font:12px var(--sans)">${mode.p.cost} energy</span></b>${modes}<span class="desc">${esc(mode.p.key === 'hammer' ? R.hammerModeText(mode.p) : R.powerText(mode.p))}${why ? `<br><span style="color:var(--bad)">${esc(why)}</span>` : howTo ? `<br><span style="color:var(--brass2)">▸ ${esc(howTo)}</span>` : ''}</span>${spec.mode === 'foes' ? `<button class="primary" id="tgGo" ${mode.picked.length ? '' : 'disabled'}>Confirm (${mode.picked.length})</button>` : ''}${spec.mode === 'self' ? `<button class="primary" id="tgGo" ${usable ? '' : 'disabled'}>Use ${esc(mode.p.name)}</button>` : ''}<button id="tgX">Cancel <kbd>Esc</kbd></button>`;
    tg.querySelector('#tgX').onclick = cancelMode;
    tg.querySelectorAll('[data-hm]').forEach(b => b.onclick = () => { mode.p = { ...mode.p, hmode: b.dataset.hm }; mode.picked = []; refresh(); });
    const go = tg.querySelector('#tgGo');
    if (go) go.onclick = () => { if (performance.now() - (mode.opened || 0) < 450) return; firePower(spec.mode === 'foes' ? { ids: mode.picked } : null); }; // ignore a stray double tap
  } else if (mode.kind === 'ware') {
    const C = R.CONSUMABLES[mode.w.key];
    tg.hidden = false;
    tg.innerHTML = `<b style="font-family:var(--serif);color:var(--brass2)">${esc(C.name)} <span class="dim" style="font:12px var(--sans)">ware · free</span></b><span class="desc">${esc(C.text)} Using a ware doesn't take your action; one per turn.</span><button class="primary" id="tgGo" ${G.turn.ware ? 'disabled' : ''}>Use ${esc(C.name)}</button><button id="tgX">Cancel <kbd>Esc</kbd></button>`;
    tg.querySelector('#tgX').onclick = cancelMode;
    tg.querySelector('#tgGo').onclick = () => { if (performance.now() - (mode.opened || 0) < 450) return; const w = mode.w; mode = { kind: 'idle' }; act(() => R.useWare(G, w.id, rng)); };
  } else tg.hidden = true;
  updateHighlights();
  // keep the camera's "centre" in the strip of map the HUD leaves visible
  const topH = Math.max($('#topbar').getBoundingClientRect().bottom, $('#party').hidden ? 0 : $('#party').getBoundingClientRect().bottom);
  const panel = [$('#targeting'), $('#strike')].find(x => !x.hidden);
  const botTop = Math.min($('#bar').getBoundingClientRect().top, panel ? panel.getBoundingClientRect().top : innerHeight);
  const offY = ((innerHeight - botTop) - topH) / 2;
  if (Math.abs(offY - (view.offY || 0)) > 4) {
    const was = view.offY || 0;
    view.offY = offY;
    if (TOUCH && G.pos) view.cam.y += (offY - was) / view.cam.zoom; // slide the map with the panels so the hero stays in view
  }
}

// ================================================================== highlights and hover
function updateHighlights() {
  if (!G?.map) return;
  const hl = {};
  hl.inReach = new Set(R.foesInReach(G).map(f => f.id));
  if (busy || G.stage !== 'scene') { view.hl = { hover: hover && { ...hover } }; return; }
  if (mode.kind === 'throw') {
    hl.targets = new Set(R.throwTargets(G).map(f => key(f.x, f.y)));
    if (mode.seq.length) { const f = G.foes.find(q => q.id === mode.seq[mode.seq.length - 1]); if (f) hl.picked = new Set([key(f.x, f.y)]); }
    hl.inReach = new Set(); hl.hover = hover && { ...hover }; view.hl = hl; return;
  }
  if (mode.kind === 'power') {
    const spec = R.powerSpec(G, mode.p);
    const landFoe = spec.landing && mode.foe && G.foes.find(f => f.id === mode.foe && !f.dead);
    const targets = landFoe ? R.landingSpots(G, landFoe) : R.powerTargets(G, mode.p);
    hl.targets = new Set(targets.map(c => key(c.x, c.y)));
    if (landFoe) hl.picked = new Set([key(landFoe.x, landFoe.y)]);
    hl.allyTargets = new Set(targets.filter(c => c.ally).map(c => c.id));
    if (spec.mode === 'self' && spec.radius) hl.area = areaKeys(G.pos, spec.radius);
    if (spec.mode === 'point' && hover && hl.targets.has(key(hover.x, hover.y))) hl.area = areaKeys(hover, spec.radius);
    if (spec.mode === 'self' && spec.radius && G.party.length > 1) hl.allyTargets = new Set(R.standing(G).filter(q => q !== G.hero && dist(q.pos, G.pos) <= spec.radius).map(q => q.hid));
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
function foeInfo(f) {
    const s = R.heroStats(G), D = R.foeAttackDice(G, f);
    const abil = (f.abilities || []).map(k => `<div class="abil">${R.FOE_ABILITIES[k].icon} <b style="color:#ffcfa0;font-size:12px">${esc(R.FOE_ABILITIES[k].name)}</b>: ${esc(R.FOE_ABILITIES[k].text)}</div>`).join('');
    const reach = R.inReach(G, G.pos, f, R.heroReach(G));
    tip.innerHTML = `<b>${esc(f.name)}</b> <span class="dim">${ENEMY_TYPES[f.type].label}${f.pinned ? ' · Pinned' : ''}${f.enraged ? ' · Enraged' : ''}</span>
      ${f.type !== 'minion' ? `<div class="hpbar"><i style="width:${(f.hp / f.maxHp) * 100}%"></i></div>${fmt(f.hp)} / ${fmt(f.maxHp)} health · armor ${f.armor}%` : '<div>Dies to any hit</div>'}
      <div>${D.n} attack${D.n === 1 ? '' : 's'} × ${fmt(f.damage)} · hits on ${D.hitOn}+, 6 crits ×${f.critMult || ({ minion: 1.5, elite: 2, boss: 2.5 })[f.type]} · ${f.reach > 1 ? `ranged ${f.reach}` : 'melee'} · move ${f.move}</div>
      ${f.type !== 'minion' ? `<div class="dim">Your hit: ${fmt(Math.round(s.damage * (1 - f.armor / 100)))} (crit ${fmt(Math.round(s.damage * s.critMult * (1 - f.armor / 100)))})</div>` : ''}
      ${f.ability ? `<div class="dim"><i>${esc(f.ability)}</i></div>` : ''}${abil}
      <div style="margin-top:4px;color:${reach ? 'var(--bad)' : 'var(--dim)'}">${reach ? (R.strikeLeft(G) ? 'Click to spend hits on it' : R.canAttack(G) ? 'In reach: click to attack it' : 'In reach') : 'Out of your reach'}</div>`.replace(/Click/g, TOUCH ? 'Tap' : 'Click');
}
function showTip(px, py) {
  if (TOUCH) return;
  const tip = $('#tip'), cn = $('#cursorNote');
  const f = hover && R.foeAt(G, hover.x, hover.y);
  if (f && !isModal()) {
    tip.innerHTML = foeInfo(f);
    tip.className = '';
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

// What tapping square t would do: a label for the confirm button, or null.
function intentFor(t) {
  if (!t || busy || G.stage !== 'scene') return null;
  if (mode.kind === 'power') {
    const spec = R.powerSpec(G, mode.p), valid = R.powerTargets(G, mode.p);
    if (!R.powerUsable(G, mode.p)) return null;
    if (spec.mode === 'self') return spec.radius && dist(t, G.pos) <= spec.radius ? `Use ${mode.p.name}` : null; // a tap in the shown area asks first
    const f = R.foeAt(G, t.x, t.y), ally = R.heroAt(G, t.x, t.y);
    if (spec.landing && mode.foe) {
      const tf = G.foes.find(q => q.id === mode.foe && !q.dead);
      if (tf && R.landingSpots(G, tf).some(c => c.x === t.x && c.y === t.y)) return `${mode.p.name}: appear here`;
    }
    if (spec.mode === 'foe' || spec.mode === 'foes') {
      if (f && valid.some(c => c.id === f.id)) return spec.landing ? `Target ${f.name}` : `${mode.p.name}: ${f.name}`;
      if (ally && valid.some(c => c.id === ally.hid)) return `${mode.p.name}: ${ally.name}`;
      return null;
    }
    return valid.some(c => c.x === t.x && c.y === t.y) ? `${mode.p.name} here` : null;
  }
  const other = R.heroAt(G, t.x, t.y);
  if (other && other !== G.hero) return `Switch to ${other.name}`;
  const f = R.foeAt(G, t.x, t.y);
  if (f) {
    const reach = R.inReach(G, G.pos, f, R.heroReach(G));
    if (reach && R.strikeLeft(G)) return `Strike ${f.name}`;
    if (reach && R.canAttack(G)) return `Attack ${f.name} (${R.attackPool(G).total}d6)`;
    return null;
  }
  if (G.map.chests.some(c => c.x === t.x && c.y === t.y && !c.opened)) return 'Open chest';
  if (G.cleared && t.x === G.map.exit.x && t.y === G.map.exit.y) return 'Descend the stair';
  const n = R.heroMoves(G).get(key(t.x, t.y));
  if (n && n.cost) {
    const blows = R.freeBlowsOn(G, pathTo(R.heroMoves(G), t.x, t.y)).length;
    return `Move here${G.cleared ? '' : ` (${n.cost})`}${blows ? ` ⚠ ${blows} free blow${blows > 1 ? 's' : ''}` : ''}`;
  }
  return null;
}
// Touch: the first tap selects a square (path preview, foe card); a second tap on it, or the button, does it.
let sel = null;
function selectTile(t) {
  sel = t; hover = t;
  updateHighlights();
  const tip = $('#tip'), label = intentFor(t);
  const f = t && R.foeAt(G, t.x, t.y);
  if (!t || (!f && !label)) { tip.hidden = true; sel = null; hover = null; updateHighlights(); return; }
  tip.className = 'docked';
  tip.innerHTML = `${f ? foeInfo(f) : ''}${label ? `<button class="primary go">${esc(label)}</button>` : ''}<button class="x" aria-label="Close">✕</button>`;
  tip.hidden = false;
  const go = tip.querySelector('.go');
  const shownAt = performance.now();
  if (go) go.onclick = () => { if (performance.now() - shownAt < 250) return; const q = sel; clearSel(); clickTile(q); }; // not the tap that opened it
  tip.querySelector('.x').onclick = clearSel;
}
function clearSel() { sel = null; hover = null; $('#tip').hidden = true; updateHighlights(); }

// ================================================================== input
function bindInput() {
  const cv = $('#view');
  let down = null, dragging = false;
  const pts = new Map();
  let pinch = 0;
  cv.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); dragging = true; return; }
    down = { x: e.clientX, y: e.clientY, b: e.button, touch: e.pointerType !== 'mouse' }; dragging = false; cv.setPointerCapture(e.pointerId);
  });
  const lift = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = 0; };
  cv.addEventListener('pointercancel', e => { lift(e); down = null; });
  cv.addEventListener('pointermove', e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      view.zoomBy(d / pinch); pinch = d; return;
    }
    if (e.pointerType !== 'mouse' && !down) return;
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (dragging || Math.hypot(dx, dy) > 7) { dragging = true; view.pan(dx, dy); down.x = e.clientX; down.y = e.clientY; cv.style.cursor = 'grabbing'; }
    }
    if (!G?.map) return;
    const t = view.pick(e.clientX, e.clientY, { bodies: !aimingAtSquare() });
    if ((t?.x !== hover?.x || t?.y !== hover?.y)) { hover = t; updateHighlights(); }
    else updateHighlights();
    showTip(e.clientX, e.clientY);
  });
  cv.addEventListener('pointerup', e => {
    cv.style.cursor = 'default';
    lift(e);
    const was = down; down = null;
    if (!was || dragging) return;
    if (was.b === 2) { cancelMode(); return; }
    const t = view.pick(e.clientX, e.clientY, { bodies: !aimingAtSquare() });
    if (!was.touch) { if (t) clickTile(t); return; }
    // touch: spending banked hits on a foe in reach is instant; anything else is select, then confirm
    const f = t && R.foeAt(G, t.x, t.y);
    if (f && R.strikeLeft(G) && mode.kind === 'idle' && R.inReach(G, G.pos, f, R.heroReach(G))) { clearSel(); clickTile(t); return; }
    if (t && sel && t.x === sel.x && t.y === sel.y && intentFor(t)) { clearSel(); clickTile(t); return; }
    if (t && mode.kind === 'power' && R.powerSpec(G, mode.p).landing && R.foeAt(G, t.x, t.y)) { clearSel(); clickTile(t); return; } // choosing Shadowstep's target spends nothing
    if (t && mode.kind === 'throw' && R.foeAt(G, t.x, t.y)) { clearSel(); clickTile(t); return; } // assigning hammer hits spends nothing
    const mate = t && mode.kind === 'idle' && R.heroAt(G, t.x, t.y);
    if (mate && mate !== G.hero) { clearSel(); switchHero(G.party.indexOf(mate)); return; } // one tap switches heroes
    selectTile(t);
  });
  cv.addEventListener('touchend', e => { if (e.cancelable) e.preventDefault(); }, { passive: false }); // no ghost click on whatever pops up under the finger
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
    else if (e.key === 'Tab') { e.preventDefault(); const n = nextHero(); switchHero(n >= 0 ? n : (G.active + 1) % G.party.length); }
    else if (k === 'i') (G.party.length > 1 ? armory(null) : inventory(G.active));
    else if (k === 'h' || k === '?') help();
    else if (k === 'c') view.centerOn(G.pos);
    else if (/^[1-9]$/.test(k)) { const p = R.powerList(G)[Number(k) - 1]; if (p) startPower(p); }
  });
  $('#btnInv').onclick = () => (G.party.length > 1 ? armory(null) : inventory(G.active));
  $('#btnHelp').onclick = () => help();
  $('#btnCenter').onclick = () => view.centerOn(G.pos);
  $('#btnSpeed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 3 : 1; $('#btnSpeed').textContent = `${speed}×`; };
  $('#btnMenu').onclick = () => menu();
  $('#btnForum').onclick = () => forum({ kind: 'list' });
  $('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal' && $('#modal .close')) closeModal(); });
}
// Square-targeted powers (leap, blink, meteor…) pick the square under the finger, never a unit standing in front of it.
function aimingAtSquare() { return mode.kind === 'power' && (['tile', 'point', 'walk'].includes(R.powerSpec(G, mode.p).mode) || (R.powerSpec(G, mode.p).landing && !!mode.foe)); }
function cancelMode() { if (mode.kind !== 'idle') { mode = { kind: 'idle' }; refresh(); } }
// ------------------------------------------------------------------ the party
// The next standing hero (after the active one) who still has something to do this round, or -1.
function nextHero() {
  const n = G.party.length;
  for (let k = 1; k < n; k++) { const i = (G.active + k) % n; if (!R.heroDone(G, G.party[i])) return i; }
  return -1;
}
function switchHero(i) {
  if (busy || !G || i < 0 || i === G.active || !G.party[i]) return;
  if (G.party[i].hp <= 0) return toast(G.party[i].name, 'Down until the scene is clear.', 'err');
  clearSel();
  mode = { kind: 'idle' };
  spendKind = null;
  R.selectHero(G, i);
  view.centerOn(G.pos);
  refresh();
}
// Portrait chips for every hero: health, ward, whether they still have a move or action. Tap to take control.
function partyStrip() {
  const el = $('#party');
  if (!G || G.party.length < 2) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = G.party.map((h, i) => {
    const sh = shown?.[h.hid], hp = sh ? sh.hp : h.hp, ward = sh ? sh.ward + sh.rune : (h.ward || 0) + (h.rune || 0), mx = R.derive(h).maxHp;
    const state = h.hp <= 0 && !sh ? 'down' : hp <= 0 ? 'down' : G.cleared ? '' : R.heroDone(G, h) ? 'done' : h.turn?.acted ? 'acted' : 'ready';
    const tag = { down: '✖ down', done: '✓ done', acted: 'acted', ready: 'ready', '': '' }[state];
    return `<button class="mate ${i === G.active ? 'on' : ''} ${state}" data-i="${i}" style="--hc:${HERO_COLOR[h.cls]}">
      <span class="nm">${R.CLASSES[h.cls].glyph} ${esc(h.name)}</span><span class="tag">${tag}</span>
      <span class="bar"><i style="width:${Math.max(0, hp / mx) * 100}%"></i></span>${ward > 0 ? `<span class="wd">🛡${fmt(ward)}</span>` : ''}</button>`;
  }).join('');
  el.querySelectorAll('.mate').forEach(b => b.onclick = () => switchHero(Number(b.dataset.i)));
}
async function endTurn() {
  if (busy || !G || G.stage !== 'scene') return;
  if (G.cleared) return toast('The scene is clear', 'Open the chests, then take the spiral stair in the west wall.');
  mode = { kind: 'idle' };
  await act(() => R.endTurn(G, rng));
  if (G.stage === 'scene') view.centerOn(G.pos);
}
async function clickTile(t) {
  if (busy || !G || G.stage !== 'scene') return;
  if (mode.kind === 'throw') {
    const f = R.foeAt(G, t.x, t.y), T = R.throwPending(G);
    if (!f || !T || !R.throwTargets(G).includes(f)) return toast('Hammer throw', 'Pick a highlighted foe within 6 squares.', 'err');
    if (mode.seq[mode.seq.length - 1] === f.id) return toast('Hammer throw', 'Not the same foe twice in a row: pick another one first.', 'err');
    if (mode.seq.length >= T.hits + T.crits) return toast('Hammer throw', 'Every hit is assigned: throw, or undo one.', 'err');
    mode.seq.push(f.id); return refresh();
  }
  if (mode.kind === 'power') return clickPower(t);
  const other = R.heroAt(G, t.x, t.y);
  if (other && other !== G.hero) return switchHero(G.party.indexOf(other));
  const f = R.foeAt(G, t.x, t.y);
  if (f) {
    if (R.strikeLeft(G)) { if (R.inReach(G, G.pos, f, R.heroReach(G))) return act(() => R.spend(G, f.id, rng, spendKind)); return toast(`${f.name} is out of reach`, 'Move closer, or spend your hits on a foe with a red ring.', 'err'); }
    if (R.canAttack(G) && R.inReach(G, G.pos, f, R.heroReach(G))) {
      await act(() => R.attack(G, rng));
      if (R.strikeLeft(G) && !f.dead) await act(() => R.spend(G, f.id, rng, spendKind), { quiet: true });
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
  if (mode.kind === 'power' && mode.p.key === p.key) return cancelMode();
  const spec = R.powerSpec(G, p);
  mode = { kind: 'power', p, picked: [], opened: performance.now() };
  refresh();
}
async function clickPower(t) {
  const p = mode.p, spec = R.powerSpec(G, p);
  if (!R.powerUsable(G, p)) return;
  if (spec.mode === 'self') { if (spec.radius && dist(t, G.pos) <= spec.radius) return firePower(null); return; } // a deliberate click in the area (touch confirms first)
  const valid = R.powerTargets(G, p);
  if (spec.landing) { // Shadowstep: first the foe, then the square beside it
    const f = R.foeAt(G, t.x, t.y);
    if (f && valid.some(c => c.id === f.id)) { mode.foe = f.id; return refresh(); }
    const tf = mode.foe && G.foes.find(q => q.id === mode.foe && !q.dead);
    if (tf && R.landingSpots(G, tf).some(c => c.x === t.x && c.y === t.y)) return firePower({ ids: [tf.id], x: t.x, y: t.y });
    return toast(p.name, tf ? 'Pick a highlighted square beside the target.' : 'Pick a highlighted foe first.', 'err');
  }
  if (spec.mode === 'foe' || spec.mode === 'foes') {
    const ally = R.heroAt(G, t.x, t.y);
    if (ally && valid.some(c => c.id === ally.hid)) return firePower({ ids: [ally.hid] });
    const f = R.foeAt(G, t.x, t.y);
    if (!f || !valid.some(c => c.id === f.id)) return toast(p.name, spec.allies ? 'Pick a highlighted ally or foe.' : 'Pick a highlighted foe.', 'err');
    if (spec.mode === 'foe') return firePower({ ids: [f.id] });
    mode.picked = mode.picked.includes(f.id) ? mode.picked.filter(x => x !== f.id) : [...mode.picked, f.id].slice(-(spec.max || 2));
    return refresh();
  }
  if (!valid.some(c => c.x === t.x && c.y === t.y)) return toast(p.name, 'Pick a highlighted square.', 'err');
  return firePower({ x: t.x, y: t.y });
}
async function firePower(target, p = mode.p) {
  mode = { kind: 'idle' };
  if (p.key === 'hammer') target = { ...(target || {}), mode: p.hmode || 'strike' };
  const r = await act(() => R.usePower(G, p.key, target, rng));
  if (r?.ok && r.attack && G.stage === 'scene') {
    toast(p.name, R.foesInReach(G).length ? `Attack primed: ${TOUCH ? 'tap Strike' : 'click a foe in reach (or press A)'} to roll.` : 'Attack primed: move into reach, then attack.');
  }
}

// ================================================================== items
function itemCard(it, { actions = '', compare = true, who } = {}) {
  const set = it.set && R.SETS[it.set];
  const diff = compare && G ? R.compareItem(G, it, who) : null;
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
  const items = all.flatMap(l => l.items).filter(it => G.bag.some(b => b.id === it.id));
  if (!items.length) return;
  const eqBtns = it => G.party.length > 1 ? G.party.map((h, i) => `<button class="${i === G.active ? 'primary' : ''}" data-eq="${it.id}" data-who="${i}" style="border-color:${HERO_COLOR[h.cls]}">${esc(h.name)}</button>`).join('') : `<button class="primary" data-eq="${it.id}" data-who="0">Equip</button>`;
  const p = modal(`<button class="close">✕</button><h2>${esc(all.map(l => l.from).join(' · '))}</h2>
    ${G.party.length > 1 ? `<p class="dim">Equip on a hero now, or keep it in the party's satchel (🎒 Gear). ▲▼ compare with ${esc(G.hero.name)}'s gear.</p>` : ''}
    <div class="items">${items.map(it => itemCard(it, { actions: eqBtns(it) })).join('')}</div>
    <div class="btnrow">${G.party.length > 1 ? '<button id="lootCmp">Compare in party gear</button>' : ''}<button id="lootOk" class="primary">Into the satchel</button></div>`, { onClose: () => refresh() });
  const cmp = p.querySelector('#lootCmp');
  if (cmp) cmp.onclick = () => { $('#modal').onClose = null; armory(items.find(it => G.bag.some(b => b.id === it.id))?.id || null); };
  p.querySelector('.close').onclick = closeModal;
  p.querySelector('#lootOk').onclick = closeModal;
  p.querySelectorAll('[data-eq]').forEach(b => b.onclick = async () => {
    const who = Number(b.dataset.who);
    R.equip(G, b.dataset.eq, who);
    const card = b.closest('.item');
    card.style.opacity = 0.45; card.querySelectorAll('button').forEach(x => { x.disabled = true; });
    card.querySelector('.acts').insertAdjacentHTML('beforeend', `<span class="dim">→ ${esc(G.party[who].name)}</span>`);
    await playFx(); refresh(); save();
  });
}
function abilityRows(who = G.active) {
  const hero = G.party[who];
  const pw = R.powersOf(hero).map(p => {
    const spec = R.powerSpec(G, p), how = R.powerText(p) === p.text && spec.text !== p.text ? spec.text : '';
    const tag = p.attack ? 'attack power' : spec.strike ? 'move + strike' : p.set ? `${R.SETS[p.set].name} set (${p.pieces} piece${p.pieces > 1 ? 's' : ''})` : R.CLASSES[hero.cls].name;
    return `<div class="abil" style="${p.set ? `border-left-color:${R.SETS[p.set].color}` : ''}"><b>${esc(p.name)}</b> <span class="dim">${p.cost} energy · ${esc(tag)}</span><div>${esc(R.powerText(p))}</div>${how ? `<div class="how">▸ ${esc(how)}</div>` : ''}${p.boosted?.length ? `<div class="dim">Boosted by ${esc(p.boosted.join(', '))}</div>` : ''}</div>`;
  }).join('');
  const wares = (G.wares || []).map(w => R.CONSUMABLES[w.key]).filter(Boolean)
    .map(C => `<div class="abil ware"><b>${esc(C.name)}</b> <span class="dim">ware · shared · free, one per hero per turn</span><div>${esc(C.text)}</div></div>`).join('');
  return pw + wares;
}
let invWho = null;
function inventory(who = invWho ?? G?.active) {
  if (!G) return;
  invWho = who = Math.min(who ?? 0, G.party.length - 1);
  const h = G.party[who], s = R.derive(h);
  const tabsHtml = G.party.length > 1 ? `<div class="tabs heroes">${G.party.map((q, i) => `<button data-hero="${i}" class="${i === who ? 'on' : ''}" style="border-color:${HERO_COLOR[q.cls]}">${R.CLASSES[q.cls].glyph} ${esc(q.name)}</button>`).join('')}</div>` : '';
  const slots = R.SLOTS.map(sl => `<div class="slot"><div class="lbl">${esc(SLOT_LABEL[sl])}</div>${h.gear[sl] ? itemCard(h.gear[sl], { compare: false, actions: `<button data-un="${sl}">Unequip</button>` }) : '<span class="dim">empty</span>'}</div>`).join('');
  const counts = {};
  for (const it of Object.values(h.gear)) if (it?.set) counts[it.set] = (counts[it.set] || 0) + 1;
  const setRows = Object.entries(counts).map(([k, n]) => `<div style="color:${R.SETS[k].color}">${esc(R.SETS[k].name)} ${n}/4 · ${esc(R.SETS[k].power.name)}${R.SETS[k].bonuses.map(b => ` <span class="${n >= b.n ? '' : 'dim'}">[${b.n}: ${esc(R.statsText(b.stats))}]</span>`).join('')}</div>`).join('') || '<div class="dim">No set pieces equipped. One piece of a set unlocks its power.</div>';
  const syn = R.SYNERGIES.filter(sy => (h.unlocked || []).includes(`syn:${sy.key}`)).map(sy => `<div>✦ <b>${esc(sy.name)}</b>: ${esc(R.synergyText(sy))}</div>`).join('') || `<div class="dim">${R.SYNERGIES.length} hidden synergies wait to be discovered by mixing sets.</div>`;
  const stat = (l, v) => `<span>${l}</span><span>${v}</span>`;
  const p = modal(`<button class="close">✕</button><h2>${esc(h.name)} <span class="dim" style="font-size:14px">${h.name === R.CLASSES[h.cls].name ? '' : `the ${esc(R.CLASSES[h.cls].name)} · `}party Favour ${G.favour || 0}</span></h2>${G.party.length > 1 ? '<button id="toArmory" style="margin-bottom:8px">⇄ Party gear: compare and swap</button>' : ''}${tabsHtml}
    <div class="inv"><div>
      <div class="statgrid">${stat('Max health', fmt(s.maxHp))}${stat('Armour', armourText(s.armor))}${stat('Attack dice', s.dice)}${stat('Damage per hit', fmt(s.damage))}${stat('Crit multiplier', '×' + s.critMult)}${stat('Cleave', s.cleave || 0)}${stat('Energy per round', R.energyPerRound(h) === s.energyPerRound ? s.energyPerRound : `${R.energyPerRound(h)} <span class="dim">(${s.energyPerRound} before taper)</span>`)}${stat('Energy per kill', s.energyPerKill)}${stat('Max energy', s.maxEnergy)}${stat('Move', s.move)}${stat('Reach', s.reach || 'melee')}</div>
      <h3>Abilities</h3><div class="abils">${abilityRows(who)}</div>
      <h3 style="margin-top:10px">Sets</h3><div class="sets">${setRows}</div>
      <h3 style="margin-top:10px">Synergies</h3><div class="sets">${syn}</div>
      <h3 style="margin-top:10px">Equipped</h3><div class="slots">${slots}</div>
    </div><div>
      <h3>${G.party.length > 1 ? 'Party satchel' : 'Satchel'} (${G.bag.length})</h3>${G.party.length > 1 ? `<p class="dim" style="margin:0 0 6px">▲▼ compare with ${esc(h.name)}'s gear.</p>` : ''}
      <div class="items">${G.bag.map(it => itemCard(it, { who, actions: `<button class="primary" data-eq="${it.id}">Equip on ${esc(h.name)}</button>${G.stage === 'camp' ? `<button data-sell="${it.id}">Sell ${R.SELL_VALUE[it.rarity]}✦</button>` : `<button data-drop="${it.id}">Drop</button>`}` })).join('') || '<div class="dim">Empty. Chests, elites and bosses carry loot.</div>'}</div>
    </div></div>`, { onClose: () => refresh() });
  p.querySelector('.close').onclick = closeModal;
  const again = (w = who) => { const m = $('#modal'); const oc = m.onClose; m.onClose = null; inventory(w); $('#modal').onClose = oc; };
  p.querySelectorAll('[data-hero]').forEach(b => b.onclick = () => again(Number(b.dataset.hero)));
  const ta = p.querySelector('#toArmory'); if (ta) ta.onclick = () => { $('#modal').onClose = null; armory(null); };
  p.querySelectorAll('[data-eq]').forEach(b => b.onclick = async () => { R.equip(G, b.dataset.eq, who); G.fx = G.fx.filter(e => { if (e.t === 'unlock') toast(e.title, e.text, 'unlock', 9000); return false; }); save(); again(); });
  p.querySelectorAll('[data-un]').forEach(b => b.onclick = () => { R.unequip(G, b.dataset.un, who); save(); again(); });
  p.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { R.discard(G, b.dataset.drop); save(); again(); });
  p.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => { R.sell(G, b.dataset.sell); save(); again(); });
}

// ================================================================== the armory: the whole party's gear side by side
const SHORT = { maxHp: '❤', damage: '⚔', dice: 'dice', armor: '⛨', critMult: 'crit ×', cleave: 'cleave', energyPerRound: 'en/round', energyPerKill: 'en/kill', maxEnergy: 'max en' };
const WEIGHT = { maxHp: 1, damage: 2, dice: 400, armor: 30, critMult: 300, cleave: 150, energyPerRound: 15, energyPerKill: 10, maxEnergy: 3 };
const fmtDelta = (k, v) => `${v > 0 ? '+' : '−'}${k === 'armor' ? Math.abs(v) : k === 'critMult' ? Math.abs(v) : fmt(Math.abs(v))} ${SHORT[k]}`;
const scoreOf = d => Object.entries(d.delta).reduce((t, [k, v]) => t + v * (WEIGHT[k] || 1), 0) + d.gained.length * 400 - d.lost.length * 400;
const itemLine = it => Object.entries(it.stats).slice(0, 2).map(([k, v]) => fmtDelta(k, v)).join(' · ');
let armPick = null;
function armory(pick = armPick) {
  if (!G) return;
  const prevScroll = $('#modal .panel')?.scrollTop || 0;
  armPick = pick && R.locate(G, pick) ? pick : null;
  const loc = armPick && R.locate(G, armPick);
  const n = G.party.length;
  const head = G.party.map((h, i) => {
    const s = R.derive(h), c = {};
    for (const it of Object.values(h.gear)) if (it?.set) c[it.set] = (c[it.set] || 0) + 1;
    const syns = R.SYNERGIES.filter(sy => (h.unlocked || []).includes(`syn:${sy.key}`) && Object.entries(sy.needs).every(([k, q]) => (c[k] || 0) >= q));
    return `<div class="ah" style="--hc:${HERO_COLOR[h.cls]}"><button class="hn" data-hero="${i}">${R.CLASSES[h.cls].glyph} ${esc(h.name)}</button>
      <div class="hs">❤ ${fmt(s.maxHp)} · ⛨ ${armourText(s.armor)}<br>⚔ ${fmt(s.damage)} × ${s.dice}d6${s.critMult > 2 ? ` · crit ×${s.critMult}` : ''}</div>
      <div class="hsets">${Object.entries(c).map(([k, q]) => `<span class="sdot" style="--sc:${R.SETS[k].color}" title="${esc(R.SETS[k].name)}">${q}</span>`).join('')}${syns.map(sy => `<span class="syn" title="${esc(R.synergyText(sy))}">✦ ${esc(sy.name)}</span>`).join('')}</div></div>`;
  }).join('');
  // previews for the picked item, per destination hero
  const pv = {};
  if (loc) G.party.forEach((h, i) => { if (i !== loc.who) pv[i] = R.previewPlace(G, armPick, i); });
  const rows = R.SLOTS.map(sl => `<div class="as">${esc(SLOT_LABEL[sl])}</div>` + G.party.map((h, i) => {
    const it = h.gear[sl];
    const picked = it && it.id === armPick;
    const target = loc && loc.slot === sl && loc.who !== i;
    let badge = '';
    if (target) {
      const mine = pv[i].find(d => d.who === i), sc = mine ? scoreOf(mine) : 0;
      const gain = pv[i].some(d => d.gained.length), loss = pv[i].some(d => d.lost.length);
      badge = `<span class="pvb ${sc > 0 ? 'up' : sc < 0 ? 'down' : ''}">${sc > 0 ? '▲' : sc < 0 ? '▼' : '='}${gain ? ' ✦' : ''}${loss ? ' ✖' : ''}</span>`;
    }
    return `<button class="ac ${picked ? 'picked' : ''} ${target ? 'target' : ''}" data-cell="${i}:${sl}" ${it ? `data-item="${it.id}"` : ''} style="${it ? `--rc:${rarityColor(it)}` : ''}">${it ? `<span class="in">${esc(it.name)}</span><span class="il">${esc(itemLine(it))}</span>` : '<span class="dim">—</span>'}${badge}</button>`;
  }).join('')).join('');
  const bagBySlot = R.SLOTS.map(sl => [sl, G.bag.filter(it => it.slot === sl)]).filter(([, l]) => l.length);
  const bag = bagBySlot.length ? bagBySlot.map(([sl, list]) => `<div class="bagrow"><span class="as">${esc(SLOT_LABEL[sl])}</span>${list.map(it => `<button class="bi ${it.id === armPick ? 'picked' : ''}" data-item="${it.id}" style="--rc:${rarityColor(it)}"><span class="in">${esc(it.name)}</span><span class="il">${esc(itemLine(it))}</span></button>`).join('')}</div>`).join('') : '<p class="dim">The satchel is empty. Chests, elites and bosses carry loot.</p>';
  // the picked item: what it would do on each hero
  let detail = '';
  if (loc) {
    const owner = loc.who >= 0 ? G.party[loc.who] : null;
    const opts = G.party.map((h, i) => {
      if (i === loc.who) return '';
      const list = pv[i], mine = list.find(d => d.who === i), sc = mine ? scoreOf(mine) : 0;
      const lines = list.map(d => {
        const who = G.party[d.who].name;
        const parts = [...Object.entries(d.delta).map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}">${fmtDelta(k, v)}</span>`), ...d.gained.map(g => `<span class="gain">✦ ${esc(g.name)}</span>`), ...d.lost.map(g => `<span class="lose">✖ ${esc(g.name)}</span>`)];
        return `<div><b>${esc(who)}:</b> ${parts.join(' ') || '<span class="dim">no change</span>'}</div>`;
      }).join('');
      const swap = h.gear[loc.slot] ? ` (swaps for ${esc(h.gear[loc.slot].name)})` : '';
      return `<div class="opt ${sc > 0 ? 'better' : sc < 0 ? 'worse' : ''}"><button class="${sc > 0 ? 'primary' : ''}" data-to="${i}" style="border-color:${HERO_COLOR[h.cls]}">Give to ${esc(h.name)}</button><span class="dim">${swap}</span>${lines}</div>`;
    }).join('');
    const back = owner ? `<div class="opt">${(() => { const d = R.previewPlace(G, armPick, -1); return `<button data-to="-1">Into the satchel</button>${d.map(x => `<div><b>${esc(G.party[x.who].name)}:</b> ${[...Object.entries(x.delta).map(([k, v]) => `<span class="${v > 0 ? 'up' : 'down'}">${fmtDelta(k, v)}</span>`), ...x.lost.map(g => `<span class="lose">✖ ${esc(g.name)}</span>`)].join(' ')}</div>`).join('')}`; })()}</div>` : '';
    detail = `<div class="apick"><div class="aph"><div class="full">${itemCard(loc.item, { compare: false })}</div><div class="mini" style="--rc:${rarityColor(loc.item)}"><b>${esc(loc.item.name)}</b> <span class="dim">${esc(SLOT_LABEL[loc.item.slot])}</span><br><span class="il">${esc(R.statsText(loc.item.stats))}</span></div><div class="dim">${owner ? `Worn by ${esc(owner.name)}` : 'In the satchel'} · tap a highlighted slot or a button below.</div><button class="x" id="apX">✕</button></div><div class="opts">${opts}${back}</div></div>`;
  }
  // synergy tracker
  const prog = R.synergyProgress(G).map(sp => {
    const needs = Object.entries(sp.needs).map(([k, q]) => `<span class="need" style="--sc:${R.SETS[k].color}">${esc(R.SETS[k].name)} ×${q}</span>`).join(' + ');
    const active = sp.heroes.filter(x => x.active).map(x => G.party[x.who].name);
    const best = sp.heroes.filter(x => !x.active).sort((a, b) => a.missing - b.missing)[0];
    const enough = Object.entries(sp.needs).every(([k, q]) => sp.pool[k] >= q);
    const status = active.length ? `<span class="gain">active on ${esc(active.join(', '))}</span>` : best ? `<span class="dim">${esc(G.party[best.who].name)} is ${best.missing} piece${best.missing > 1 ? 's' : ''} away${enough ? '; the party holds enough pieces' : ''}</span>` : '';
    return `<div class="sp ${active.length ? 'on' : ''}"><b>${sp.known ? esc(sp.name) : 'Hidden synergy'}</b> ${needs}<div>${sp.known ? `<span class="dim">${esc(sp.text)}</span> ` : ''}${status}</div></div>`;
  }).join('');
  const p = modal(`<button class="close">✕</button><h2>Party gear</h2>
    <p class="dim armhelp">Tap any item, worn or in the satchel, to see what it would do on each hero (▲ better, ▼ worse, ✦ unlocks a set power or synergy, ✖ loses one), then tap a highlighted slot to move or swap it. Tap a hero's name for their abilities.</p>
    ${detail}
    <div class="agrid" style="--n:${n}"><div></div>${head}${rows}</div>
    <h3>Satchel (${G.bag.length})</h3><div class="abag">${bag}</div>
    <details class="syntrack" ${prog && G.party.length ? 'open' : ''}><summary>Synergies</summary><p class="dim">A synergy needs pieces of two sets on the <b>same</b> hero. Its effect stays secret until someone first wears the combination.</p>${prog}</details>`, { onClose: () => { armPick = null; refresh(); } });
  p.className = 'panel wide' + (loc ? ' picking' : '');
  p.scrollTop = prevScroll;
  p.querySelector('.close').onclick = closeModal;
  const again = id => { const m = $('#modal'), oc = m.onClose; m.onClose = null; armory(id); $('#modal').onClose = oc; };
  const doPlace = async to => {
    const id = armPick; const r = R.place(G, id, to);
    if (!r.ok) return toast(r.error, '', 'err');
    G.fx = G.fx.filter(e => { if (e.t === 'unlock') toast(e.title, e.text, 'unlock', 9000); return false; });
    save(); again(null);
  };
  p.querySelectorAll('[data-item]').forEach(b => b.onclick = () => {
    const cell = b.dataset.cell;
    if (armPick && cell && b.classList.contains('target')) return doPlace(Number(cell.split(':')[0]));
    again(b.dataset.item === armPick ? null : b.dataset.item);
  });
  p.querySelectorAll('.ac:not([data-item])').forEach(b => b.onclick = () => { if (b.classList.contains('target')) doPlace(Number(b.dataset.cell.split(':')[0])); });
  p.querySelectorAll('[data-to]').forEach(b => b.onclick = () => doPlace(Number(b.dataset.to)));
  p.querySelectorAll('[data-hero]').forEach(b => b.onclick = () => { const m = $('#modal'); m.onClose = null; inventory(Number(b.dataset.hero)); $('#modal').onClose = () => armory(); });
  const x = p.querySelector('#apX'); if (x) x.onclick = () => again(null);
}

// ================================================================== the Rakshasa's camp
let campWho = 0;
function camp(tab = 'sell', line = pickLine(LINES.open, rng)) {
  $('#hud').hidden = true;
  campWho = Math.min(campWho, G.party.length - 1);
  const h = G.party[campWho];
  const heroTabs = G.party.length > 1 ? `<div class="tabs heroes">Boons for: ${G.party.map((q, i) => `<button data-who="${i}" class="${i === campWho ? 'on' : ''}" style="border-color:${HERO_COLOR[q.cls]}">${R.CLASSES[q.cls].glyph} ${esc(q.name)}</button>`).join('')}</div>` : '';
  const tabs = ['sell', 'boons', 'wares', 'crown'].map(t => `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${{ sell: 'Sell gear', boons: 'Boons', wares: 'Wares', crown: 'Three-Card Crown' }[t]}</button>`).join('');
  let body = '';
  if (tab === 'sell') body = `<div class="items">${G.bag.map(it => itemCard(it, { compare: G.party.length < 2, actions: `<button class="primary" data-sell="${it.id}">Sell for ${R.SELL_VALUE[it.rarity]} Favour</button>` })).join('') || '<div class="dim">The satchel is empty.</div>'}</div><p class="dim">Equip gear from 🎒 Gear before you sell.</p>`;
  if (tab === 'boons') body = `${heroTabs}<div class="shop">${Object.entries(R.BOONS).map(([k, B]) => { const price = R.boonPrice(h, k), locked = R.boonLocked(h, k); return `<div class="ware"><div><b>${esc(B.name)}</b>${esc(B.text)}${B.once ? ' <span class="dim">(once)</span>' : ''}${h.boonBuys?.[k] ? ` <span class="dim">· owned ×${h.boonBuys[k]}</span>` : ''}</div><button data-boon="${k}" ${locked || (G.favour || 0) < price ? 'disabled' : ''}>${locked ? 'Owned' : price + ' ✦'}</button></div>`; }).join('')}</div>`;
  if (tab === 'wares') body = `<div class="shop">${Object.entries(R.CONSUMABLES).map(([k, C]) => `<div class="ware">${consumableSVG(k, 44)}<div><b>${esc(C.name)}</b>${esc(C.text)}</div><button data-ware="${k}" ${(G.favour || 0) < C.cost ? 'disabled' : ''}>${C.cost} ✦</button></div>`).join('')}</div><p class="dim">Wares go in the party's pouch: free to use in a fight, one per hero per turn. You carry ${G.wares.length}.</p>`;
  if (tab === 'crown') body = crownHTML();
  const p = modal(`<div class="rak"><img src="assets/rakshasa-face.jpg" alt="The Rakshasa"><div><h2>The Rakshasa's Rug</h2><div class="line">“${esc(line)}”</div><div class="dim" style="margin-top:4px">You rest by his lamp: ${G.party.length > 1 ? 'the party is' : 'health'} restored. Favour: <b style="color:var(--brass2)">${G.favour || 0} ✦</b></div></div></div>
    <div class="tabs">${tabs}<span style="flex:1"></span><button id="campInv">🎒 Gear</button><button class="primary" id="campGo">Onward: ${esc(G.adv.acts[G.act].name)}</button></div>${body}`);
  p.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => camp(b.dataset.tab, line));
  p.querySelector('#campGo').onclick = () => { R.leaveCamp(G); $('#modal').hidden = true; save(); toast('The Rakshasa', pickLine(LINES.close, rng)); beginScene(); };
  p.querySelector('#campInv').onclick = () => { $('#modal').onClose = null; if (G.party.length > 1) armory(null); else inventory(campWho); $('#modal').onClose = () => camp(tab, line); };
  p.querySelectorAll('[data-who]').forEach(b => b.onclick = () => { campWho = Number(b.dataset.who); camp(tab, line); });
  p.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => { const r = R.sell(G, b.dataset.sell); save(); camp(tab, pickLine(LINES.sell[r.rarity] || LINES.sell.common, rng)); });
  p.querySelectorAll('[data-boon]').forEach(b => b.onclick = () => { const r = R.buyBoon(G, b.dataset.boon, campWho); save(); camp(tab, r.ok ? pickLine(LINES.boon, rng) : r.error); });
  p.querySelectorAll('[data-ware]').forEach(b => b.onclick = () => { const r = R.buyWare(G, b.dataset.ware); save(); camp(tab, r.ok ? pickLine(LINES.buy, rng) : r.error); });
  if (tab === 'crown') bindCrown(p, line);
}
// Three-Card Crown against the house: 3 cards, one redraw of up to 2, ties go to the house.
let crown = null;
function crownHTML() {
  G.camp = G.camp || {};
  const played = G.camp.hands || 0;
  if (!crown || crown.phase === 'done') {
    const last = crown?.phase === 'done' ? `<div class="cards">${crown.house.map(c => cardSVG(c, { width: 70 })).join('')}</div><p style="text-align:center">House: <b>${esc(crown.houseHand)}</b> · You: <b>${esc(crown.hand)}</b> · <b style="color:${crown.win ? 'var(--good)' : 'var(--bad)'}">${crown.win ? 'You win' : 'The house wins'}</b>${crown.prizeText ? ` · ${esc(crown.prizeText)}` : ''}</p><div class="cards">${crown.cards.map(c => cardSVG(c, { width: 70 })).join('')}</div>` : '';
    return `${last}<p>Three cards each; you may redraw up to two, once. Best hand wins (three of a kind, run, flush, pair, high card); ties go to the house. ${3 - played} hand${3 - played === 1 ? '' : 's'} left tonight.</p>
      <div class="btnrow" style="justify-content:flex-start">${[1, 2, 3].map(w => `<button data-wager="${w}" ${played >= 3 || (G.favour || 0) < w ? 'disabled' : ''}>Wager ${w} ✦</button>`).join('')}<button data-wager="0" ${played >= 3 ? 'disabled' : ''}>Play for a prize (a ware)</button></div>`;
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
    if (crown.wager) G.favour = Math.max(0, (G.favour || 0) + (crown.win ? crown.wager : -crown.wager));
    else if (crown.win) {
      const keys = Object.keys(R.CONSUMABLES), k = keys[Math.floor(rng() * keys.length)];
      G.wares.push({ id: 'w' + Date.now().toString(36), key: k });
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
    <h3>Your party</h3><p>Pick 1 to 4 heroes on the title screen; you control them all. Each hero gets their own move and action every round, in any order: tap a hero (on the map or in the party strip) to take control, or press <b>Next</b> (<kbd>Tab</kbd>). When everyone is done, <b>End round</b>: each foe goes for the nearest hero it can reach (Iron Bulwark makes them fight the Ironclad). A hero at 0 health is <b>down</b> until the scene is clear, then gets back up with ${Math.round(R.SOLO.revive * 100)}% health; the run only ends if the whole party falls. Gear, the satchel, Favour and wares are shared; equip anything on anyone. <b>Party gear</b> (🎒) lays every hero's gear side by side: tap an item to see what it would do on each hero, including any set power or synergy it would unlock or break, then tap to move or swap it. Its synergy tracker shows how close each hero is to every synergy.</p>
    <h3>Your turn</h3><p>A <b>move</b> and <b>one action</b> (Attack, a Power, or Sprint), in any order. Blue squares show where you can walk. Climbing one level costs an extra square; rough ground costs 2. Ledges two levels high need a leap, grapple or teleport.</p>
    <h3>Attacking</h3><p>Click a foe with a red ring (in reach), or press <kbd>A</kbd>. You roll your <b>dice pool</b> of d6s: every 4+ is a hit, every 6 a crit. The hits form a pool you spend one at a time by clicking foes in reach (pick Crit or Hit in the panel, or leave it on Auto); unspent hits stay until you end your turn, so you can move and keep striking: each hit kills a minion or deals your damage per hit to an elite or boss (a crit multiplies it). Damage per hit is reduced by the foe's armor. <b>High ground</b> (you stand above a foe in reach) adds a die; attacking <b>from hiding</b> adds 3.</p>
    <h3>Powers</h3><p>Powers cost energy and use your action. You gain energy every round and for every kill, however the foe dies (an attack, a power, a fall into a chasm): a blue +N ⚡ shows each one. <b>Attack powers</b> (marked "attack") prime your attack instead, and <b>move-and-strike</b> powers (Leaping Strike, Grapple Line, Shadowstep, marked "+ strike") move you and then let you attack in the same turn. Positional powers move you or your foes: hurl them into walls (<b>slammed</b>: +1 hit), into chasms, or pin them in place. Gear from an <b>item set</b> unlocks that set's power with just one piece.</p>
    <p>Tapping a power or ware never fires it straight away: a panel shows what it does, and it only happens when you confirm (Use, Confirm, or picking a target). Every ability you have is described under Gear.</p>
    <h3>Breaking away</h3><p>Walking away from a foe beside you gives it a <b>free blow</b> (the path turns red). Leaps, teleports and Vanish avoid it.</p>
    <h3>Defending</h3><p>In the enemy phase each foe rolls one die per attack, like you do: every 4+ is a blow that lands (5+ against heavy armour, 30 or more), and every 6 is a <b>crit</b> (minions ×1.5, elites ×2, bosses ×2.5). You take an extra die when <b>surrounded</b> (3+ foes beside you) or attacked <b>from higher ground</b>.</p>
    <p><b>Armour</b> is a rating: it blocks rating ÷ (rating + 100) of each blow, so 100 armour halves damage and nothing is ever immune; your armour shows as "rating (share blocked)". A crit pierces half your armour, and foes with <b>Armour-breaker</b> ignore 20 more.</p>
    <p><b>Wards</b> soak what gets through armour. You hold two layers: a <b>ward</b> (anyone's powers and wares) and a <b>rune ward</b> (the Runepriest's Warding Circle and Rune of Recall). A new ward in a layer only replaces the old one if it's bigger; they never add up. Damage hits the rune ward first, then the ward. At the end of each round both halve.</p>
    <h3>Energy</h3><p>Every kill grants energy (a blue +N ⚡). Minion kills taper each round: the first pays in full, the 2nd and 3rd half, later ones a quarter; elite and boss kills always pay in full. At the end of the round you gain your Energy per Round, or half of it if you're already at half your max or more. Energy per Round from gear also tapers: the first +15 counts in full, the next +15 half, the rest a quarter. <b>Surge</b>: once per round, after acting, spend ${R.ENERGY.surge} energy to act again. Some foes drain energy: <b>Energy Leech</b>, <b>Drown</b> (2+ blows landing take 25) and <b>Chill</b> (heroes beside it lose 10 each round).</p>
    <h3>The Runepriest</h3><p><b>Runebrand</b>: every foe the Runepriest damages is branded until the end of the round, and any other hero attacking with a branded foe in reach rolls +1 die. <b>Reactions</b> cost energy but not his action, work outside his turn and once each per round: on another hero's turn, the ᛟ row offers <b>Rune of Mending</b> (25: heal an ally below a third of their health by 15%) and <b>Rune of Haste</b> (30: their next attack rolls +1 die). <b>Hammer of the Deep</b> has three modes, 40 energy each: <b>Strike</b> (one foe: hits, knockback, pin), <b>Slam</b> (every foe beside him) and <b>Throw</b> (roll his dice +2, then tap foes in order and the hammer flies through them, never the same foe twice in a row). Thunderforge pieces strengthen it with chain-lightning minion hits, more throw dice and harder throw crits. <b>Rune of Recall</b> lands in a burst that hits every foe beside him. <b>Rune of Turning</b> (20) is armed by default and fires by itself when a foe's blows are about to land hard on an ally: every die that hit is rerolled once.</p>
    <h3>Chasms</h3><p>A Slam can hurl you into a chasm: a fall costs 10% of your health and foes lose you. Climbing out is your action: d6 4+, with +1 for each failed try. Minions pushed into a chasm are gone; elites climb out hurt.</p>
    <h3>Waves and scenes</h3><p>Each scene comes from the Delvers' Ledger adventure planner: skirmishes, swarms, elite packs, gauntlets and bosses, sized to your gear when each act began. Reinforcements arrive at the end of later rounds. Clear every foe and the turns stop: walk freely, open the chests (gold beacons) and take the glowing spiral stair in the west wall; the buttons at the bottom walk you there. Between acts the Rakshasa buys your spare gear for Favour and sells boons and wares.</p>
    <h3>Foe abilities</h3>${foes}
    <h3>Keys</h3><p><kbd>A</kbd> attack · <kbd>S</kbd> sprint · <kbd>1</kbd>–<kbd>9</kbd> powers · <kbd>E</kbd>/<kbd>Enter</kbd> end round · <kbd>Tab</kbd> next hero · <kbd>I</kbd> gear (party gear for a party) · <kbd>C</kbd> centre · arrows or drag to pan · wheel to zoom · <kbd>Esc</kbd>/right-click cancels.</p>
    <h3>On a phone</h3><p>Tap a square or foe to select it: the path, any free blows and the foe's details show, with a button to confirm. Tap it again (or the button) to do it. Banked hits are spent with a single tap on a foe in reach. Drag to pan, pinch to zoom.</p>
    </div><div class="credits">Art: Kenney "Isometric Miniature Dungeon" (CC0) · heroes from the Flare game by Clint Bellanger and contributors (CC-BY-SA 3.0) · Flare-format monster renders from OpenGameArt: orcs, spiders and werebear by johndh and Wciow (CC-BY-SA 3.0), slime and demon by ryan.dansie (CC0 / CC-BY-SA 3.0) · Rakshasa portrait from Delvers' Ledger · cliffs, effects, dice and cards drawn in code.</div>`, { onClose: after });
  p.querySelector('.close').onclick = closeModal;
}
function menu() {
  const p = modal(`<button class="close">✕</button><h2>Menu</h2><div class="btnrow" style="justify-content:flex-start">
    <button id="mHelp">How to play</button><button id="mBug">🐞 Report a bug</button><button id="mForum">💬 Playtest forum</button><button id="mRetry">Restart this scene</button><button id="mTitle" class="danger">Abandon run</button></div>
    <p class="dim">Your run is saved in this browser after every action. Build ${esc(BUILD)}.</p>`, { narrow: true });
  p.querySelector('.close').onclick = closeModal;
  p.querySelector('#mHelp').onclick = () => help();
  p.querySelector('#mBug').onclick = () => forum({ kind: 'new', preset: 'bug' });
  p.querySelector('#mForum').onclick = () => forum({ kind: 'list' });
  p.querySelector('#mRetry').onclick = () => { $('#modal').hidden = true; R.retryScene(G, rng); G.fx = G.fx.filter(e => e.t !== 'spawn' && e.t !== 'log'); save(); enterScene(); };
  p.querySelector('#mTitle').onclick = () => { if (confirm('Abandon this run? Your party will be lost.')) { clearSave(); G = null; view.G = null; titleScreen(); } };
}

// expose for debugging and automated play-tests
window.__game = { get G() { return G; }, get view() { return view; }, get busy() { return busy; }, get mode() { return mode; }, R, act, rng: () => rng, camp, inventory, beginScene, enterScene, help, refresh, playFx };
boot();
