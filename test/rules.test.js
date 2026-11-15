import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/game/rules.js';
import { rngFrom, dist, tile, key, reachable, standable } from '../src/game/grid.js';
import { generateMap } from '../src/game/mapgen.js';
import { playScene } from '../tools/bot.js';

const CLASSES = Object.keys(R.CLASSES);

test('maps are connected and keep their gates, chests and exit reachable', () => {
  for (const arena of ['ruins', 'hall', 'pits', 'arena', 'chasm']) for (let seed = 1; seed < 40; seed++) {
    const m = generateMap(arena, rngFrom(seed), { chests: 2 });
    const seen = reachable(m, m.start, 999, () => false);
    for (const s of [...m.spawns, m.exit]) assert.ok(seen.has(key(s.x, s.y)), `${arena}/${seed}: ${s.x},${s.y} unreachable`);
    for (const c of m.chests) assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has(key(c.x + dx, c.y + dy))), `${arena}/${seed}: chest closed in`);
  }
});

test('a scene starts with the first wave on the map and the hero at the entry', () => {
  const rng = rngFrom(7), G = R.newRun('Tess', 'ranger', rng);
  R.startScene(G, rng);
  assert.equal(G.stage, 'scene');
  assert.ok(R.living(G).length > 0);
  assert.deepEqual(G.pos, G.map.start);
  assert.ok(G.waves.length >= 1, 'later waves pending');
});

test('attacks bank a pool of hits, spent one at a time', () => {
  const rng = rngFrom(3), G = R.newRun('Bo', 'ironclad', rng);
  R.startScene(G, rng);
  G.foes = [];
  const place = (x, y, type) => G.foes.push({ id: type + x, name: type, type, x, y, hp: type === 'minion' ? 1 : 5000, maxHp: 5000, armor: 20, damage: 100, attacks: 1, move: 4, reach: 1, abilities: [] });
  const { x, y } = G.pos;
  place(x - 1, y, 'minion'); place(x, y - 1, 'elite');
  G.strike = { hits: 2, crits: 1, minion: 0, mult: 1 };
  G.turn.acted = 'attack';
  assert.ok(R.spend(G, 'minion' + (x - 1), rng).ok);
  assert.ok(G.foes[0].dead);
  assert.ok(R.spend(G, 'elite' + x, rng).ok); // one hit at a time: the crit goes first on a big foe
  const s = R.heroStats(G);
  assert.equal(G.foes[1].hp, 5000 - Math.round(s.damage * s.critMult * 0.8));
  assert.equal(R.strikeLeft(G), 1);
  assert.ok(R.spend(G, 'elite' + x, rng, 'hit').ok);
  assert.equal(G.foes[1].hp, 5000 - Math.round(s.damage * 0.8) - Math.round(s.damage * s.critMult * 0.8));
  assert.equal(R.strikeLeft(G), 0);
});

test('walking away from an adjacent foe draws a free blow', () => {
  const rng = rngFrom(11), G = R.newRun('Bo', 'arcanist', rng);
  R.startScene(G, rng);
  G.foes = [{ id: 'g', name: 'Grunt', type: 'minion', x: G.pos.x + 1, y: G.pos.y, hp: 1, maxHp: 1, armor: 0, damage: 60, attacks: 1, move: 4, reach: 1, abilities: [] }];
  const dest = [...R.heroMoves(G).values()].find(n => dist(n, G.foes[0]) >= 3);
  const path = []; // the path check
  R.moveHero(G, dest.x, dest.y, rng);
  assert.ok(G.fx.some(e => e.t === 'dice' && e.label === 'Free blow'));
});

test('slam hurls the hero; a chasm behind them means a fall and a climb', () => {
  const rng = rngFrom(5), G = R.newRun('Bo', 'ranger', rng);
  R.startScene(G, rng);
  const { x, y } = G.pos;
  for (let i = 1; i <= 4; i++) { const t = tile(G.map, x - i, y); Object.assign(t, { kind: i === 2 ? 'chasm' : 'floor', prop: null, e: 0 }); }
  Object.assign(tile(G.map, x + 1, y), { kind: 'floor', prop: null, e: 0 });
  G.foes = [{ id: 'b', name: 'Brute', type: 'elite', x: x + 1, y, hp: 3000, maxHp: 3000, armor: 0, damage: 100, attacks: 6, move: 4, reach: 1, abilities: ['slam'] }];
  G.hero.hp = 99999;
  R.endTurn(G, rngFrom(1));
  assert.ok(G.pit, 'fell into the chasm');
  assert.equal(tile(G.map, G.pos.x, G.pos.y).kind, 'chasm');
  let tries = 0;
  while (G.pit && tries++ < 10) { R.climb(G, rng); if (G.pit) { G.turn.acted = null; } }
  assert.ok(!G.pit, 'climbed out');
  assert.ok(standable(tile(G.map, G.pos.x, G.pos.y)));
});

