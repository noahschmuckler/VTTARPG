// Party tactics rules: the Delvers' Ledger engine (classes, dice pools, gear, sets, foe abilities,
// the adventure planner, the Rakshasa) played out on an isometric grid by a party of 1–4 heroes, one player.
// Pure state + functions. Every visible thing that happens is also pushed onto G.fx for the renderer.
//
// G.party holds the heroes; G.active is the one being controlled. G.hero, G.pos, G.turn, G.strike, G.pit and
// G.hidden are accessors onto the active hero (bindParty), so most rules read as if for one hero; anything that
// acts on another hero (foes attacking, party heals) runs inside withHero().
import {
  CLASSES, ENEMY_TYPES, FOE_ABILITIES, HIDDEN_DICE, derive, powersFor, FOE_CRIT, hitOn, armorCut, ARMOR_BREAK, makeItem, randomRarity, landOn, fmt,
  setCounts, activeSynergies, SETS, SYNERGIES, CLASS_SETS, newCharacter, partyDamagePerRound, RARITY_ORDER, statsText, synergyText, SLOTS,
} from '../ledger/engine.js';
import { planScene, partyPower, flatIndex } from '../ledger/adventure.js';
import { CONSUMABLES, BOONS, SELL_VALUE, boonPrice, boonLocked } from '../ledger/merchant.js';
import { tile, dist, adjacent, standable, reachable, pathTo, pathToGoal, lineOfSight, dirFrom, key, stepCost, DIRS8, d6 } from './grid.js';
import { generateMap } from './mapgen.js';
import { SOLO_GATE, rosterFor } from './content.js';

export { CLASSES, FOE_ABILITIES, CONSUMABLES, BOONS, SELL_VALUE, SETS, SYNERGIES, fmt, derive, powersFor, statsText, synergyText, boonPrice, boonLocked, SLOTS };

// ------------------------------------------------------------------ tuning for a small party on a grid
export const SOLO = {
  minionBoost: 2.5,     // the planner sizes minions for a table; a lone hero on a grid wants more bodies (they die to one hit)
  partyBoost: 2.0,      // the same, for a party of 2+
  waveGap: 2,           // later waves arrive at the end of round 1 + 2, 1 + 4, …
  breather: 0.35,       // heal this share of max health after each cleared scene
  elitePitShare: 0.3,   // an elite knocked into a chasm loses this share of its max health and climbs out
  throes: 300,
  threat: 0.42,        // big foes' damage per blow against a lone hero, who has no one to share the blows with
  partyThreat: 0.72,    // … and against a party
  revive: 0.25,         // heroes downed in a scene get up with this share of health once it is clear
  maxParty: 4,
};
// Rules from the tabletop playtest of 2026-11-15 (mirrored from Delvers' Ledger; see help() for the player text).
export const ARMOUR = { pierce: 0.5, sunder: ARMOR_BREAK };     // crits halve the rating; Armour-breaker ignores 20 more
export const armourCut = rating => armorCut(Math.max(0, rating)); // the ledger's curve: 100 armour halves damage; never immune
export const ENERGY = { surge: 60, regenTaper: [15, 15], drown: 25, chill: 10, killTaper: [1, 0.5, 0.5, 0.25] };
export const REACTIONS = {
  turning: { name: 'Rune of Turning', cost: 20, text: 'When a foe\'s blows are about to land hard on an ally, they reroll every foe die that hit, once. Fires by itself while armed.' },
  mending: { name: 'Rune of Mending', cost: 25, text: 'Heal an ally below a third of their max health by 15% of their max health.' },
  haste: { name: 'Rune of Haste', cost: 30, text: 'The ally\'s next attack rolls +1 die.' },
};
// A hero's Energy per Round. The ledger's derive() already applies the gear taper (first +15 in full, next +15 half,
// the rest a quarter, on everything above the class base); the half-regen-at-half-energy rule is in endRound.
export const energyPerRound = h => derive(h).energyPerRound;
export const DEFAULT_NAMES = { ironclad: 'Brannoc', runepriest: 'Hild', ranger: 'Tess', arcanist: 'Orrin', shadowblade: 'Vex' };
const REACH_TILES = r => (r ? r : 1); // the ledger's inches are squares here; 0 = adjacent

// ------------------------------------------------------------------ run setup
// members: [{ name, cls }, …] (1–4). The old solo form newRun(name, cls, rng) still works.
export function newRun(members, cls, rng) {
  if (typeof members === 'string' || !Array.isArray(members)) members = [{ name: members, cls }];
  else rng = cls;
  members = members.slice(0, SOLO.maxParty);
  const party = members.map((m, i) => {
    const h = newCharacter(m.name || DEFAULT_NAMES[m.cls] || CLASSES[m.cls]?.name || 'Hero', m.cls, rng);
    Object.assign(h, { hid: `h${i}`, unlocked: [], pos: null, turn: null, strike: null, pit: null, hidden: null });
    return h;
  });
  const G = { v: 2, adv: SOLO_GATE, act: 0, scene: 0, party, active: 0, bag: [], favour: 2, wares: party.map((h, i) => ({ id: `w${i}`, key: 'draught' })), stage: 'scene', log: [], fx: [], stats: { rounds: 0, scenes: 0 } };
  bindParty(G);
  G.anchor = anchorFor(G);
  return G;
}
// Accessors onto the active hero. Not enumerable, so saves (JSON) hold only G.party; call again after loading.
export function bindParty(G) {
  const on = k => ({ get() { return G.party[G.active]?.[k]; }, set(v) { G.party[G.active][k] = v; }, configurable: true, enumerable: false });
  Object.defineProperty(G, 'hero', { get() { return G.party[G.active]; }, configurable: true, enumerable: false });
  for (const k of ['pos', 'turn', 'strike', 'pit', 'hidden']) Object.defineProperty(G, k, on(k));
  return G;
}
// Run fn with hero h as the active one (foes attacking, party-wide effects), then switch back.
function withHero(G, h, fn) {
  const was = G.active, i = G.party.indexOf(h);
  if (i < 0) return undefined;
  G.active = i;
  try { return fn(); } finally { G.active = was; }
}
export const standing = G => G.party.filter(h => h.hp > 0);
export const heroAt = (G, x, y) => G.party.find(h => h.hp > 0 && h.pos && h.pos.x === x && h.pos.y === y);
export function selectHero(G, i) {
  if (!G.party[i]) return err('No such hero');
  G.active = i;
  return ok();
}
// The act anchor: the party's power when the act begins (foes in the act are sized from it).
function anchorFor(G) {
  const state = { order: G.party.map(h => h.hid), characters: Object.fromEntries(G.party.map(h => [h.hid, h])), round: 1 };
  const p = partyPower(state, derive, partyDamagePerRound);
  return { ...p, kills: p.kills * (G.party.length > 1 ? SOLO.partyBoost : SOLO.minionBoost) };
}
export const sceneDef = G => G.adv.acts[G.act]?.scenes[G.scene];
export const isLastScene = G => G.act === G.adv.acts.length - 1 && G.scene === G.adv.acts[G.act].scenes.length - 1;
const sceneIndex = G => flatIndex(G.adv, G.act, G.scene);

