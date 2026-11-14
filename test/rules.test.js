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