test('every class power resolves on a live map', () => {
  for (const cls of CLASSES) {
    const rng = rngFrom(21), G = R.newRun('T', cls, rng);
    R.startScene(G, rng);
    for (const p of R.powerList(G)) {
      G.turn.acted = null; G.hero.energy = 100;
      const targets = R.powerTargets(G, p), spec = R.powerSpec(G, p);
      let tgt = null;
      if (spec.mode === 'foe' || spec.mode === 'foes') { if (!targets.length) continue; tgt = { ids: [targets[0].id] }; }
      else if (spec.mode !== 'self') { if (!targets.length) continue; tgt = targets[targets.length - 1]; }
      const r = R.usePower(G, p.key, tgt, rng);
      assert.ok(r.ok, `${cls}/${p.key}: ${r.error}`);
      assert.ok(standable(tile(G.map, G.pos.x, G.pos.y)), `${cls}/${p.key} left the hero somewhere odd`);
      const spots = new Set(R.living(G).map(f => key(f.x, f.y)));
      assert.equal(spots.size, R.living(G).length, `${cls}/${p.key}: two foes share a square`);
      assert.ok(!spots.has(key(G.pos.x, G.pos.y)), `${cls}/${p.key}: foe on the hero`);
    }
  }
});

test('the bot can clear the opening act with every class (two retries, like a player)', () => {
  const results = {};
  for (const cls of CLASSES) {
    const rng = rngFrom(100 + cls.length), G = R.newRun('Bot', cls, rng);
    const out = [];
    let lives = 2;
    R.startScene(G, rng);
    while (G.act === 0 && out.length < 12) {
      const r = playScene(G, rng);
      out.push(r);
      if (r === 'dead' && lives-- > 0) { R.retryScene(G, rng); continue; }
      if (r !== 'clear') break;
      if (G.stage === 'camp') break;
      R.startScene(G, rng);
    }
    results[cls] = out;
  }
  const wins = Object.values(results).filter(o => o.at(-1) === 'clear').length;
  assert.ok(wins >= 4, `only ${wins} classes cleared Act I: ${JSON.stringify(results)}`);
});

test('Leaping Strike leaves the attack open; hits survive moving; a cleared scene allows free walking', () => {
  const rng = rngFrom(9), G = R.newRun('Bo', 'ironclad', rng);
  R.startScene(G, rng);
  G.hero.energy = 100;
  const leap = R.powerList(G).find(p => p.key === 'leap');
  const spot = R.powerTargets(G, leap)[0];
  assert.ok(R.usePower(G, 'leap', spot, rng).ok);
  assert.ok(R.canAttack(G), 'can still attack after leaping');
  assert.ok(!R.canAct(G), 'but not take another action');
  G.strike = { hits: 2, crits: 0, minion: 0, mult: 1 };
  const step = [...R.heroMoves(G).values()].find(n => n.cost === 1);
  R.moveHero(G, step.x, step.y, rng);
  assert.equal(R.strikeLeft(G), 2, 'hits kept while moving');
  R.endTurn(G, rng);
  assert.equal(R.strikeLeft(G), 0, 'hits gone at end of turn');
  for (const f of G.foes) f.dead = true;
  G.waves = []; G.turn.move = 0;
  R.useWare(G, G.wares[0].id, rng); // any action re-checks the scene
  assert.ok(G.cleared);
  assert.ok(R.heroMoves(G).size > 20, 'free movement once clear');
});

