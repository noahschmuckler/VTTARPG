// Solo tactics rules: the Delvers' Ledger engine (classes, dice pools, gear, sets, foe abilities,
// the adventure planner, the Rakshasa) played out on an isometric grid by one hero.
// Pure state + functions. Every visible thing that happens is also pushed onto G.fx for the renderer.
import {
  CLASSES, ENEMY_TYPES, FOE_ABILITIES, HIDDEN_DICE, derive, powersFor, makeItem, randomRarity, landOn, fmt,
  setCounts, activeSynergies, SETS, SYNERGIES, CLASS_SETS, newCharacter, partyDamagePerRound, RARITY_ORDER, statsText, synergyText, SLOTS,
} from '../ledger/engine.js';
import { planScene, partyPower, flatIndex } from '../ledger/adventure.js';
import { CONSUMABLES, BOONS, SELL_VALUE, boonPrice, boonLocked } from '../ledger/merchant.js';
import { tile, dist, adjacent, standable, reachable, pathTo, pathToGoal, lineOfSight, dirFrom, key, stepCost, DIRS8, d6 } from './grid.js';
import { generateMap } from './mapgen.js';
import { SOLO_GATE, rosterFor } from './content.js';

export { CLASSES, FOE_ABILITIES, CONSUMABLES, BOONS, SELL_VALUE, SETS, SYNERGIES, fmt, derive, powersFor, statsText, synergyText, boonPrice, boonLocked, SLOTS };

// ------------------------------------------------------------------ tuning for one hero on a grid
export const SOLO = {
  minionBoost: 2.5,     // the planner sizes minions for a table; a solo grid wants more bodies (they die to one hit)
  waveGap: 2,           // later waves arrive at the end of round 1 + 2, 1 + 4, …
  breather: 0.35,       // heal this share of max health after each cleared scene
  elitePitShare: 0.3,   // an elite knocked into a chasm loses this share of its max health and climbs out
  throes: 300,
  threat: 0.8,         // big foes' damage per blow, against one hero who has no one to share the blows with
};
const REACH_TILES = r => (r ? r : 1); // the ledger's inches are squares here; 0 = adjacent

// ------------------------------------------------------------------ run setup
export function newRun(name, cls, rng) {
  const hero = newCharacter(name || CLASSES[cls]?.name || 'Hero', cls, rng);
  hero.favour = 2;
  hero.consumables = [{ id: 'w1', key: 'draught' }];
  hero.unlocked = [];
  const G = { v: 1, adv: SOLO_GATE, act: 0, scene: 0, hero, stage: 'scene', log: [], fx: [], stats: { rounds: 0, scenes: 0 } };
  G.anchor = anchorFor(G);
  return G;
}
// The act anchor: the hero's power when the act begins (foes in the act are sized from it).
function anchorFor(G) {
  const state = { order: ['h'], characters: { h: G.hero }, round: 1 };
  const p = partyPower(state, derive, partyDamagePerRound);
  return { ...p, kills: p.kills * SOLO.minionBoost };
}
export const sceneDef = G => G.adv.acts[G.act]?.scenes[G.scene];
export const isLastScene = G => G.act === G.adv.acts.length - 1 && G.scene === G.adv.acts[G.act].scenes.length - 1;
const sceneIndex = G => flatIndex(G.adv, G.act, G.scene);

export function startScene(G, rng) {
  const sc = sceneDef(G);
  G.map = generateMap(sc.arena, rng, { chests: sc.chests || 0 });
  G.pos = { ...G.map.start };
  G.foes = [];
  G.round = 1;
  G.strike = null;
  G.pit = null;
  G.hidden = null;
  G.zone = null;
  G.cleared = false;
  G.stage = 'scene';
  G.hero.buffs = {};
  G.hero.ward = 0;
  G.facing = 5;
  const plan = planScene(G.adv, G.act, G.scene, G.anchor);
  G.pressure = plan.pressure;
  G.waves = plan.waves.map(w => ({ due: w.at === 0 ? 0 : 1 + w.at * SOLO.waveGap, spawns: w.spawns }));
  G.checkpoint = JSON.stringify({ hero: G.hero, act: G.act, scene: G.scene, anchor: G.anchor, stats: G.stats });
  freshTurn(G);
  arriveWaves(G, rng, true);
  log(G, `${sc.name}. ${plan.template}, pressure ${plan.pressure}.`, 'scene');
  return G;
}
function freshTurn(G) {
  G.turn = { move: derive(G.hero).move, acted: null, ware: false };
}

// ------------------------------------------------------------------ queries used by the UI
export const heroStats = G => derive(G.hero);
export const living = G => G.foes.filter(f => !f.dead);
export const foeAt = (G, x, y) => G.foes.find(f => !f.dead && f.x === x && f.y === y);
export const occupied = (G, x, y, except) => (G.pos.x === x && G.pos.y === y && except !== 'hero') || G.foes.some(f => !f.dead && f !== except && f.x === x && f.y === y);
export const heroReach = G => REACH_TILES(heroStats(G).reach);
export const heroTile = G => tile(G.map, G.pos.x, G.pos.y);
export const canAct = G => G.stage === 'scene' && G.hero.hp > 0 && !G.pit && !G.turn.acted;
export const canAttack = G => G.stage === 'scene' && G.hero.hp > 0 && !G.pit && (!G.turn.acted || G.turn.acted === 'attackPower');

// Can `a` (at elevation ea) strike or shoot `b`? Melee: adjacent and at most one level apart. Ranged: in range with sight.
export function inReach(G, a, b, reach, fly = false) {
  const d = dist(a, b);
  if (d > reach || d === 0) return false;
  if (reach === 1) return fly || Math.abs((tile(G.map, a.x, a.y)?.e ?? 0) - (tile(G.map, b.x, b.y)?.e ?? 0)) <= 1;
  return lineOfSight(G.map, a, b);
}
export const foesInReach = G => living(G).filter(f => inReach(G, G.pos, f, heroReach(G)));

export function heroMoves(G) {
  if (G.pit || G.hero.hp <= 0 || G.stage !== 'scene') return new Map();
  return reachable(G.map, G.pos, G.turn.move, (x, y) => occupied(G, x, y, 'hero'));
}
// Foes that would get a free blow if the hero walked this path (leaving their side).
export function freeBlowsOn(G, path) {
  if (G.hidden) return [];
  const out = [];
  for (let i = 1; i < path.length; i++) {
    for (const f of living(G)) if (adjacent(f, path[i - 1]) && !adjacent(f, path[i]) && inReach(G, f, path[i - 1], 1, f.fly)) out.push({ f, at: i - 1 });
  }
  return out;
}