export function startScene(G, rng) {
  const sc = sceneDef(G);
  G.map = generateMap(sc.arena, rng, { chests: sc.chests || 0 });
  G.foes = [];
  G.round = 1;
  G.zone = null;
  G.cleared = false;
  G.stage = 'scene';
  G.active = 0;
  for (const h of G.party) {
    Object.assign(h, { pos: null, strike: null, pit: null, hidden: null, buffs: {}, ward: 0, rune: 0, minionKills: 0 });
    if (h.hp <= 0) h.hp = Math.round(derive(h).maxHp * SOLO.revive);
    h.downed = false;
  }
  // the party enters together, a square apart so each hero is easy to pick out
  const offs = [[0, 0], [-2, 0], [0, -2], [-2, -2]];
  G.party.forEach((h, i) => { const [dx, dy] = offs[i % 4]; h.pos = freeNear(G, { x: G.map.start.x + dx, y: G.map.start.y + dy }) || freeNear(G, G.map.start) || { ...G.map.start }; });
  const plan = planScene(G.adv, G.act, G.scene, G.anchor);
  G.pressure = plan.pressure;
  G.waves = plan.waves.map(w => ({ due: w.at === 0 ? 0 : 1 + w.at * SOLO.waveGap, spawns: w.spawns }));
  G.checkpoint = JSON.stringify({ party: G.party, bag: G.bag, favour: G.favour, wares: G.wares, act: G.act, scene: G.scene, anchor: G.anchor, stats: G.stats });
  for (const h of G.party) h.turn = freshTurnFor(h);
  arriveWaves(G, rng, true);
  log(G, `${sc.name}. ${plan.template}, pressure ${plan.pressure}.`, 'scene');
  return G;
}
const freshTurnFor = h => ({ move: derive(h).move, acted: null, ware: false });

// ------------------------------------------------------------------ queries used by the UI
export const heroStats = G => derive(G.hero);
export const living = G => G.foes.filter(f => !f.dead);
export const foeAt = (G, x, y) => G.foes.find(f => !f.dead && f.x === x && f.y === y);
// except: 'hero' (the active hero), a hero object, or a foe object, which doesn't count as blocking.
export const occupied = (G, x, y, except) => {
  const skip = except === 'hero' ? G.hero : except;
  return G.party.some(h => h !== skip && h.hp > 0 && h.pos && !h.pit && h.pos.x === x && h.pos.y === y) || G.foes.some(f => !f.dead && f !== skip && f.x === x && f.y === y);
};
export const heroReach = G => REACH_TILES(heroStats(G).reach);
export const heroTile = G => tile(G.map, G.pos.x, G.pos.y);
export const canAct = G => G.stage === 'scene' && G.hero.hp > 0 && !G.pit && !G.turn.acted;
export const heroDone = (G, h) => h.hp <= 0 || (h.turn?.acted && h.turn.acted !== 'attackPower' && !(h.strike && (h.strike.hits + h.strike.crits + h.strike.minion)) && !h.turn.move);
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
  // once the scene is clear there are no turns: walk anywhere
  return reachable(G.map, G.pos, G.cleared ? 999 : G.turn.move, (x, y) => occupied(G, x, y, 'hero'));
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

// Damage to the active hero: armour (a rating) cuts it first, then the rune ward soaks, then the normal ward.
// crit: the blow pierces half the armour; sunder: Armour-breaker ignores 20 more (after the pierce).
function hurtHero(G, amount, { ignoreArmor = false, from = null, label = '', crit = false, sunder = false } = {}) {
  const ch = G.hero, s = derive(ch);
  let rating = s.armor;
  if (crit) rating *= ARMOUR.pierce;
  if (sunder) rating = Math.max(0, rating - ARMOUR.sunder);
  const blocked = ignoreArmor ? 0 : Math.round(amount * armourCut(rating));
  let net = amount - blocked;
  const runed = Math.min(ch.rune || 0, net);
  ch.rune = (ch.rune || 0) - runed;
  net -= runed;
  const warded = Math.min(ch.ward || 0, net);
  ch.ward = (ch.ward || 0) - warded;
  net -= warded;
  ch.hp = Math.max(0, ch.hp - net);
  fx(G, { t: 'dmg', id: G.hero.hid, n: net, warded: warded + runed, normal: warded, rune: runed, blocked, crit, from: from?.id, label });
  if (ch.hp <= 0 && G.stage === 'scene' && !ch.downed) {
    ch.downed = true; ch.strike = null; ch.pit = null; ch.hidden = null; ch.buffs = {};
    fx(G, { t: 'die', id: G.hero.hid });
    log(G, `${ch.name} is down!`, 'hurt');
    if (!standing(G).length) { G.stage = 'dead'; log(G, 'The whole party has fallen.', 'hurt'); }
  }
  return net;
}
function gainEnergy(G, n, quiet = false) {
  const s = derive(G.hero), before = G.hero.energy;
  G.hero.energy = Math.max(0, Math.min(s.maxEnergy, G.hero.energy + n));
  const d = G.hero.energy - before;
  if (d) fx(G, { t: 'energy', id: G.hero.hid, n: d, quiet }); // the HUD and a floating "+7 ⚡" follow it
  return d;
}
function heal(G, pct) {
  const m = derive(G.hero).maxHp, before = G.hero.hp;
  G.hero.hp = Math.min(m, G.hero.hp + Math.round(m * pct / 100));
  if (G.hero.hp > before) fx(G, { t: 'heal', id: G.hero.hid, n: G.hero.hp - before });
}
// Party effects: on every standing hero (who = 'party') or every other standing hero ('others').
function eachHero(G, who, fn) {
  const me = G.hero;
  const list = who === 'party' ? standing(G) : who === 'others' ? standing(G).filter(h => h !== me) : [me];
  for (const h of list) withHero(G, h, fn);
}
// Two ward layers that never add up: a new ward only replaces the old one in its layer if it is bigger.
// Rune wards come only from the Runepriest's own powers (Warding Circle, Rune of Recall).
function ward(G, n, rune = false) {
  const k = rune ? 'rune' : 'ward', before = G.hero[k] || 0;
  G.hero[k] = Math.max(before, n);
  fx(G, { t: 'ward', id: G.hero.hid, n: G.hero[k] - before, rune, held: G.hero[k] === before });
}

