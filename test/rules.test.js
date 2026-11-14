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

test('attacks bank a pool of hits; minions take one, big foes take the rest', () => {
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
  assert.ok(R.spend(G, 'elite' + x, rng).ok);
  const s = R.heroStats(G);
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