// ------------------------------------------------------------------ logging and effects
function log(G, text, kind = 'info') {
  G.log.unshift({ text, kind, round: G.round });
  if (G.log.length > 120) G.log.length = 120;
  G.fx.push({ t: 'log', text, kind });
}
const fx = (G, e) => G.fx.push(e);

function hurtHero(G, amount, { ignoreArmor = false, from = null, label = '' } = {}) {
  const ch = G.hero, s = derive(ch);
  const blocked = ignoreArmor ? 0 : Math.round(amount * s.armor / 100);
  let net = amount - blocked;
  const warded = Math.min(ch.ward || 0, net);
  ch.ward = (ch.ward || 0) - warded;
  net -= warded;
  ch.hp = Math.max(0, ch.hp - net);
  fx(G, { t: 'dmg', id: 'hero', n: net, warded, blocked, from: from?.id, label });
  if (ch.hp <= 0 && G.stage === 'scene') {
    G.stage = 'dead';
    fx(G, { t: 'die', id: 'hero' });
    log(G, `${ch.name} falls.`, 'hurt');
  }
  return net;
}
function gainEnergy(G, n) {
  const s = derive(G.hero), before = G.hero.energy;
  G.hero.energy = Math.max(0, Math.min(s.maxEnergy, G.hero.energy + n));
  return G.hero.energy - before;
}
function heal(G, pct) {
  const m = derive(G.hero).maxHp, before = G.hero.hp;
  G.hero.hp = Math.min(m, G.hero.hp + Math.round(m * pct / 100));
  if (G.hero.hp > before) fx(G, { t: 'heal', id: 'hero', n: G.hero.hp - before });
}
function ward(G, n) {
  G.hero.ward = (G.hero.ward || 0) + n;
  fx(G, { t: 'ward', id: 'hero', n });
}

// ------------------------------------------------------------------ foes
let foeSeq = 0;
function spawnFoe(G, sp, at, rng) {
  const T = ENEMY_TYPES[sp.etype] || ENEMY_TYPES.minion, R = rosterFor(sp.name);
  const big = sp.etype !== 'minion';
  const f = {
    id: `f${Date.now().toString(36)}${(foeSeq++).toString(36)}`, name: sp.name || T.label, type: sp.etype in ENEMY_TYPES ? sp.etype : 'minion',
    sprite: R.sprite, scale: R.scale * (sp.etype === 'boss' ? 1.15 : 1), move: R.move, reach: R.reach, fly: !!R.fly,
    hp: big ? sp.hp : T.hp, armor: big ? sp.armor : T.armor, damage: big ? Math.round(sp.damage * SOLO.threat / 10) * 10 : T.damage, attacks: big ? sp.attacks : T.attacks,
    abilities: big ? (sp.abilities || []).filter(k => FOE_ABILITIES[k]) : [], ability: sp.ability || '', x: at.x, y: at.y, facing: 1,
  };
  f.maxHp = f.hp;
  G.foes.push(f);
  fx(G, { t: 'spawn', id: f.id });
  return f;
}
// Nearest free standable square to p (breadth-first), optionally avoiding the hero's side.
function freeNear(G, p, avoidHero = false) {
  const seen = new Set([key(p.x, p.y)]), q = [p];
  while (q.length) {
    const c = q.shift(), t = tile(G.map, c.x, c.y);
    if (standable(t) && !occupied(G, c.x, c.y) && !(avoidHero && dist(c, G.pos) < 3)) return c;
    for (const [dx, dy] of DIRS8) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (!tile(G.map, n.x, n.y) || seen.has(key(n.x, n.y))) continue;
      seen.add(key(n.x, n.y));
      q.push(n);
    }
  }
  return null;
}
function arriveWaves(G, rng, first = false) {
  const due = G.waves.filter(w => w.due <= G.round && (first ? w.due === 0 : true));
  G.waves = G.waves.filter(w => !due.includes(w));
  let gate = Math.floor(rng() * G.map.spawns.length);
  for (const w of due) {
    const names = [];
    for (const sp of w.spawns) {
      for (let i = 0; i < sp.count; i++) {
        let at;
        if (sp.etype === 'boss') at = freeNear(G, { x: Math.floor(G.map.w / 2), y: 2 });
        else at = freeNear(G, G.map.spawns[gate++ % G.map.spawns.length], true);
        if (at) spawnFoe(G, sp, at, rng);
      }
      names.push(`${sp.count > 1 ? sp.count + ' ' : ''}${sp.name}${sp.count > 1 && sp.etype === 'minion' ? 's' : ''}`);
    }
    if (!first) { log(G, `Reinforcements: ${names.join(', ')}!`, 'spawn'); fx(G, { t: 'toast', title: 'Reinforcements', text: names.join(', ') }); }
  }
}
const foeHas = (f, k) => (f.abilities || []).includes(k);
function announce(G, f, k, extra = '') {
  const A = FOE_ABILITIES[k];
  fx(G, { t: 'ability', id: f.id, name: A.name, icon: A.icon, text: extra || A.text });
  log(G, `${A.icon} ${f.name}: ${A.name}! ${extra}`.trim(), 'hurt');
}
function foeDamaged(G, f, rng) {
  if (f.half || f.hp > f.maxHp / 2) return;
  f.half = true;
  if (foeHas(f, 'enrage')) { f.attacks += 1; f.damage = Math.round(f.damage * 1.5); f.enraged = true; announce(G, f, 'enrage'); }
  if (foeHas(f, 'stoneskin')) { f.armor = Math.min(90, f.armor + 20); announce(G, f, 'stoneskin'); }
  if (foeHas(f, 'horde')) {
    announce(G, f, 'horde');
    for (let i = 0; i < 2; i++) { const at = freeNear(G, G.pos); if (at) spawnFoe(G, minionSpawn(G), at, rng); }
  }
}
const minionSpawn = G => ({ etype: 'minion', name: sceneDef(G).minions?.[0] || 'Orc Grunt', count: 1 });