// ------------------------------------------------------------------ foes
let foeSeq = 0;
function spawnFoe(G, sp, at, rng) {
  const T = ENEMY_TYPES[sp.etype] || ENEMY_TYPES.minion, R = rosterFor(sp.name);
  const big = sp.etype !== 'minion';
  const f = {
    id: `f${Date.now().toString(36)}${(foeSeq++).toString(36)}`, name: sp.name || T.label, type: sp.etype in ENEMY_TYPES ? sp.etype : 'minion',
    sprite: R.sprite, scale: R.scale * (sp.etype === 'boss' ? 1.15 : 1), move: R.move, reach: R.reach, fly: !!R.fly,
    hp: big ? sp.hp : T.hp, armor: big ? sp.armor : T.armor, damage: big ? Math.round(sp.damage * (G.party.length > 1 ? SOLO.partyThreat : SOLO.threat) / 10) * 10 : T.damage, attacks: big ? sp.attacks : T.attacks,
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
    if (standable(t) && !occupied(G, c.x, c.y) && !(avoidHero && standing(G).some(h => h.pos && dist(c, h.pos) < 3))) return c;
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
  // minion kills taper within a round (full, half, half, then a quarter); elite and boss kills always pay in full
  let pay = s.energyPerKill * (ENEMY_TYPES[f.type]?.energyMult || 1);
  if (f.type === 'minion') { const k = ch.minionKills = (ch.minionKills || 0) + 1; pay = Math.floor(pay * ENERGY.killTaper[Math.min(k, 4) - 1]); }
  const e = gainEnergy(G, pay);
  fx(G, { t: 'die', id: f.id });
  if (f.type !== 'minion') log(G, `${f.name} falls${how}! (+${e} energy)`, 'kill');
  if (foeHas(f, 'throes')) {
    announce(G, f, 'throes');
    fx(G, { t: 'burst', at: { x: f.x, y: f.y }, kind: 'throes' });
    for (const h of standing(G)) withHero(G, h, () => hurtHero(G, SOLO.throes, { from: f, label: 'Death Throes' }));
  }
  if (f.type === 'elite') dropLoot(G, rng, 2, 'magic', `${f.name}'s hoard`);
  if (f.type === 'boss') dropLoot(G, rng, 4, 'rare', `${f.name}'s hoard`);
  checkCleared(G);
}
function checkCleared(G) {
  if (G.cleared || G.stage !== 'scene' || living(G).length || G.waves.length) return;
  G.cleared = true;
  for (const h of G.party) {
    h.strike = null;
    if (h.hp <= 0) {
      h.hp = Math.round(derive(h).maxHp * SOLO.revive); h.downed = false;
      if (h.pit) h.pit = null;
      h.pos = freeNear(G, h.pos || G.map.start) || h.pos;
      fx(G, { t: 'revive', id: h.hid });
      log(G, `${h.name} gets back up.`, 'scene');
    } else withHero(G, h, () => heal(G, SOLO.breather * 100));
  }
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
  if (G.hero.cls === 'runepriest' && dmg > 0 && !f.brand) { f.brand = G.hero.hid; fx(G, { t: 'text', id: f.id, text: 'Branded', color: '#5fd3c4' }); }
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
  if (!G.cleared) G.turn.move -= n.cost;
  // walk it one square at a time so free blows land where they happen
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1], to = path[i];
    const blows = G.hidden ? [] : living(G).filter(f => adjacent(f, from) && !adjacent(f, to) && inReach(G, f, from, 1, f.fly));
    G.pos = { ...to };
    fx(G, { t: 'move', id: G.hero.hid, path: [from, to], kind: 'walk' });
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
  if (lands) { log(G, `${f.name} lands a free blow as ${G.hero.name} breaks away.`, 'hurt'); hurtHero(G, f.damage, { from: f, label: 'Free blow' }); }
  else { fx(G, { t: 'text', id: G.hero.hid, text: 'Dodged', color: '#cfd8e3' }); }
}
// Surge: once per round, a hero who has used their action may spend 60 energy to act again.
export const canSurge = G => G.stage === 'scene' && !G.cleared && G.hero.hp > 0 && !G.pit && !!G.turn.acted && G.turn.acted !== 'down' && !G.turn.surged && G.hero.energy >= ENERGY.surge;
export function surge(G) {
  if (!canSurge(G)) return err(G.turn.surged ? 'Only one Surge per round' : !G.turn.acted ? 'You still have your action' : `Surge needs ${ENERGY.surge} energy`);
  gainEnergy(G, -ENERGY.surge, true);
  G.turn.acted = null; G.turn.surged = true;
  fx(G, { t: 'power', name: 'Surge' });
  log(G, `${G.hero.name} surges: another action this round.`, 'ability');
  return ok();
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
// Runebrand: another hero's attack rolls +1 die while a foe in their reach is branded by the Runepriest.
export const runebrand = G => (G.hero.cls !== 'runepriest' && foesInReach(G).some(f => f.brand) ? 1 : 0);
export function attackPool(G) {
  const s = derive(G.hero), brand = runebrand(G);
  return { base: s.pool, high: highGround(G), hidden: G.hidden ? HIDDEN_DICE : 0, brand, total: s.pool + highGround(G) + (G.hidden ? HIDDEN_DICE : 0) + brand };
}
export function attack(G, rng) {
  if (!canAttack(G)) return err('You have already acted this turn');
  if (G.strike && strikeLeft(G)) return err('Spend your remaining hits first');
  const s = derive(G.hero), P = attackPool(G);
  const dice = Array.from({ length: P.total }, () => d6(rng));
  const hits = dice.filter(d => d >= 4).length, sixes = dice.filter(d => d === 6).length;
  G.strike = { hits: hits - sixes, crits: sixes, minion: (G.strike?.minion || 0) + sixes * (s.cleave || 0), mult: G.hero.buffs.damageMult || 1 };
  const label = [G.hero.buffs.label, P.high && 'high ground', P.hidden && 'from hiding', P.brand && 'Runebrand'].filter(Boolean).join(', ');
  G.hero.buffs = {};
  G.turn.acted = 'attack';
  if (G.hidden) { G.hidden = null; log(G, `${G.hero.name} strikes from hiding!`, 'hit'); }
  fx(G, { t: 'anim', id: G.hero.hid, a: 'act' });
  fx(G, { t: 'dice', who: G.hero.name, label: label ? `Attack (${label})` : 'Attack', dice, hitOn: 4 });
  log(G, hits ? `${G.hero.name} rolls ${hits} hit${hits === 1 ? '' : 's'}${sixes ? ` (${sixes} crit${sixes > 1 ? 's' : ''})` : ''}.` : `${G.hero.name} rolls and misses.`, 'hit');
  if (!strikeLeft(G)) G.strike = null;
  return ok({ hits, sixes });
}
export const strikeLeft = G => (G.strike ? G.strike.hits + G.strike.crits + G.strike.minion : 0);
// Spend ONE hit on a foe in reach. kind: 'crit' | 'hit' | 'minion' (minion-only hits); omitted = auto:
// minions take minion-only hits, then plain hits, then crits; elites and bosses take crits first.
export function spend(G, foeId, rng, kind) {
  const f = G.foes.find(x => x.id === foeId && !x.dead);
  const st = G.strike;
  if (!f || !st || !strikeLeft(G)) return err('No hits to spend');
  if (!inReach(G, G.pos, f, heroReach(G))) return err(`${f.name} is out of reach`);
  const big = f.type !== 'minion';
  const have = { crit: st.crits, hit: st.hits, minion: big ? 0 : st.minion };
  if (big && !st.hits && !st.crits) return err('Those hits only work on minions');
  if (kind && !have[kind]) kind = null; // that kind ran out: fall back to auto
  kind ||= (big ? ['crit', 'hit'] : ['minion', 'hit', 'crit']).find(k => have[k]);
  G.facing = null;
  fx(G, { t: 'face', id: G.hero.hid, at: { x: f.x, y: f.y } });
  fx(G, { t: 'anim', id: G.hero.hid, a: 'act' });
  if (heroReach(G) > 1) fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: G.hero.cls });
  if (kind === 'crit') st.crits--; else if (kind === 'hit') st.hits--; else st.minion--;
  hitFoe(G, f, 1, rng, { crit: kind === 'crit', mult: st.mult });
  if (!strikeLeft(G)) G.strike = null;
  return ok({ kind });
}