test('a party: each hero has their own turn; foes go for the nearest hero; ally powers reach allies', () => {
  const rng = rngFrom(31), G = R.newRun([{ cls: 'ironclad' }, { cls: 'runepriest' }, { cls: 'ranger' }], rng);
  R.startScene(G, rng);
  assert.equal(G.party.length, 3);
  const spots = new Set(G.party.map(h => key(h.pos.x, h.pos.y)));
  assert.equal(spots.size, 3, 'heroes start on separate squares');
  // one hero acting doesn't spend another's action
  R.sprint(G);
  R.selectHero(G, 1);
  assert.ok(R.canAct(G), 'the second hero can still act');
  // the Runepriest swaps with the Ironclad
  G.hero.energy = 100;
  const recall = R.powerList(G).find(p => p.key === 'recall');
  const ally = R.powerTargets(G, recall).find(t => t.ally);
  assert.ok(ally, 'an ally is a valid Rune of Recall target');
  const before = { ...G.party[0].pos }, mine = { ...G.pos };
  assert.ok(R.usePower(G, 'recall', { ids: [ally.id] }, rng).ok);
  assert.deepEqual(G.pos, before); assert.deepEqual(G.party[0].pos, mine);
  assert.ok(G.party[0].ward >= 300 && G.party[1].ward >= 300, 'both gain a ward');
  // downed heroes don't end the run; the whole party does
  G.party[0].hp = 1; R.selectHero(G, 0);
  G.foes = [{ id: 'z', name: 'Brute', type: 'elite', x: G.pos.x + 1, y: G.pos.y, hp: 9000, maxHp: 9000, armor: 0, damage: 5000, attacks: 6, move: 4, reach: 1, abilities: [] }];
  for (const h of G.party.slice(1)) h.pos = { x: 1, y: 1 + G.party.indexOf(h) };
  R.endTurn(G, rngFrom(2));
  assert.equal(G.party[0].hp, 0);
  assert.equal(G.stage, 'scene', 'the others fight on');
  assert.notEqual(G.active, 0, 'control moves to a standing hero');
});

test('Gravity Well can be aimed into a chasm and drags foes over the edge', () => {
  const rng = rngFrom(41), G = R.newRun('Orrin', 'arcanist', rng);
  R.startScene(G, rng);
  const { x, y } = G.pos;
  // a clear strip to the west of the hero with a chasm square at x-5
  for (let i = 1; i <= 7; i++) Object.assign(tile(G.map, x - i, y), { kind: i === 5 ? 'chasm' : 'floor', prop: null, e: 0, rough: false });
  G.foes = [
    { id: 'm', name: 'Grunt', type: 'minion', x: x - 3, y, hp: 1, maxHp: 1, armor: 0, damage: 60, attacks: 1, move: 4, reach: 1, abilities: [] },
    { id: 'e', name: 'Brute', type: 'elite', x: x - 7, y, hp: 3000, maxHp: 3000, armor: 0, damage: 100, attacks: 1, move: 4, reach: 1, abilities: [] },
  ];
  G.waves = [];
  G.hero.energy = 100;
  const well = R.powerList(G).find(p => p.key === 'well');
  assert.ok(R.powerTargets(G, well).some(c => c.x === x - 5 && c.y === y), 'a chasm square is a valid Gravity Well point');
  assert.ok(R.usePower(G, 'well', { x: x - 5, y }, rng).ok);
  assert.ok(G.foes[0].dead, 'the minion was dragged into the chasm');
  assert.ok(G.foes[1].hp < 3000 && G.foes[1].pinned, 'the elite fell, clawed out hurt and is pinned');
});

test('the armory moves and swaps gear between heroes and previews what changes', () => {
  const rng = rngFrom(51), G = R.newRun([{ cls: 'ironclad' }, { cls: 'arcanist' }], rng);
  R.startScene(G, rng);
  const maul = { id: 'tf', name: 'Thunderforge Maul', base: 'Thunderforge Maul', slot: 'weapon', rarity: 'set', set: 'thunderforge', stats: { damage: 200 } };
  const rod = { id: 'eh', name: 'Emberheart Rod', base: 'Emberheart Rod', slot: 'weapon', rarity: 'set', set: 'emberheart', stats: { damage: 150 } };
  const wraps = { id: 'ew', name: 'Emberheart Wraps', base: 'Emberheart Wraps', slot: 'gloves', rarity: 'set', set: 'emberheart', stats: { damage: 50 } };
  G.party[0].gear.weapon = maul;
  G.party[1].gear.weapon = rod;
  G.bag.push(wraps);
  // previews: the wraps on the Ironclad would complete "Forge and Flame" (Thunderforge 1 + Emberheart 1)
  const pv = R.previewPlace(G, 'ew', 0);
  assert.equal(pv.length, 1);
  assert.equal(pv[0].delta.damage, 50 + 120, 'the piece plus the synergy damage');
  assert.ok(pv[0].gained.some(g => g.syn), 'a synergy would be gained');
  // swapping the weapons between heroes
  assert.ok(R.place(G, 'tf', 1).ok);
  assert.equal(G.party[1].gear.weapon.id, 'tf');
  assert.equal(G.party[0].gear.weapon.id, 'eh', 'the displaced item goes back to the giver');
  // to the satchel and back
  assert.ok(R.place(G, 'eh', -1).ok);
  assert.ok(!G.party[0].gear.weapon && G.bag.some(i => i.id === 'eh'));
  const sp = R.synergyProgress(G).find(s => s.key === 'forgeflame');
  assert.ok(sp.pool.thunderforge >= 1 && sp.pool.emberheart >= 2);
});