function killFoe(G, f, rng, how = '') {
  if (f.dead) return;
  f.dead = true;
  f.hp = 0;
  const s = derive(G.hero), ch = G.hero;
  const t = ch.tally ||= { minion: 0, elite: 0, boss: 0 };
  t[f.type] = (t[f.type] || 0) + 1;
  ch.kills = (ch.kills || 0) + 1;
  const e = gainEnergy(G, s.energyPerKill * (ENEMY_TYPES[f.type]?.energyMult || 1));
  fx(G, { t: 'die', id: f.id });
  if (f.type !== 'minion') log(G, `${f.name} falls${how}! (+${e} energy)`, 'kill');
  if (foeHas(f, 'throes')) {
    announce(G, f, 'throes');
    fx(G, { t: 'burst', at: { x: f.x, y: f.y }, kind: 'throes' });
    hurtHero(G, SOLO.throes, { from: f, label: 'Death Throes' });
  }
  if (f.type === 'elite') dropLoot(G, rng, 2, 'magic', `${f.name}'s hoard`);
  if (f.type === 'boss') dropLoot(G, rng, 4, 'rare', `${f.name}'s hoard`);
  checkCleared(G);
}
function checkCleared(G) {
  if (G.cleared || G.stage !== 'scene' || living(G).length || G.waves.length) return;
  G.cleared = true;
  G.strike = null;
  heal(G, SOLO.breather * 100);
  log(G, 'The scene is clear. The stair down is open (west wall).', 'scene');
  fx(G, { t: 'cleared' });
}
// A hit (or several) from the hero on a foe. Minions die to any hit.
function hitFoe(G, f, n, rng, { crit = false, mult = 1, label = '' } = {}) {
  if (f.dead) return 0;
  if (f.type === 'minion') { fx(G, { t: 'dmg', id: f.id, n: 1, crit, label }); killFoe(G, f, rng); return 1; }
  const s = derive(G.hero);
  const dmg = Math.round(n * s.damage * (crit && !foeHas(f, 'thickhide') ? s.critMult : 1) * mult * (1 - (f.armor || 0) / 100));
  f.hp = Math.max(0, f.hp - dmg);
  fx(G, { t: 'dmg', id: f.id, n: dmg, crit: crit && !foeHas(f, 'thickhide'), label });
  if (f.hp <= 0) killFoe(G, f, rng); else foeDamaged(G, f, rng);
  return dmg;
}

// ------------------------------------------------------------------ hero: moving
export function moveHero(G, x, y, rng) {
  if (G.stage !== 'scene' || G.pit) return err('You can\'t move now');
  const nodes = heroMoves(G), n = nodes.get(key(x, y));
  if (!n || n.cost === 0) return err('Out of reach');
  const path = pathTo(nodes, x, y);
  G.turn.move -= n.cost;
  // walk it one square at a time so free blows land where they happen
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1], to = path[i];
    const blows = G.hidden ? [] : living(G).filter(f => adjacent(f, from) && !adjacent(f, to) && inReach(G, f, from, 1, f.fly));
    G.pos = { ...to };
    fx(G, { t: 'move', id: 'hero', path: [from, to], kind: 'walk' });
    for (const f of blows) {
      freeBlow(G, f, rng);
      if (G.hero.hp <= 0) return ok();
    }
  }
  return ok();
}
function freeBlow(G, f, rng) {
  const s = derive(G.hero), r = d6(rng), lands = r <= landOn(s);
  fx(G, { t: 'anim', id: f.id, a: 'attack', face: G.pos });
  fx(G, { t: 'dice', who: f.name, label: 'Free blow', dice: [r], landOn: landOn(s), defense: true });
  if (lands) { log(G, `${f.name} lands a free blow as you break away.`, 'hurt'); hurtHero(G, f.damage, { from: f, label: 'Free blow' }); }
  else { fx(G, { t: 'text', id: 'hero', text: 'Dodged', color: '#cfd8e3' }); }
}
export function sprint(G) {
  if (!canAct(G)) return err('You have already acted');
  G.turn.acted = 'sprint';
  G.turn.move += derive(G.hero).move;
  log(G, `${G.hero.name} sprints.`);
  return ok();
}

// ------------------------------------------------------------------ hero: attacking
// Roll the dice pool; every 4+ is a hit against every foe in reach. Hits are spent by clicking foes.
export function highGround(G) {
  const e = heroTile(G).e;
  return foesInReach(G).some(f => tile(G.map, f.x, f.y).e < e) ? 1 : 0;
}
export function attackPool(G) {
  const s = derive(G.hero);
  return { base: s.pool, high: highGround(G), hidden: G.hidden ? HIDDEN_DICE : 0, total: s.pool + highGround(G) + (G.hidden ? HIDDEN_DICE : 0) };
}
export function attack(G, rng) {
  if (!canAttack(G)) return err('You have already acted this turn');
  if (G.strike && strikeLeft(G)) return err('Spend your remaining hits first');
  const s = derive(G.hero), P = attackPool(G);
  const dice = Array.from({ length: P.total }, () => d6(rng));
  const hits = dice.filter(d => d >= 4).length, sixes = dice.filter(d => d === 6).length;
  G.strike = { hits: hits - sixes, crits: sixes, minion: (G.strike?.minion || 0) + sixes * (s.cleave || 0), mult: G.hero.buffs.damageMult || 1 };
  const label = [G.hero.buffs.label, P.high && 'high ground', P.hidden && 'from hiding'].filter(Boolean).join(', ');
  G.hero.buffs = {};
  G.turn.acted = 'attack';
  if (G.hidden) { G.hidden = null; log(G, `${G.hero.name} strikes from hiding!`, 'hit'); }
  fx(G, { t: 'anim', id: 'hero', a: 'act' });
  fx(G, { t: 'dice', who: G.hero.name, label: label ? `Attack (${label})` : 'Attack', dice, hitOn: 4 });
  log(G, hits ? `${G.hero.name} rolls ${hits} hit${hits === 1 ? '' : 's'}${sixes ? ` (${sixes} crit${sixes > 1 ? 's' : ''})` : ''}.` : `${G.hero.name} rolls and misses.`, 'hit');
  if (!strikeLeft(G)) G.strike = null;
  return ok({ hits, sixes });
}
export const strikeLeft = G => (G.strike ? G.strike.hits + G.strike.crits + G.strike.minion : 0);
// Spend on a foe in reach: a minion takes one hit (minion-only hits first); a big foe takes every
// remaining hit, crits first, until it falls.
export function spend(G, foeId, rng) {
  const f = G.foes.find(x => x.id === foeId && !x.dead);
  const st = G.strike;
  if (!f || !st || !strikeLeft(G)) return err('No hits to spend');
  if (!inReach(G, G.pos, f, heroReach(G))) return err(`${f.name} is out of reach`);
  G.facing = null;
  fx(G, { t: 'face', id: 'hero', at: { x: f.x, y: f.y } });
  fx(G, { t: 'anim', id: 'hero', a: 'act' });
  if (heroReach(G) > 1) fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: G.hero.cls });
  if (f.type === 'minion') {
    if (st.minion) st.minion--; else if (st.hits) st.hits--; else st.crits--;
    hitFoe(G, f, 1, rng);
  } else {
    if (!st.hits && !st.crits) return err('Those hits only work on minions');
    while (!f.dead && (st.crits || st.hits)) {
      const crit = st.crits > 0;
      if (crit) st.crits--; else st.hits--;
      hitFoe(G, f, 1, rng, { crit, mult: st.mult });
    }
  }
  if (!strikeLeft(G)) G.strike = null;
  return ok();
}