// ------------------------------------------------------------------ hero: powers
// How each power targets on the grid. Solo adaptations of the table rules are noted.
const SPECS = {
  leap: { mode: 'tile', range: 4, up: 3, strike: true, text: 'Pick a square within 4 (up to 3 levels higher), then attack.' },
  quake: { mode: 'self', radius: 2, text: 'Foes within 2 take a hit and are hurled 3 squares away.' },
  bulwark: { mode: 'self', radius: 3, text: 'Ward yourself; foes within 3 are dragged to your side.' },
  recall: { mode: 'foe', range: 10, sight: false, allies: true, text: 'Pick an ally (or a foe) within 10 to swap places with.' },
  circle: { mode: 'self', radius: 2, text: 'Ward and heal you and allies within 2; foes can\'t step inside the circle this round.' },
  hammer: { mode: 'foe', range: 6, sight: true, text: 'Pick a foe within 6 in sight.' },
  grapple: { mode: 'tile', range: 8, sight: true, higher: true, strike: true, text: 'Pick a higher square within 8 in sight, then attack.' },
  vanish: { mode: 'walk', range: 4, text: 'Pick a square up to 4 moves away; you vanish there.' },
  pin: { mode: 'foes', range: 12, sight: true, max: 2, text: 'Pick up to 2 foes within 12 in sight, then confirm.' },
  blink: { mode: 'tile', range: 6, any: true, text: 'Pick any square within 6, at any height.' },
  well: { mode: 'point', range: 8, sight: true, radius: 3, void: true, text: 'Pick a point within 8 in sight (a chasm works: foes are dragged over the edge).' },
  meteor: { mode: 'point', range: 10, radius: 2, text: 'Pick a point within 10.' },
  'set:vaultbreaker': { mode: 'tile', range: 3, strike: true, text: 'Pick a square within 3, at any height.' },
  step: { mode: 'foe', range: 6, sight: false, strike: true, landing: true, text: 'Pick a foe within 6, then the square beside it to appear on; then attack.' },
  smoke: { mode: 'self', text: 'Vanish into smoke.' },
};
// What each class power does in this game (the Ledger's own text is written for a tabletop).
const DESC = {
  leap: 'Leap up to 4 squares, even 3 levels up onto a ledge, with no free blows. Then attack in the same action with +2 dice.',
  quake: 'Slam the ground: every foe within 2 squares takes a hit and is hurled 3 squares away. A foe slammed into a wall, ledge or another foe takes +1 hit; minions knocked into a chasm are gone.',
  bulwark: 'Gain a 600 ward and roar: every foe within 3 squares is dragged to your side and fights you this round.',
  recall: 'Swap places with an ally (or a foe) within 10 squares, with no free blows. Foes turn on whoever now stands before them, and you both gain a 300 rune ward.',
  circle: 'You and every ally within 2 squares gain a 300 rune ward and heal 10%. Foes can\'t step into the circle until the next round.',
  hammer: 'Strike a foe within 6 squares in sight: {hits} hits, knocked 3 squares back (+1 hit if slammed into something), and pinned until the next round.',
  grapple: 'Haul yourself up to a higher square within 8 in sight, with no free blows. Then attack in the same action with +1 die (plus high ground).',
  vanish: 'Move up to 4 squares and become Hidden: foes ignore you in the enemy phase, and your next attack gets +3 dice.',
  pin: 'Pin up to 2 foes within 12 squares in sight so they can\'t move until the next round. +2 dice on your next attack.',
  blink: 'Teleport up to 6 squares, to any height and through anything, with no free blows. Gain a 200 ward.',
  well: 'Pick a point within 8 squares in sight: every foe within 3 of it is dragged toward it and pinned until the next round. Aim it into a chasm and they are dragged over the edge: minions are gone, elites claw back out hurt (bosses hold on). +2 dice on your next attack.',
  meteor: 'Pick a point within 10 squares: every foe within 2 of it takes 2 hits (minions are slain).',
  step: 'Pick a foe within 6 squares and any free square beside it: you teleport there, with no free blows. Then attack in the same action for triple damage.',
  smoke: 'Become Hidden: foes ignore you in the enemy phase, and your next attack gets +3 dice.',
};
export const powerText = p => (p.key === 'step' && p.vaultWard ? `${DESC.step} Vaultbreaker: you also gain a ${fmt(p.vaultWard)} ward.` : (DESC[p.key] || p.text).replace('{hits}', hitsOf(p, 2)));
export function powerSpec(G, p) {
  if (SPECS[p.key]) return SPECS[p.key];
  return { mode: 'self', text: soloNotes(p, G) || p.text };
}
// How a set power's effects play out on the grid (shown with the power's text). A lone hero gets half of any
// energy meant for the others.
function soloNotes(p, G) {
  const out = [], alone = !G || G.party.length < 2;
  for (const f of p.effects || []) {
    if (f.kind === 'smite') out.push(`Lightning strikes up to ${f.kills} minions within 6 in sight; any left over join your hits (minions only).`);
    if (f.kind === 'energize' && f.who === 'others' && alone) out.push(`With no allies, you gain ${Math.round(f.amount * 0.5)} energy instead.`);
  }
  return out.join(' ');
}
// The Vaultbreaker set power is "Vault" here: a short teleport with its ward and damage boost. A Shadowblade has a
// Shadowstep already, so for them it folds into Shadowstep instead (adding the ward).
SETS.vaultbreaker.power.name = 'Vault';
export function powersOf(h) {
  const list = powersFor(h);
  const v = list.find(p => p.key === 'set:vaultbreaker');
  if (!v) return list;
  const ward = v.effects.filter(e => e.kind === 'ward').reduce((t, e) => t + e.amount, 0);
  const mult = Math.max(1, ...v.effects.filter(e => e.kind === 'buff').map(e => e.damageMult || 1));
  const step = h.cls === 'shadowblade' && list.find(p => p.key === 'step');
  if (step) {
    step.effects = [...step.effects, { kind: 'ward', amount: ward, who: 'self' }];
    step.cost = Math.max(5, step.cost - (SETS.vaultbreaker.power.cost - v.cost));
    step.boosted = [...(step.boosted || []), `Vaultbreaker ×${v.pieces} (+${ward} ward)`];
    step.vaultWard = ward;
    return list.filter(p => p !== v);
  }
  v.attack = false;
  v.text = `Vault up to 3 squares, to any height and over anything, with no free blows, and gain a ${fmt(ward)} ward.${mult > 1 ? ` Then attack in the same action for ×${mult} damage.` : ' Then attack in the same action.'}`;
  return list;
}
export const powerList = G => powersOf(G.hero);
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
      if (S.mode === 'point' && t.kind !== 'floor' && !(S.void && t.kind === 'chasm')) continue;
      if (S.up != null && t.e - he > S.up) continue;
      if (S.higher && t.e <= he) continue;
      if (S.sight && !lineOfSight(G.map, here, c)) continue;
      out.push(c);
    }
  } else if (S.mode === 'walk') {
    for (const n of reachable(G.map, here, S.range, (x, y) => occupied(G, x, y, 'hero')).values()) out.push({ x: n.x, y: n.y });
  } else if (S.mode === 'foe' || S.mode === 'foes') {
    for (const f of living(G)) if (dist(here, f) <= S.range && (!S.sight || lineOfSight(G.map, here, f))) out.push({ x: f.x, y: f.y, id: f.id });
    if (S.allies) for (const h of standing(G)) if (h !== G.hero && !h.pit && dist(here, h.pos) <= S.range) out.push({ x: h.pos.x, y: h.pos.y, id: h.hid, ally: true });
  }
  return out;
}
// Free squares beside a foe that Shadowstep can land on (any height: it is a teleport).
export function landingSpots(G, f) {
  const out = [];
  for (const [dx, dy] of DIRS8) {
    const x = f.x + dx, y = f.y + dy, t = tile(G.map, x, y);
    if (standable(t) && !occupied(G, x, y, 'hero')) out.push({ x, y });
  }
  return out;
}
// Use a power. target: { x, y } for squares and points, { ids: [...] } for foes (Shadowstep: { ids, x, y }); nothing for self.
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
    foes = ids.map(id => G.foes.find(f => f.id === id && !f.dead) || G.party.find(h => h.hid === id && h.hp > 0)).filter(f => f && valid.some(c => c.id === (f.hid || f.id)));
    if (!foes.length) return err('Pick a target in range');
  }
  G.hero.energy -= p.cost;
  fx(G, { t: 'energy', id: G.hero.hid, n: -p.cost, quiet: true });
  // attack powers and move-and-strike powers (Leaping Strike, Grapple Line, Shadowstep) leave the attack open
  const strikes = p.attack || !!S.strike;
  G.turn.acted = strikes ? 'attackPower' : 'power';
  fx(G, { t: 'power', name: p.name, set: p.set || null, cls: G.hero.cls });
  fx(G, { t: 'anim', id: G.hero.hid, a: 'act' });
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
    case 'leap': case 'grapple': case 'blink': case 'set:vaultbreaker': {
      const from = { ...G.pos };
      G.pos = at;
      fx(G, { t: 'move', id: G.hero.hid, path: [from, at], kind: keyName === 'blink' || keyName === 'set:vaultbreaker' ? 'blink' : 'leap' });
      break;
    }
    case 'vanish': {
      const nodes = reachable(G.map, G.pos, S.range, (x, y) => occupied(G, x, y, 'hero'));
      const path = pathTo(nodes, at.x, at.y);
      G.pos = at;
      fx(G, { t: 'move', id: G.hero.hid, path, kind: 'walk' });
      break;
    }
    case 'quake': {
      fx(G, { t: 'burst', at: { ...G.pos }, kind: 'quake', radius: S.radius });
      const caught = living(G).filter(f => dist(f, G.pos) <= S.radius).sort((a, b) => dist(b, G.pos) - dist(a, G.pos));
      for (const f of caught) {
        const slam = push(G, f, dirFrom(G.pos, f), 3, rng);
        if (!f.dead) hitFoe(G, f, hitsOf(p, 1) + (slam ? 1 : 0), rng, { label: slam ? 'Slammed' : '' });
      }
      break;
    }
    case 'bulwark': {
      for (const f of living(G).filter(f => dist(f, G.pos) <= S.radius)) {
        f.taunt = G.hero.hid; // it fights this hero in the coming enemy phase
        if (dist(f, G.pos) <= 1) continue;
        const spot = closestFree(G, G.pos, f, 1);
        if (spot) { const from = { x: f.x, y: f.y }; f.x = spot.x; f.y = spot.y; fx(G, { t: 'move', id: f.id, path: [from, spot], kind: 'pull' }); }
      }
      break;
    }
    case 'recall': {
      const u = foes[0], ally = !!u.hid, upos = ally ? u.pos : { x: u.x, y: u.y }, from = { ...G.pos };
      G.pos = { ...upos };
      if (ally) { u.pos = from; withHero(G, u, () => ward(G, 300, true)); for (const f of living(G)) if (f.taunt === u.hid) f.taunt = G.hero.hid; else if (f.taunt === G.hero.hid) f.taunt = u.hid; }
      else { u.x = from.x; u.y = from.y; }
      fx(G, { t: 'move', id: G.hero.hid, path: [upos, G.pos], kind: 'blink' });
      fx(G, { t: 'move', id: ally ? u.hid : u.id, path: [G.pos, from], kind: 'blink' });
      break;
    }
    case 'circle': G.zone = { x: G.pos.x, y: G.pos.y, r: S.radius, round: G.round }; fx(G, { t: 'burst', at: { ...G.pos }, kind: 'circle', radius: S.radius }); break;
    case 'hammer': {
      const f = foes[0];
      fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: 'hammer' });
      const slam = push(G, f, dirFrom(G.pos, f), 3, rng);
      if (!f.dead) { hitFoe(G, f, hitsOf(p, 2) + (slam ? 1 : 0), rng, { label: slam ? 'Slammed' : '' }); if (!f.dead) pinFoe(G, f); }
      break;
    }
    case 'pin': for (const f of foes) { fx(G, { t: 'bolt', from: { ...G.pos }, to: { x: f.x, y: f.y }, cls: 'ranger' }); pinFoe(G, f); } break;
    case 'well': {
      fx(G, { t: 'burst', at, kind: 'well', radius: S.radius });
      if (tile(G.map, at.x, at.y).kind === 'chasm') { // into the void: drag each foe straight at the point, over the edge
        for (const f of living(G).filter(f => dist(f, at) <= S.radius).sort((a, b) => dist(a, at) - dist(b, at))) {
          for (let step = dist(f, at); step > 0 && !f.dead; step--) { // re-aim each step so diagonals still reach the edge
            const was = { x: f.x, y: f.y };
            push(G, f, dirFrom(f, at), 1, rng, { quiet: true });
            if (f.x === was.x && f.y === was.y) break;
          }
          if (!f.dead) pinFoe(G, f);
        }
        break;
      }
      for (const f of living(G).filter(f => dist(f, at) <= S.radius).sort((a, b) => dist(a, at) - dist(b, at))) {
        const spot = closestFree(G, at, f, 0);
        if (spot && dist(spot, at) < dist(f, at)) { const from = { x: f.x, y: f.y }; f.x = spot.x; f.y = spot.y; fx(G, { t: 'move', id: f.id, path: [from, spot], kind: 'pull' }); }
        pinFoe(G, f);
      }
      break;
    }
    case 'meteor': {
      fx(G, { t: 'burst', at, kind: 'meteor', radius: S.radius });
      for (const f of living(G).filter(f => dist(f, at) <= S.radius)) hitFoe(G, f, hitsOf(p, 2), rng);
      break;
    }
    case 'step': {
      const f = foes[0];
      // the square the player picked beside the foe; without one, the far side of the foe from you
      const picked = target && target.x != null && landingSpots(G, f).find(c => c.x === target.x && c.y === target.y);
      const d = dirFrom(G.pos, f), behind = { x: f.x + d[0], y: f.y + d[1] };
      const spot = picked || (landingSpots(G, f).find(c => c.x === behind.x && c.y === behind.y)) || closestFree(G, f, G.pos, 1);
      if (spot) { const from = { ...G.pos }; G.pos = spot; fx(G, { t: 'move', id: G.hero.hid, path: [from, spot], kind: 'blink' }); fx(G, { t: 'face', id: G.hero.hid, at: { x: f.x, y: f.y } }); }
      break;
    }
    case 'smoke': fx(G, { t: 'burst', at: { ...G.pos }, kind: 'smoke', radius: 1 }); break;
  }
  // the ledger's effect list (buffs, wards, heals, energy, minion-slaying hits, hiding)
  for (const f of effects) {
    if (f.kind === 'buff') buff(f);
    else if (f.kind === 'ward') eachHero(G, f.who === 'party' ? 'party' : 'self', () => ward(G, f.amount));
    else if (f.kind === 'heal') eachHero(G, f.who === 'party' ? 'party' : 'self', () => heal(G, f.pct));
    else if (f.kind === 'energize') {
      if (f.who === 'others' && G.party.length < 2) gainEnergy(G, Math.round(f.amount * 0.5)); // no allies: half to yourself
      else eachHero(G, f.who === 'others' ? 'others' : 'party', () => gainEnergy(G, f.amount));
    }
    else if (f.kind === 'smite') smite(G, f.kills, rng);
    else if (f.kind === 'allyWard') { // you and every ally inside the circle: a rune ward
      const me = G.hero;
      for (const h of standing(G).filter(h => h === me || dist(h.pos, me.pos) <= (S.radius || 2))) withHero(G, h, () => { ward(G, f.amount, true); heal(G, f.heal || 0); });
    }
    else if (f.kind === 'swap') ward(G, f.ward || 0, true);
    else if (f.kind === 'hide') { G.hidden = { until: G.round + 1 }; fx(G, { t: 'hide' }); log(G, `${G.hero.name} is hidden.`, 'ability'); }
  }
  checkCleared(G);
  return ok({ attack: strikes });
}
const hitsOf = (p, d) => (p.effects || []).find(e => e.kind === 'areaHit')?.hits ?? d;
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
function push(G, f, [dx, dy], n, rng, { quiet = false } = {}) {
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
  if (slam && !quiet) fx(G, { t: 'text', id: f.id, text: 'Slammed!', color: '#ff9a5a' });
  return slam;
}