test('Shadowstep lands on the square beside the target that the player picks', () => {
  const rng = rngFrom(61), G = R.newRun('Vex', 'shadowblade', rng);
  R.startScene(G, rng);
  const { x, y } = G.pos;
  for (let dx = -5; dx <= 0; dx++) for (let dy = -2; dy <= 0; dy++) Object.assign(tile(G.map, x + dx, y + dy), { kind: 'floor', prop: null, e: 0 });
  G.foes = [{ id: 'f', name: 'Grunt', type: 'elite', x: x - 3, y: y - 1, hp: 3000, maxHp: 3000, armor: 0, damage: 50, attacks: 1, move: 4, reach: 1, abilities: [] }];
  G.waves = []; G.hero.energy = 100;
  const spots = R.landingSpots(G, G.foes[0]);
  assert.ok(spots.length >= 6);
  const pick = spots.find(s => s.x === x - 4 && s.y === y - 2);
  assert.ok(R.usePower(G, 'step', { ids: ['f'], x: pick.x, y: pick.y }, rng).ok);
  assert.deepEqual(G.pos, { x: x - 4, y: y - 2 });
  assert.ok(R.canAttack(G), 'and the attack is open');
});

test('every kill grants energy; Vault moves; a Shadowblade folds it into Shadowstep', () => {
  const rng = rngFrom(71), G = R.newRun([{ cls: 'arcanist' }, { cls: 'shadowblade' }], rng);
  R.startScene(G, rng);
  const { x, y } = G.pos;
  for (let i = 1; i <= 7; i++) Object.assign(tile(G.map, x - i, y), { kind: i === 5 ? 'chasm' : 'floor', prop: null, e: 0 });
  G.foes = [{ id: 'm', name: 'Grunt', type: 'minion', x: x - 3, y, hp: 1, maxHp: 1, armor: 0, damage: 60, attacks: 1, move: 4, reach: 1, abilities: [] },
    { id: 'n', name: 'Grunt', type: 'minion', x: 1, y: 1, hp: 1, maxHp: 1, armor: 0, damage: 60, attacks: 1, move: 4, reach: 1, abilities: [] }];
  G.waves = []; G.hero.energy = 60;
  R.usePower(G, 'well', { x: x - 5, y }, rng);
  assert.equal(G.hero.energy, 60 - 45 + R.heroStats(G).energyPerKill, 'the chasm kill paid energy');
  const vault = { id: 'vb', name: 'Vaultbreaker Dirks', base: 'x', slot: 'weapon', rarity: 'set', set: 'vaultbreaker', stats: { damage: 10 } };
  G.party[0].gear.weapon = vault;
  const v = R.powerList(G).find(p => p.key === 'set:vaultbreaker');
  assert.equal(v.name, 'Vault');
  G.turn.acted = null; G.hero.energy = 100;
  const spot = R.powerTargets(G, v)[0];
  assert.ok(R.usePower(G, 'set:vaultbreaker', spot, rng).ok);
  assert.deepEqual(G.pos, { x: spot.x, y: spot.y });
  assert.ok(G.hero.ward > 0 && R.canAttack(G));
  delete G.party[0].gear.weapon; G.party[1].gear.weapon = vault; R.selectHero(G, 1);
  const list = R.powerList(G);
  assert.ok(!list.some(p => p.key === 'set:vaultbreaker'), 'no separate power for the Shadowblade');
  assert.ok(list.find(p => p.key === 'step').effects.some(e => e.kind === 'ward'), 'Shadowstep gains the ward');
});