// ------------------------------------------------------------------ hero: powers
// How each power targets on the grid. Solo adaptations of the table rules are noted.
const SPECS = {
  leap: { mode: 'tile', range: 4, up: 3, text: 'Pick a square within 4 (up to 3 levels higher).' },
  quake: { mode: 'self', radius: 2, text: 'Foes within 2 take a hit and are hurled 3 squares away.' },
  bulwark: { mode: 'self', radius: 3, text: 'Ward yourself; foes within 3 are dragged to your side.' },
  recall: { mode: 'foe', range: 10, sight: false, text: 'Solo: swap places with any foe within 10.' },
  circle: { mode: 'self', radius: 2, text: 'Ward and heal; foes can\'t step inside the circle this round.' },
  hammer: { mode: 'foe', range: 6, sight: true, text: 'Pick a foe within 6 in sight.' },
  grapple: { mode: 'tile', range: 8, sight: true, higher: true, text: 'Pick a higher square within 8 in sight.' },
  vanish: { mode: 'walk', range: 4, text: 'Pick a square up to 4 moves away; you vanish there.' },
  pin: { mode: 'foes', range: 12, sight: true, max: 2, text: 'Pick up to 2 foes within 12 in sight, then confirm.' },
  blink: { mode: 'tile', range: 6, any: true, text: 'Pick any square within 6, at any height.' },
  well: { mode: 'point', range: 8, sight: true, radius: 3, text: 'Pick a point within 8 in sight.' },
  meteor: { mode: 'point', range: 10, radius: 2, text: 'Pick a point within 10.' },
  step: { mode: 'foe', range: 6, sight: false, text: 'Pick a foe within 6: you appear behind it.' },
  smoke: { mode: 'self', text: 'Vanish into smoke.' },
};
export function powerSpec(G, p) {
  if (SPECS[p.key]) return SPECS[p.key];
  return { mode: 'self', text: p.text };
}
export const powerList = G => powersFor(G.hero);
export function powerUsable(G, p) {
  if (G.stage !== 'scene' || G.pit || G.hero.hp <= 0) return false;
  if (G.hero.energy < p.cost) return false;
  return !G.turn.acted;
}
// Valid targets for a power: squares (tile/walk/point modes) or foes.
export function powerTargets(G, p) {
  const S = powerSpec(G, p), here = G.pos, he = heroTile(G).e;
  const out = [];
  if (S.mode === 'tile' || S.mode === 'point') {
    for (let y = 0; y < G.map.h; y++) for (let x = 0; x < G.map.w; x++) {
      const t = tile(G.map, x, y), c = { x, y };
      const d = dist(here, c);
      if (d > S.range || (d === 0 && S.mode === 'tile')) continue;
      if (S.mode === 'tile' && (!standable(t) || occupied(G, x, y, 'hero'))) continue;
      if (S.mode === 'point' && t.kind !== 'floor') continue;
      if (S.up != null && t.e - he > S.up) continue;
      if (S.higher && t.e <= he) continue;
      if (S.sight && !lineOfSight(G.map, here, c)) continue;
      out.push(c);
    }
  } else if (S.mode === 'walk') {
    for (const n of reachable(G.map, here, S.range, (x, y) => occupied(G, x, y, 'hero')).values()) out.push({ x: n.x, y: n.y });
  } else if (S.mode === 'foe' || S.mode === 'foes') {
    for (const f of living(G)) if (dist(here, f) <= S.range && (!S.sight || lineOfSight(G.map, here, f))) out.push({ x: f.x, y: f.y, id: f.id });
  }
  return out;
}
// Use a power. target: { x, y } for squares and points, { ids: [...] } for foes; nothing for self.
export function usePower(G, keyName, target, rng) {
  const p = powerList(G).find(q => q.key === keyName);
  if (!p) return err('Unknown power');
  if (!powerUsable(G, p)) return err(G.hero.energy < p.cost ? 'Not enough energy' : 'You have already acted this turn');
  const S = powerSpec(G, p);
  const valid = powerTargets(G, p);
  let foes = [], at = null;
  if (S.mode === 'tile' || S.mode === 'point' || S.mode === 'walk') {
    if (!target || !valid.some(c => c.x === target.x && c.y === target.y)) return err('Not a valid target');
    at = { x: target.x, y: target.y };
  } else if (S.mode === 'foe' || S.mode === 'foes') {
    const ids = [...new Set(target?.ids || [])].slice(0, S.max || 1);
    foes = ids.map(id => G.foes.find(f => f.id === id && !f.dead)).filter(f => f && valid.some(c => c.id === f.id));
    if (!foes.length) return err('Pick a foe in range');
  }
  G.hero.energy -= p.cost;
  G.turn.acted = p.attack ? 'attackPower' : 'power';
  fx(G, { t: 'power', name: p.name, set: p.set || null, cls: G.hero.cls });
  fx(G, { t: 'anim', id: 'hero', a: 'act' });
  log(G, `${G.hero.name} uses ${p.name}.`, 'ability');
  const s = derive(G.hero);
  const effects = p.effects || [];
  const buff = (f) => {
    const b = G.hero.buffs;
    b.bonusDice = (b.bonusDice || 0) + (f.bonusDice || 0);
    b.damageMult = Math.max(b.damageMult || 1, f.damageMult || 1);
    b.label = p.name;
  };
  // positional class powers
  switch (keyName) {
    case 'leap': case 'grapple': case 'blink': {
      const from = { ...G.pos };
      G.pos = at;
      fx(G, { t: 'move', id: 'hero', path: [from, at], kind: keyName === 'blink' ? 'blink' : 'leap' });
      break;
    }
    case 'vanish': {
      const nodes = reachable(G.map, G.pos, S.range, (x, y) => occupied(G, x, y, 'hero'));
      const path = pathTo(nodes, at.x, at.y);
      G.pos = at;
      fx(G, { t: 'move', id: 'hero', path, kind: 'walk' });
      break;
    }
    case 'quake': {
      fx(G, { t: 'burst', at: { ...G.pos }, kind: 'quake', radius: S.radius });
      const caught = living(G).filter(f => dist(f, G.pos) <= S.radius).sort((a, b) => dist(b, G.pos) - dist(a, G.pos));
      for (const f of caught) {
        const slam = push(G, f, dirFrom(G.pos, f), 3, rng);
        if (!f.dead) hitFoe(G, f, 1 + (slam ? 1 : 0), rng, { label: slam ? 'Slammed' : '' });
      }
      break;
    }
    case 'bulwark': {
      for (const f of living(G).filter(f => dist(f, G.pos) <= S.radius && dist(f, G.pos) > 1)) {
        const spot = closestFree(G, G.pos, f, 1);
        if (spot) { const from = { x: f.x, y: f.y }; f.x = spot.x; f.y = spot.y; fx(G, { t: 'move', id: f.id, path: [from, spot], kind: 'pull' }); }
      }
      break;
    }
    case 'recall': {
      const f = foes[0], from = { ...G.pos };
      G.pos = { x: f.x, y: f.y };
      f.x = from.x; f.y = from.y;
      fx(G, { t: 'move', id: 'hero', path: [{ x: f.x, y: f.y }, G.pos], kind: 'blink' });
      fx(G, { t: 'move', id: f.id, path: [G.pos, from], kind: 'blink' });
      break;
    }
    case 'circle': G.zone = { x: G.pos.x, y: G.pos.y, r: S.radius, round: G.round }; fx(G, { t: 'burst', at: { ...G.pos }, kind: 'circle', radius: S.radius }); break;
    case 'hammer': {
      const f = foes[0];
      fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: 'hammer' });
      const slam = push(G, f, dirFrom(G.pos, f), 3, rng);
      if (!f.dead) { hitFoe(G, f, 2 + (slam ? 1 : 0), rng, { label: slam ? 'Slammed' : '' }); if (!f.dead) pinFoe(G, f); }
      break;
    }
    case 'pin': for (const f of foes) { fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: 'ranger' }); pinFoe(G, f); } break;
    case 'well': {
      fx(G, { t: 'burst', at, kind: 'well', radius: S.radius });
      for (const f of living(G).filter(f => dist(f, at) <= S.radius).sort((a, b) => dist(a, at) - dist(b, at))) {
        const spot = closestFree(G, at, f, 0);
        if (spot && dist(spot, at) < dist(f, at)) { const from = { x: f.x, y: f.y }; f.x = spot.x; f.y = spot.y; fx(G, { t: 'move', id: f.id, path: [from, spot], kind: 'pull' }); }
        pinFoe(G, f);
      }
      break;
    }
    case 'meteor': {
      fx(G, { t: 'burst', at, kind: 'meteor', radius: S.radius });
      for (const f of living(G).filter(f => dist(f, at) <= S.radius)) hitFoe(G, f, 2, rng);
      break;
    }
    case 'step': {
      const f = foes[0], d = dirFrom(G.pos, f);
      const behind = { x: f.x + d[0], y: f.y + d[1] };
      const spot = standable(tile(G.map, behind.x, behind.y)) && !occupied(G, behind.x, behind.y, 'hero') ? behind : closestFree(G, f, G.pos, 1);
      if (spot) { const from = { ...G.pos }; G.pos = spot; fx(G, { t: 'move', id: 'hero', path: [from, spot], kind: 'blink' }); fx(G, { t: 'face', id: 'hero', at: { x: f.x, y: f.y } }); }
      break;
    }
    case 'smoke': fx(G, { t: 'burst', at: { ...G.pos }, kind: 'smoke', radius: 1 }); break;
  }
  // the ledger's effect list (buffs, wards, heals, energy, minion-slaying hits, hiding)
  for (const f of effects) {
    if (f.kind === 'buff') buff(f);
    else if (f.kind === 'ward') ward(G, f.amount);
    else if (f.kind === 'heal') heal(G, f.pct);
    else if (f.kind === 'energize') gainEnergy(G, f.who === 'others' ? Math.round(f.amount * 0.5) : f.amount); // solo: no allies, half to yourself
    else if (f.kind === 'smite') smite(G, f.kills, rng);
    else if (f.kind === 'allyWard') { ward(G, f.amount); heal(G, f.heal || 0); }
    else if (f.kind === 'swap') ward(G, f.ward || 0);
    else if (f.kind === 'hide') { G.hidden = { until: G.round + 1 }; fx(G, { t: 'hide' }); log(G, `${G.hero.name} is hidden.`, 'ability'); }
  }
  checkCleared(G);
  return ok({ attack: p.attack });
}
function pinFoe(G, f) {
  if (f.dead) return;
  f.pinned = true;
  fx(G, { t: 'text', id: f.id, text: 'Pinned', color: '#e8c35a' });
}
// Minion-slaying hits: lightning leaps to the nearest minions in sight within 6; any left over join your pool.
function smite(G, kills, rng) {
  const targets = living(G).filter(f => f.type === 'minion' && dist(f, G.pos) <= 6 && lineOfSight(G.map, G.pos, f)).sort((a, b) => dist(a, G.pos) - dist(b, G.pos));
  let n = kills;
  for (const f of targets) {
    if (!n) break;
    fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: 'lightning' });
    hitFoe(G, f, 1, rng);
    n--;
  }
  if (n) { G.strike = G.strike || { hits: 0, crits: 0, minion: 0, mult: 1 }; G.strike.minion += n; }
}
// Closest free square to `goal` that is at most `near` from it (0 = as close as possible), reachable by sliding.
function closestFree(G, goal, unit, near) {
  let best = null, bd = Infinity;
  for (let y = goal.y - 4; y <= goal.y + 4; y++) for (let x = goal.x - 4; x <= goal.x + 4; x++) {
    const t = tile(G.map, x, y);
    if (!standable(t) || occupied(G, x, y, unit)) continue;
    if (x === G.pos.x && y === G.pos.y) continue;
    const d = dist({ x, y }, goal);
    if (near && d !== near) continue;
    const score = d * 10 + dist({ x, y }, unit);
    if (score < bd) { bd = score; best = { x, y }; }
  }
  return best;
}
// Shove a foe up to n squares. Returns true if it was slammed into something (wall, foe, ledge).
// Into a chasm: minions die, elites lose a share of health and claw back out, bosses stop at the edge.
function push(G, f, [dx, dy], n, rng) {
  const from = { x: f.x, y: f.y };
  let slam = false;
  for (let i = 0; i < n; i++) {
    const nx = f.x + dx, ny = f.y + dy, t = tile(G.map, nx, ny), cur = tile(G.map, f.x, f.y);
    if (t && t.kind === 'chasm') {
      if (f.type === 'boss') { slam = true; break; }
      fx(G, { t: 'move', id: f.id, path: [from, { x: nx, y: ny }], kind: 'push' });
      fx(G, { t: 'fall', id: f.id });
      if (f.type === 'minion') { f.x = nx; f.y = ny; log(G, `${f.name} tumbles into the chasm.`, 'kill'); killFoe(G, f, rng, ' into the chasm'); return false; }
      const spot = freeNear(G, { x: f.x, y: f.y });
      log(G, `${f.name} falls into the chasm and claws its way out.`, 'kill');
      f.hp = Math.max(1, f.hp - Math.round(f.maxHp * SOLO.elitePitShare));
      fx(G, { t: 'dmg', id: f.id, n: Math.round(f.maxHp * SOLO.elitePitShare), label: 'Fall' });
      foeDamaged(G, f, rng);
      if (spot) { f.x = spot.x; f.y = spot.y; fx(G, { t: 'move', id: f.id, path: [spot, spot], kind: 'blink' }); }
      f.pinned = true;
      return false;
    }
    if (!standable(t) || occupied(G, nx, ny, f) || t.e - cur.e > 0) { slam = true; break; }
    f.x = nx; f.y = ny;
  }
  if (f.x !== from.x || f.y !== from.y) fx(G, { t: 'move', id: f.id, path: [from, { x: f.x, y: f.y }], kind: 'push' });
  if (slam) fx(G, { t: 'text', id: f.id, text: 'Slammed!', color: '#ff9a5a' });
  return slam;
}