// ------------------------------------------------------------------ the Runepriest's reactions
export const priestsOf = G => standing(G).filter(h => h.cls === 'runepriest' && !h.pit);
const reactedThisRound = (G, h, k) => h.reacted?.round === G.round && h.reacted.used.includes(k);
const markReacted = (G, h, k) => { if (h.reacted?.round !== G.round) h.reacted = { round: G.round, used: [] }; h.reacted.used.push(k); };
// Which reactions priest p can use on ally a right now (Turning is automatic, so not listed here).
export function reactionsFor(G, p, a) {
  if (!p || !a || p === a || G.stage !== 'scene' || G.cleared || p.hp <= 0 || p.pit || a.hp <= 0) return [];
  const out = [];
  for (const k of ['mending', 'haste']) {
    const R = REACTIONS[k];
    let why = reactedThisRound(G, p, k) ? 'used this round' : p.energy < R.cost ? `needs ${R.cost} energy` : '';
    if (!why && k === 'mending' && a.hp >= derive(a).maxHp / 3) why = 'ally above a third of their health';
    out.push({ key: k, ...R, ok: !why, why });
  }
  return out;
}
export function react(G, priestHid, key, allyHid) {
  const p = G.party.find(h => h.hid === priestHid), a = G.party.find(h => h.hid === allyHid);
  const r = reactionsFor(G, p, a).find(x => x.key === key);
  if (!r) return err('No such reaction');
  if (!r.ok) return err(`${r.name}: ${r.why}`);
  withHero(G, p, () => gainEnergy(G, -r.cost, true));
  markReacted(G, p, key);
  fx(G, { t: 'power', name: r.name });
  fx(G, { t: 'bolt', from: { ...p.pos }, to: { ...a.pos }, cls: 'runepriest' });
  if (key === 'mending') withHero(G, a, () => heal(G, 15));
  if (key === 'haste') { a.buffs ||= {}; a.buffs.bonusDice = (a.buffs.bonusDice || 0) + 1; a.buffs.label = a.buffs.label ? `${a.buffs.label}, Rune of Haste` : 'Rune of Haste'; fx(G, { t: 'text', id: a.hid, text: '+1 die', color: '#5fd3c4' }); }
  log(G, `${p.name}: ${r.name} on ${a.name}.`, 'ability');
  return ok();
}
// Rune of Turning: armed by default; fires once per round when an ally is about to take a hard hit.
export function setTurning(G, priestHid, on) { const p = G.party.find(h => h.hid === priestHid); if (p) p.turningOff = !on; return ok(); }
function tryTurning(G, target, f, hits, crits) {
  const p = priestsOf(G).find(q => q !== target && !q.turningOff && !reactedThisRound(G, q, 'turning') && q.energy >= REACTIONS.turning.cost);
  if (!p || !hits) return false;
  const s = derive(target), raw = (hits - crits) * f.damage + crits * f.damage * (f.critMult || FOE_CRIT[f.type] || 1.5);
  const est = raw * (1 - armourCut(s.armor)) - (target.ward || 0) - (target.rune || 0);
  if (est < s.maxHp * 0.2 && est < target.hp) return false; // save it for something that matters
  withHero(G, p, () => gainEnergy(G, -REACTIONS.turning.cost, true));
  markReacted(G, p, 'turning');
  fx(G, { t: 'power', name: `${p.name}: Rune of Turning` });
  log(G, `${p.name}'s Rune of Turning: ${target.name}'s foe rerolls its hits.`, 'ability');
  return true;
}

// ------------------------------------------------------------------ wares (one per turn, free)
export function useWare(G, wareId, rng) {
  const ch = G.hero, i = (G.wares || []).findIndex(w => w.id === wareId);
  if (i < 0) return err('No such ware');
  if (G.turn.ware) return err('One ware per hero per turn');
  if (G.stage !== 'scene' || ch.hp <= 0) return err('Not now');
  const C = CONSUMABLES[G.wares[i].key], e = C.effect;
  G.wares.splice(i, 1);
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
    fx(G, { t: 'move', id: G.hero.hid, path: [from, spot], kind: 'leap' });
    log(G, `${G.hero.name} climbs out of the chasm.`, 'ability');
  } else { G.pit.tries++; log(G, `${G.hero.name} slips back down. (+1 to the next try)`, 'hurt'); }
  return ok();
}
function edgeNear(G, p) { return freeNear(G, p) || G.map.start; }
function fall(G) {
  const m = derive(G.hero).maxHp;
  G.pit = { tries: 0 };
  G.strike = null;
  fx(G, { t: 'fall', id: G.hero.hid });
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
  if (dist(G.pos, G.map.exit) > 1) return err('Walk to the stair first'); // one hero reaching it leads the party down
  G.stats.scenes++;
  const last = G.scene === G.adv.acts[G.act].scenes.length - 1;
  if (isLastScene(G)) { G.stage = 'victory'; return ok({ victory: true }); }
  if (last) { G.act++; G.scene = 0; G.stage = 'camp'; for (const h of G.party) { h.downed = false; h.hp = derive(h).maxHp; } G.camp = { open: true }; }
  else { G.scene++; G.stage = 'next'; }
  return ok();
}
export function leaveCamp(G) {
  G.anchor = anchorFor(G); // the new act is sized against the party as it leaves camp
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
  const prefer = [...new Set(G.party.flatMap(h => CLASS_SETS[h.cls] || []))];
  const setKey = r === 'set' && rng() < 0.65 ? prefer[Math.floor(rng() * prefer.length)] : undefined;
  return makeItem(r, rng, undefined, lootLevel(G), setKey);
}
function dropLoot(G, rng, n, floor, from) {
  const items = [];
  for (let i = 0; i < n; i++) items.push(lootItem(G, rng, i === 0 ? floor : null));
  G.bag.push(...items);
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
// Gear changes are free, like the table. who: party index (default: the active hero). The satchel is shared.
const heroOf = (G, who) => G.party[who ?? G.active];
export function equip(G, itemId, who) {
  const ch = heroOf(G, who), i = G.bag.findIndex(it => it.id === itemId);
  if (i < 0 || !ch) return err('Not in the satchel');
  const it = G.bag.splice(i, 1)[0];
  const old = ch.gear[it.slot];
  ch.gear[it.slot] = it;
  if (old) G.bag.push(old);
  withHero(G, ch, () => { clamp(G); announceUnlocks(G); });
  return ok();
}
export function unequip(G, slot, who) {
  const ch = heroOf(G, who), it = ch?.gear[slot];
  if (!it) return err('Nothing there');
  delete ch.gear[slot];
  G.bag.push(it);
  withHero(G, ch, () => clamp(G));
  return ok();
}
// ------------------------------------------------------------------ the armory: move gear around the party
// Where an item is: { who: party index, or -1 for the satchel, slot }.
export function locate(G, itemId) {
  const i = G.bag.findIndex(it => it.id === itemId);
  if (i >= 0) return { who: -1, slot: G.bag[i].slot, item: G.bag[i] };
  for (let w = 0; w < G.party.length; w++) for (const [slot, it] of Object.entries(G.party[w].gear)) if (it?.id === itemId) return { who: w, slot, item: it };
  return null;
}
// Move an item to hero `to` (swapping with whatever that hero wears in the slot, which goes back where the item came
// from) or to the satchel (to = -1). Pure gear shuffle on cloned heroes when `dry` (for previews).
function shuffle(party, bag, itemId, to) {
  let from = -1, it = bag.find(x => x.id === itemId);
  if (!it) for (let w = 0; w < party.length && !it; w++) for (const v of Object.values(party[w].gear)) if (v?.id === itemId) { it = v; from = w; }
  if (!it || from === to) return false;
  const slot = it.slot;
  if (from >= 0) delete party[from].gear[slot]; else bag.splice(bag.indexOf(it), 1);
  if (to < 0) { bag.push(it); return true; }
  const old = party[to].gear[slot];
  party[to].gear[slot] = it;
  if (old) { if (from >= 0) party[from].gear[slot] = old; else bag.push(old); }
  return true;
}
export function place(G, itemId, to) {
  const before = G.party.map(h => new Set(unlockKeys(h)));
  if (!shuffle(G.party, G.bag, itemId, to)) return err('Nothing to move');
  G.party.forEach((h, i) => { withHero(G, h, () => { clamp(G); if (unlockKeys(h).some(k => !before[i].has(k))) announceUnlocks(G); }); });
  return ok();
}
const STAT_KEYS = ['maxHp', 'armor', 'damage', 'dice', 'critMult', 'cleave', 'energyPerRound', 'energyPerKill', 'maxEnergy'];
const powerName = k => { const [kind, id, n] = k.split(':'); return kind === 'syn' ? SYNERGIES.find(s => s.key === id).name : Number(n) === 1 ? SETS[id].power.name : `${SETS[id].name} ×${n}`; };
// What moving item → hero `to` would change, for every hero it touches: stat deltas and set powers / synergies gained or lost.
export function previewPlace(G, itemId, to) {
  const party = G.party.map(h => ({ ...h, gear: { ...h.gear } })), bag = [...G.bag];
  if (!shuffle(party, bag, itemId, to)) return [];
  const out = [];
  G.party.forEach((h, i) => {
    const a = derive(h), b = derive(party[i]);
    const delta = {};
    for (const k of STAT_KEYS) { const d = Math.round(((b[k] || 0) - (a[k] || 0)) * 100) / 100; if (d) delta[k] = d; }
    const ka = new Set(unlockKeys(h)), kb = new Set(unlockKeys(party[i]));
    const gained = [...kb].filter(k => !ka.has(k)), lost = [...ka].filter(k => !kb.has(k));
    const known = new Set(h.unlocked || []);
    if (Object.keys(delta).length || gained.length || lost.length) out.push({
      who: i, delta,
      gained: gained.map(k => ({ key: k, syn: k.startsWith('syn:'), name: k.startsWith('syn:') && !known.has(k) ? 'a hidden synergy!' : powerName(k) })),
      lost: lost.map(k => ({ key: k, syn: k.startsWith('syn:'), name: powerName(k) })),
    });
  });
  return out;
}
// The party's progress toward each synergy: for each hero, how many of the needed pieces they wear.
export function synergyProgress(G) {
  return SYNERGIES.map(sy => {
    const known = G.party.some(h => (h.unlocked || []).includes(`syn:${sy.key}`));
    const heroes = G.party.map((h, i) => {
      const c = setCounts(h);
      const missing = Object.entries(sy.needs).reduce((t, [k, n]) => t + Math.max(0, n - (c[k] || 0)), 0);
      return { who: i, missing, active: missing === 0 };
    });
    const pool = {}; // pieces of the needed sets anywhere in the party's hands or satchel
    for (const k of Object.keys(sy.needs)) pool[k] = G.bag.filter(it => it.set === k).length + G.party.reduce((t, h) => t + (setCounts(h)[k] || 0), 0);
    return { key: sy.key, name: sy.name, needs: sy.needs, known, text: known ? synergyText(sy) : '', heroes, pool };
  });
}
export function discard(G, itemId) {
  const i = G.bag.findIndex(it => it.id === itemId);
  if (i < 0) return err('Not in the satchel');
  G.bag.splice(i, 1);
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
      fx(G, { t: 'unlock', kind: 'synergy', title: `${ch.name}: hidden synergy ${sy.name}`, text: synergyText(sy) });
      log(G, `✦ Hidden synergy discovered: ${sy.name}.`, 'loot');
    } else {
      const S = SETS[id], bonus = S.bonuses.find(b => b.n === Number(n));
      const pw = powersOf(ch).find(p => p.key === S.power.key);
      const folded = id === 'vaultbreaker' && ch.cls === 'shadowblade';
      const text = folded && Number(n) === 1 ? `Shadowstep now also gives you a ward (${fmt(powersOf(ch).find(p => p.key === 'step')?.vaultWard || 0)}).` : Number(n) === 1 ? `New power: ${S.power.name}. ${pw?.text || ''}` : `${S.power.name} grows stronger (${n} pieces).${bonus ? ' ' + statsText(bonus.stats) + '.' : ''}`;
      fx(G, { t: 'unlock', kind: 'set', set: id, title: `${ch.name}: ${Number(n) === 1 ? S.power.name : `${S.name} ×${n}`}`, text });
    }
  }
  ch.unlocked = [...known];
}
export function compareItem(G, it, who) {
  const old = heroOf(G, who).gear[it.slot];
  const keys = new Set([...Object.keys(it.stats), ...Object.keys(old?.stats || {})]);
  return [...keys].map(k => ({ k, now: old?.stats[k] || 0, then: it.stats[k] || 0 }));
}