// ------------------------------------------------------------------ wares (one per turn, free)
export function useWare(G, wareId, rng) {
  const ch = G.hero, i = (ch.consumables || []).findIndex(w => w.id === wareId);
  if (i < 0) return err('No such ware');
  if (G.turn.ware) return err('One ware per turn');
  if (G.stage !== 'scene' || ch.hp <= 0) return err('Not now');
  const C = CONSUMABLES[ch.consumables[i].key], e = C.effect;
  ch.consumables.splice(i, 1);
  G.turn.ware = true;
  if (e.kind === 'heal') heal(G, e.pct);
  else if (e.kind === 'energy') gainEnergy(G, e.amount);
  else if (e.kind === 'ward') ward(G, e.amount);
  else if (e.kind === 'hide') { G.hidden = { until: G.round + 1 }; fx(G, { t: 'hide' }); }
  else if (e.kind === 'smite') smite(G, e.kills, rng);
  else if (e.kind === 'buff') { G.hero.buffs.bonusDice = (G.hero.buffs.bonusDice || 0) + e.bonusDice; G.hero.buffs.label = C.name; }
  fx(G, { t: 'power', name: C.name, ware: true });
  log(G, `${ch.name} uses ${C.name}.`, 'ability');
  checkCleared(G);
  return ok();
}