// ------------------------------------------------------------------ the Rakshasa (camp between acts)
export function sell(G, itemId) {
  const i = G.bag.findIndex(it => it.id === itemId);
  if (i < 0) return err('Not in the satchel');
  const it = G.bag.splice(i, 1)[0];
  const v = SELL_VALUE[it.rarity] || 1;
  G.favour = (G.favour || 0) + v;
  return ok({ favour: v, rarity: it.rarity });
}
export function buyBoon(G, k, who) {
  const ch = heroOf(G, who), B = BOONS[k];
  if (!B || !ch) return err('No such boon');
  if (boonLocked(ch, k)) return err('Only once');
  const price = boonPrice(ch, k);
  if ((G.favour || 0) < price) return err('Not enough Favour');
  G.favour -= price;
  ch.boons = ch.boons || {};
  for (const [s, v] of Object.entries(B.stats)) ch.boons[s] = (ch.boons[s] || 0) + v;
  ch.boonBuys = { ...(ch.boonBuys || {}), [k]: ((ch.boonBuys || {})[k] || 0) + 1 };
  if (B.stats.maxHp) ch.hp += B.stats.maxHp;
  return ok();
}
export function buyWare(G, k) {
  const C = CONSUMABLES[k];
  if (!C) return err('No such ware');
  if ((G.favour || 0) < C.cost) return err('Not enough Favour');
  G.favour -= C.cost;
  G.wares.push({ id: 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), key: k });
  return ok();
}

// ------------------------------------------------------------------ the enemy phase and End round
// End the round: every hero's turn ends, the foes act, then a new round begins.
export function endTurn(G, rng) {
  if (G.stage !== 'scene') return err('Not now');
  for (const h of G.party) h.strike = null;
  fx(G, { t: 'phase', name: 'Enemy phase' });
  enemyPhase(G, rng);
  if (G.stage !== 'scene') return ok();
  endRound(G, rng);
  return ok();
}
// Heroes a foe can go after: standing, not hidden, not down in a chasm.
const targetable = G => standing(G).filter(h => !h.pit && !h.hidden);
// Its target: whoever taunted it, else the hero it can reach soonest (nearest; ties go to the weaker).
function pickTarget(G, f) {
  const list = targetable(G);
  const t = f.taunt && list.find(h => h.hid === f.taunt);
  if (t) return t;
  return list.sort((a, b) => dist(a.pos, f) - dist(b.pos, f) || a.hp - b.hp)[0] || null;
}
function enemyPhase(G, rng) {
  const order = living(G).sort((a, b) => Math.min(...standing(G).map(h => dist(a, h.pos))) - Math.min(...standing(G).map(h => dist(b, h.pos))));
  for (const f of order) {
    if (f.dead || G.stage !== 'scene') continue;
    const target = pickTarget(G, f);
    if (!target) { if (!f.pinned) wander(G, f, rng); continue; }
    withHero(G, target, () => {
      if (!inReach(G, f, G.pos, f.reach, f.fly) && !f.pinned) approach(G, f);
    });
    // after moving, it strikes its target, or whoever it can reach; Sweeping Blows strike every hero in reach
    const inR = targetable(G).filter(h => inReach(G, f, h.pos, f.reach, f.fly));
    const victims = foeHas(f, 'sweep') ? inR : inR.includes(target) ? [target] : inR.slice(0, 1);
    for (const h of victims) if (G.stage === 'scene' && !f.dead) withHero(G, h, () => foeAttack(G, f, rng, victims.length));
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
export function foeAttackDice(G, f, swept = 1) {
  const s = derive(G.hero);
  const surrounded = living(G).filter(o => adjacent(o, G.pos)).length >= 3 ? 1 : 0;
  const higher = tile(G.map, f.x, f.y).e > heroTile(G).e ? 1 : 0;
  const sweep = foeHas(f, 'sweep') && swept < 2 ? 1 : 0; // Sweeping Blows with only one hero to sweep swings once more
  return { n: f.attacks + surrounded + higher + sweep, landOn: landOn(s), hitOn: hitOn(landOn(s)), surrounded, higher };
}
function foeAttack(G, f, rng, swept = 1) {
  const D = foeAttackDice(G, f, swept);
  let dice = Array.from({ length: D.n }, () => d6(rng));
  const count = ds => ({ hits: ds.filter(d => d >= D.hitOn).length, crits: ds.filter(d => d === 6).length });
  fx(G, { t: 'face', id: f.id, at: { ...G.pos } });
  fx(G, { t: 'anim', id: f.id, a: 'attack', face: G.pos });
  if (f.reach > 1) fx(G, { t: 'bolt', from: { x: f.x, y: f.y }, to: { ...G.pos }, cls: 'arrow' });
  fx(G, { t: 'dice', who: f.name, label: `${f.name} attacks ${G.hero.name}${D.surrounded ? ' (surrounded)' : ''}${D.higher ? ' (from above)' : ''}`, dice, hitOn: D.hitOn, defense: true });
  let { hits, crits } = count(dice);
  if (tryTurning(G, G.hero, f, hits, crits)) { // reroll every die that hit, once; only the second roll counts
    dice = dice.map(d => (d >= D.hitOn ? d6(rng) : d));
    ({ hits, crits } = count(dice));
    fx(G, { t: 'dice', who: f.name, label: 'Rune of Turning: reroll', dice, hitOn: D.hitOn, defense: true });
  }
  const landed = hits, mult = f.critMult || FOE_CRIT[f.type] || 1.5, sunder = foeHas(f, 'sunder');
  for (let i = 0; i < landed && G.stage === 'scene'; i++) { // one blow at a time, crits first
    const crit = i < crits;
    hurtHero(G, Math.round(f.damage * (crit ? mult : 1)), { from: f, crit, sunder, label: `${crit ? 'Crit' : 'Blow'}${landed > 1 ? ` ${i + 1} of ${landed}` : ''}` });
  }
  if (!landed) fx(G, { t: 'text', id: G.hero.hid, text: 'Blocked', color: '#cfd8e3' });
  if (G.stage !== 'scene') return;
  if (foeHas(f, 'leech')) {
    const lost = -gainEnergy(G, -10);
    if (lost) announce(G, f, 'leech', `${G.hero.name} loses ${lost} energy.`);
  }
  if (foeHas(f, 'drown') && landed >= 2) {
    const lost = -gainEnergy(G, -ENERGY.drown);
    if (lost) announce(G, f, 'drown', `${G.hero.name} loses ${lost} energy.`);
  }
  if (foeHas(f, 'slam') && landed) hurl(G, f, rng);
}
// Slam: the hero is hurled 3 squares straight away from the foe.
function hurl(G, f, rng) {
  announce(G, f, 'slam', `${G.hero.name} is hurled 3 squares!`);
  const [dx, dy] = dirFrom(f, G.pos), from = { ...G.pos };
  let slammed = false;
  for (let i = 0; i < 3; i++) {
    const nx = G.pos.x + dx, ny = G.pos.y + dy, t = tile(G.map, nx, ny), cur = heroTile(G);
    if (t && t.kind === 'chasm') {
      G.pos = { x: nx, y: ny };
      fx(G, { t: 'move', id: G.hero.hid, path: [from, G.pos], kind: 'push' });
      fall(G);
      return;
    }
    if (!standable(t) || occupied(G, nx, ny, 'hero') || t.e - cur.e > 0) { slammed = true; break; }
    G.pos = { x: nx, y: ny };
  }
  if (G.pos.x !== from.x || G.pos.y !== from.y) fx(G, { t: 'move', id: G.hero.hid, path: [from, { ...G.pos }], kind: 'push' });
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
  for (const f of living(G)) {
    if (foeHas(f, 'chill')) for (const h of standing(G).filter(h => h.pos && !h.pit && adjacent(h.pos, f))) {
      const lost = -withHero(G, h, () => gainEnergy(G, -ENERGY.chill));
      if (lost) announce(G, f, 'chill', `${h.name} loses ${lost} energy.`);
    }
    f.taunt = null; f.brand = null;
  }
  for (const h of G.party) { // wards fade: both layers halve
    const had = (h.ward || 0) + (h.rune || 0);
    h.ward = Math.floor((h.ward || 0) / 2); h.rune = Math.floor((h.rune || 0) / 2); h.minionKills = 0;
    if (had) fx(G, { t: 'wardfade', id: h.hid, ward: h.ward, rune: h.rune });
  }
  for (const h of G.party) if (h.hidden && h.hidden.until <= G.round) { h.hidden = null; fx(G, { t: 'text', id: h.hid, text: 'Revealed', color: '#b88cff' }); }
  G.zone = null;
  G.round++;
  G.stats.rounds++;
  arriveWaves(G, rng);
  let e = 0;
  for (const h of standing(G)) { // regen tapers: at or above half your max you gain half your Energy per Round
    const epr = energyPerRound(h), gain = h.energy >= derive(h).maxEnergy / 2 ? Math.floor(epr / 2) : epr;
    e = withHero(G, h, () => gainEnergy(G, gain, true)); h.turn = freshTurnFor(h);
  }
  for (const h of G.party) if (h.hp <= 0) h.turn = { move: 0, acted: 'down', ware: true };
  // start the round with the first hero still standing
  G.active = Math.max(0, G.party.findIndex(h => h.hp > 0));
  fx(G, { t: 'phase', name: `Round ${G.round}`, energy: G.party.length > 1 ? 0 : e });
  checkCleared(G);
}

// ------------------------------------------------------------------ retry
export function retryScene(G, rng) {
  const cp = JSON.parse(G.checkpoint);
  Object.assign(G, { party: cp.party, bag: cp.bag, favour: cp.favour, wares: cp.wares, act: cp.act, scene: cp.scene, anchor: cp.anchor, stats: cp.stats });
  for (const h of G.party) { h.downed = false; h.hp = derive(h).maxHp; h.energy = Math.max(h.energy, 30); }
  G.log = [];
  return startScene(G, rng);
}

const ok = (r = {}) => ({ ok: true, ...r });
const err = error => ({ ok: false, error });