// ------------------------------------------------------------------ the chasm
export function climb(G, rng) {
  if (!G.pit) return err('You are not in the chasm');
  if (G.turn.acted) return err('Climbing takes your action');
  G.turn.acted = 'climb';
  const r = d6(rng), total = r + G.pit.tries;
  fx(G, { t: 'dice', who: G.hero.name, label: `Climb out (4+${G.pit.tries ? `, +${G.pit.tries}` : ''})`, dice: [r], hitOn: 4 - G.pit.tries });
  if (total >= 4) {
    const spot = edgeNear(G, G.pos);
    const from = { ...G.pos };
    G.pos = spot; G.pit = null;
    fx(G, { t: 'move', id: 'hero', path: [from, spot], kind: 'leap' });
    log(G, `${G.hero.name} climbs out of the chasm.`, 'ability');
  } else { G.pit.tries++; log(G, 'You slip back down. (+1 to the next try)', 'hurt'); }
  return ok();
}
function edgeNear(G, p) { return freeNear(G, p) || G.map.start; }
function fall(G) {
  const m = derive(G.hero).maxHp;
  G.pit = { tries: 0 };
  G.strike = null;
  fx(G, { t: 'fall', id: 'hero' });
  log(G, `🕳 ${G.hero.name} falls into the chasm!`, 'hurt');
  hurtHero(G, Math.round(m * 0.10), { ignoreArmor: true, label: 'Fall' });
}

// ------------------------------------------------------------------ chests and the exit
export function openChest(G, x, y, rng) {
  const c = G.map.chests.find(q => q.x === x && q.y === y);
  if (!c || c.opened) return err('Nothing to open');
  if (dist(c, G.pos) !== 1 || G.pit) return err('Stand next to the chest');
  c.opened = true;
  const t = tile(G.map, x, y);
  t.prop = { ...t.prop, k: 'chestOpen' };
  dropLoot(G, rng, 2, null, 'Chest');
  return ok();
}
export const exitOpen = G => G.cleared && G.stage === 'scene';
export function takeExit(G) {
  if (!exitOpen(G)) return err('Clear the scene first');
  if (dist(G.pos, G.map.exit) > 1) return err('Walk to the stair first');
  G.stats.scenes++;
  const last = G.scene === G.adv.acts[G.act].scenes.length - 1;
  if (isLastScene(G)) { G.stage = 'victory'; return ok({ victory: true }); }
  if (last) { G.act++; G.scene = 0; G.stage = 'camp'; heal(G, 100); G.camp = { open: true }; }
  else { G.scene++; G.stage = 'next'; }
  return ok();
}
export function leaveCamp(G) {
  G.anchor = anchorFor(G); // the new act is sized against the hero as they leave camp
  G.stage = 'next';
  G.camp = null;
}

// ------------------------------------------------------------------ loot
function lootLevel(G) { return 1 + 0.18 * sceneIndex(G); }
function rollRarity(G, rng, floor) {
  let r = randomRarity(rng);
  const bump = G.act * 0.12;
  if (rng() < bump) r = RARITY_ORDER[Math.min(RARITY_ORDER.indexOf(r) + 1, 3)];
  if (rng() < 0.18 + G.act * 0.06) r = 'set';
  if (floor && r !== 'set' && RARITY_ORDER.indexOf(r) < RARITY_ORDER.indexOf(floor)) r = floor;
  return r;
}
export function lootItem(G, rng, floor) {
  const r = rollRarity(G, rng, floor);
  const prefer = CLASS_SETS[G.hero.cls] || [];
  const setKey = r === 'set' && rng() < 0.65 ? prefer[Math.floor(rng() * prefer.length)] : undefined;
  return makeItem(r, rng, undefined, lootLevel(G), setKey);
}
function dropLoot(G, rng, n, floor, from) {
  const items = [];
  for (let i = 0; i < n; i++) items.push(lootItem(G, rng, i === 0 ? floor : null));
  G.hero.bag = G.hero.bag || [];
  G.hero.bag.push(...items);
  fx(G, { t: 'loot', from, items });
  log(G, `${from}: ${items.map(i => i.name).join(', ')}.`, 'loot');
}

// Equip from the satchel (swapping out whatever was in the slot). Announces newly unlocked set powers and synergies.
export function unlockKeys(ch) {
  const counts = setCounts(ch), keys = [];
  for (const [k, n] of Object.entries(counts)) for (let i = 1; i <= n; i++) keys.push(`set:${k}:${i}`);
  for (const sy of activeSynergies(ch, counts)) keys.push(`syn:${sy.key}`);
  return keys;
}
export function equip(G, itemId) {
  const ch = G.hero, i = (ch.bag || []).findIndex(it => it.id === itemId);
  if (i < 0) return err('Not in your satchel');
  if (G.stage === 'scene' && G.turn.acted && !G.cleared && living(G).length) { /* gear changes are free, like the table */ }
  const it = ch.bag.splice(i, 1)[0];
  const old = ch.gear[it.slot];
  ch.gear[it.slot] = it;
  if (old) ch.bag.push(old);
  clamp(G);
  announceUnlocks(G);
  return ok();
}
export function unequip(G, slot) {
  const ch = G.hero, it = ch.gear[slot];
  if (!it) return err('Nothing there');
  delete ch.gear[slot];
  ch.bag.push(it);
  clamp(G);
  return ok();
}
export function discard(G, itemId) {
  const ch = G.hero, i = (ch.bag || []).findIndex(it => it.id === itemId);
  if (i < 0) return err('Not in your satchel');
  ch.bag.splice(i, 1);
  return ok();
}
function clamp(G) {
  const s = derive(G.hero);
  G.hero.hp = Math.min(G.hero.hp, s.maxHp);
  G.hero.energy = Math.min(G.hero.energy, s.maxEnergy);
}
function announceUnlocks(G) {
  const ch = G.hero, known = new Set(ch.unlocked || []);
  for (const k of unlockKeys(ch)) {
    if (known.has(k)) continue;
    known.add(k);
    const [kind, id, n] = k.split(':');
    if (kind === 'syn') {
      const sy = SYNERGIES.find(x => x.key === id);
      fx(G, { t: 'unlock', kind: 'synergy', title: `Hidden synergy: ${sy.name}`, text: synergyText(sy) });
      log(G, `✦ Hidden synergy discovered: ${sy.name}.`, 'loot');
    } else {
      const S = SETS[id], bonus = S.bonuses.find(b => b.n === Number(n));
      const pw = powersFor(ch).find(p => p.key === S.power.key);
      const text = Number(n) === 1 ? `New power: ${S.power.name}. ${pw?.text || ''}` : `${S.power.name} grows stronger (${n} pieces).${bonus ? ' ' + statsText(bonus.stats) + '.' : ''}`;
      fx(G, { t: 'unlock', kind: 'set', set: id, title: Number(n) === 1 ? S.power.name : `${S.name} ×${n}`, text });
    }
  }
  ch.unlocked = [...known];
}
export function compareItem(G, it) {
  const old = G.hero.gear[it.slot];
  const keys = new Set([...Object.keys(it.stats), ...Object.keys(old?.stats || {})]);
  return [...keys].map(k => ({ k, now: old?.stats[k] || 0, then: it.stats[k] || 0 }));
}

// ------------------------------------------------------------------ the Rakshasa (camp between acts)
export function sell(G, itemId) {
  const ch = G.hero, i = (ch.bag || []).findIndex(it => it.id === itemId);
  if (i < 0) return err('Not in your satchel');
  const it = ch.bag.splice(i, 1)[0];
  const v = SELL_VALUE[it.rarity] || 1;
  ch.favour = (ch.favour || 0) + v;
  return ok({ favour: v, rarity: it.rarity });
}
export function buyBoon(G, k) {
  const ch = G.hero, B = BOONS[k];
  if (!B) return err('No such boon');
  if (boonLocked(ch, k)) return err('Only once');
  const price = boonPrice(ch, k);
  if ((ch.favour || 0) < price) return err('Not enough Favour');
  ch.favour -= price;
  ch.boons = ch.boons || {};
  for (const [s, v] of Object.entries(B.stats)) ch.boons[s] = (ch.boons[s] || 0) + v;
  ch.boonBuys = { ...(ch.boonBuys || {}), [k]: ((ch.boonBuys || {})[k] || 0) + 1 };
  if (B.stats.maxHp) ch.hp += B.stats.maxHp;
  return ok();
}
export function buyWare(G, k) {
  const ch = G.hero, C = CONSUMABLES[k];
  if (!C) return err('No such ware');
  if ((ch.favour || 0) < C.cost) return err('Not enough Favour');
  ch.favour -= C.cost;
  ch.consumables = ch.consumables || [];
  ch.consumables.push({ id: 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), key: k });
  return ok();
}

// ------------------------------------------------------------------ the enemy phase and End round
export function endTurn(G, rng) {
  if (G.stage !== 'scene') return err('Not now');
  G.strike = null;
  fx(G, { t: 'phase', name: 'Enemy phase' });
  enemyPhase(G, rng);
  if (G.stage !== 'scene') return ok();
  endRound(G, rng);
  return ok();
}
function enemyPhase(G, rng) {
  const order = living(G).sort((a, b) => dist(a, G.pos) - dist(b, G.pos));
  for (const f of order) {
    if (f.dead || G.stage !== 'scene') continue;
    if (G.pit || G.hidden) { if (!f.pinned) wander(G, f, rng); continue; }
    if (!inReach(G, f, G.pos, f.reach, f.fly) && !f.pinned) approach(G, f);
    if (inReach(G, f, G.pos, f.reach, f.fly)) foeAttack(G, f, rng);
  }
}
const inZone = (G, x, y) => G.zone && G.zone.round === G.round && dist({ x, y }, G.zone) <= G.zone.r;
function approach(G, f) {
  const occ = (x, y) => occupied(G, x, y, f);
  const goal = (x, y) => inReach(G, { x, y }, G.pos, f.reach, f.fly) && !inZone(G, x, y);
  const opts = { forbid: (x, y) => inZone(G, x, y) && !inZone(G, f.x, f.y) };
  let path = pathToGoal(G.map, f, goal, occ, opts);
  if (!path) { // nowhere in reach is free: just close the distance
    const nodes = reachable(G.map, f, f.move, occ, opts);
    let best = null;
    for (const n of nodes.values()) if (!best || dist(n, G.pos) < dist(best, G.pos)) best = n;
    path = best ? pathTo(nodes, best.x, best.y) : null;
  }
  if (!path || path.length < 2) return;
  // walk as far as the foe's move allows
  let budget = f.move, i = 1;
  for (; i < path.length; i++) {
    const c = stepCost(G.map, path[i - 1], path[i], occ, opts);
    if (c > budget) break;
    budget -= c;
  }
  const walk = path.slice(0, i);
  if (walk.length < 2) return;
  const end = walk[walk.length - 1];
  f.x = end.x; f.y = end.y;
  fx(G, { t: 'move', id: f.id, path: walk, kind: 'walk' });
}
function wander(G, f, rng) {
  const nodes = [...reachable(G.map, f, 2, (x, y) => occupied(G, x, y, f)).values()];
  const n = nodes[Math.floor(rng() * nodes.length)];
  if (!n || (n.x === f.x && n.y === f.y)) return;
  const path = pathTo(new Map(nodes.map(q => [key(q.x, q.y), q])), n.x, n.y);
  f.x = n.x; f.y = n.y;
  fx(G, { t: 'move', id: f.id, path, kind: 'walk' });
}
// One die per attack; every die at or under the hero's landOn (3, or 2 in heavy armour) is a blow.
// +1 die when the hero is surrounded (3+ foes beside them) or the attacker stands higher.
export function foeAttackDice(G, f) {
  const s = derive(G.hero);
  const surrounded = living(G).filter(o => adjacent(o, G.pos)).length >= 3 ? 1 : 0;
  const higher = tile(G.map, f.x, f.y).e > heroTile(G).e ? 1 : 0;
  const sweep = foeHas(f, 'sweep') ? 1 : 0; // solo: Sweeping Blows has one hero to sweep, so it swings once more
  return { n: f.attacks + surrounded + higher + sweep, landOn: landOn(s), surrounded, higher };
}
function foeAttack(G, f, rng) {
  const D = foeAttackDice(G, f);
  const dice = Array.from({ length: D.n }, () => d6(rng));
  const landed = dice.filter(d => d <= D.landOn).length;
  fx(G, { t: 'face', id: f.id, at: { ...G.pos } });
  fx(G, { t: 'anim', id: f.id, a: 'attack', face: G.pos });
  if (f.reach > 1) fx(G, { t: 'bolt', from: { x: f.x, y: f.y }, to: { ...G.pos }, cls: 'arrow' });
  fx(G, { t: 'dice', who: f.name, label: `${f.name} attacks${D.surrounded ? ' (surrounded)' : ''}${D.higher ? ' (from above)' : ''}`, dice, landOn: D.landOn, defense: true });
  if (landed) hurtHero(G, landed * f.damage, { from: f, label: `${landed} blow${landed > 1 ? 's' : ''}` });
  else fx(G, { t: 'text', id: 'hero', text: 'Blocked', color: '#cfd8e3' });
  if (G.stage !== 'scene') return;
  if (foeHas(f, 'leech')) {
    const lost = -gainEnergy(G, -10);
    if (lost) announce(G, f, 'leech', `You lose ${lost} energy.`);
  }
  if (foeHas(f, 'slam') && landed) hurl(G, f, rng);
}
// Slam: the hero is hurled 3 squares straight away from the foe.
function hurl(G, f, rng) {
  announce(G, f, 'slam', 'You are hurled 3 squares!');
  const [dx, dy] = dirFrom(f, G.pos), from = { ...G.pos };
  let slammed = false;
  for (let i = 0; i < 3; i++) {
    const nx = G.pos.x + dx, ny = G.pos.y + dy, t = tile(G.map, nx, ny), cur = heroTile(G);
    if (t && t.kind === 'chasm') {
      G.pos = { x: nx, y: ny };
      fx(G, { t: 'move', id: 'hero', path: [from, G.pos], kind: 'push' });
      fall(G);
      return;
    }
    if (!standable(t) || occupied(G, nx, ny, 'hero') || t.e - cur.e > 0) { slammed = true; break; }
    G.pos = { x: nx, y: ny };
  }
  if (G.pos.x !== from.x || G.pos.y !== from.y) fx(G, { t: 'move', id: 'hero', path: [from, { ...G.pos }], kind: 'push' });
  if (slammed) hurtHero(G, f.damage, { from: f, label: 'Slammed' });
}
function endRound(G, rng) {
  for (const f of living(G)) {
    f.pinned = false;
    if (foeHas(f, 'regen') && f.hp < f.maxHp) {
      const n = Math.min(f.maxHp - f.hp, Math.round(f.maxHp * 0.05));
      f.hp += n;
      fx(G, { t: 'heal', id: f.id, n });
    }
    if (foeHas(f, 'summoner')) {
      announce(G, f, 'summoner');
      for (let i = 0; i < 2; i++) { const at = freeNear(G, f); if (at) spawnFoe(G, minionSpawn(G), at, rng); }
    }
  }
  if (G.hidden && G.hidden.until <= G.round) { G.hidden = null; fx(G, { t: 'text', id: 'hero', text: 'Revealed', color: '#b88cff' }); }
  G.zone = null;
  G.round++;
  G.stats.rounds++;
  arriveWaves(G, rng);
  const e = gainEnergy(G, derive(G.hero).energyPerRound);
  freshTurn(G);
  fx(G, { t: 'phase', name: `Round ${G.round}`, energy: e });
  checkCleared(G);
}

// ------------------------------------------------------------------ retry
export function retryScene(G, rng) {
  const cp = JSON.parse(G.checkpoint);
  Object.assign(G, { hero: cp.hero, act: cp.act, scene: cp.scene, anchor: cp.anchor, stats: cp.stats });
  G.hero.hp = derive(G.hero).maxHp;
  G.hero.energy = Math.max(G.hero.energy, 30);
  G.log = [];
  return startScene(G, rng);
}

const ok = (r = {}) => ({ ok: true, ...r });
const err = error => ({ ok: false, error });
