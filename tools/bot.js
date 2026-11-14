// A simple bot used by the tests and the balance sim.
import * as R from '../src/game/rules.js';
import { dist } from '../src/game/grid.js';

// A simple bot: equip upgrades, use a power when it can, walk into reach, attack, spend on the weakest foe.
export function botTurn(G, rng) {
  if (G.pit) { R.climb(G, rng); return R.endTurn(G, rng); }
  for (const it of [...(G.hero.bag || [])]) {
    const old = G.hero.gear[it.slot];
    const score = x => (x ? Object.entries(x.stats).reduce((t, [k, v]) => t + v * ({ damage: 2, maxHp: 1, armor: 30, dice: 400, critMult: 200, cleave: 150 }[k] || 5), 0) + (x.set ? 300 : 0) : -1);
    if (score(it) > score(old)) R.equip(G, it.id);
  }
  const s = R.heroStats(G);
  if (G.hero.hp < s.maxHp * 0.4) { const w = G.hero.consumables?.find(c => c.key === 'draught'); if (w) R.useWare(G, w.id, rng); }
  const near = () => R.living(G).sort((a, b) => dist(a, G.pos) - dist(b, G.pos))[0];
  // walk toward the nearest foe until it is in reach
  if (!R.foesInReach(G).length && near()) {
    const nodes = R.heroMoves(G);
    let best = null;
    for (const n of nodes.values()) {
      const inR = R.living(G).some(f => R.inReach(G, n, f, R.heroReach(G)));
      const sc = (inR ? -100 : 0) + dist(n, near()) + n.cost * 0.01;
      if (!best || sc < best.sc) best = { ...n, sc };
    }
    if (best && (best.x !== G.pos.x || best.y !== G.pos.y)) R.moveHero(G, best.x, best.y, rng);
  }
  if (G.stage !== 'scene') return;
  // spend energy on an area power if it would catch something, else attack
  const pw = R.powerList(G).filter(p => R.powerUsable(G, p));
  const meteor = pw.find(p => p.key === 'meteor' || p.key === 'quake');
  if (meteor && R.living(G).filter(f => dist(f, G.pos) <= 2).length >= 2 && meteor.key === 'quake') R.usePower(G, 'quake', null, rng);
  else if (meteor?.key === 'meteor') {
    const f = near(); if (f && dist(f, G.pos) <= 10) R.usePower(G, 'meteor', { x: f.x, y: f.y }, rng);
  }
  const defend = pw.find(p => R.powerSpec(G, p).mode === 'self' && p.effects.some(e => ['heal', 'ward', 'allyWard'].includes(e.kind)));
  if (!G.turn.acted && defend && G.hero.hp < s.maxHp * 0.35 && !R.foesInReach(G).length) R.usePower(G, defend.key, null, rng);
  const big = R.living(G).find(f => f.type !== 'minion');
  const strike = pw.find(p => ['hammer'].includes(p.key));
  if (!G.turn.acted && strike && big && R.powerTargets(G, strike).some(t => t.id === big.id)) R.usePower(G, strike.key, { ids: [big.id] }, rng);
  const atk = pw.find(p => p.attack);
  if (!G.turn.acted && atk && R.foesInReach(G).length) R.usePower(G, atk.key, null, rng);
  if (R.canAttack(G) && R.foesInReach(G).length) {
    R.attack(G, rng);
    for (let guard = 0; guard < 40 && R.strikeLeft(G); guard++) {
      const t = R.foesInReach(G).sort((a, b) => (b.type !== 'minion') - (a.type !== 'minion') || a.hp - b.hp);
      const target = G.strike.minion && !G.strike.hits && !G.strike.crits ? t.find(f => f.type === 'minion') : t[0];
      if (!target || !R.spend(G, target.id, rng).ok) break;
    }
  } else if (!G.turn.acted && !R.foesInReach(G).length) {
    R.sprint(G);
    const f = near();
    if (f) {
      const nodes = R.heroMoves(G);
      let best = null;
      for (const n of nodes.values()) if (!best || dist(n, f) < dist(best, f)) best = n;
      if (best) R.moveHero(G, best.x, best.y, rng);
    }
  }
  if (G.stage === 'scene') R.endTurn(G, rng);
}
export function playScene(G, rng, maxRounds = 40) {
  for (let r = 0; r < maxRounds && G.stage === 'scene' && !G.cleared; r++) { botTurn(G, rng); G.fx.length = 0; }
  if (G.stage !== 'scene' || !G.cleared) return G.stage === 'dead' ? 'dead' : 'stuck';
  for (const c of G.map.chests) {
    const spots = [...R.heroMoves({ ...G, turn: { move: 99 } }).values()].filter(n => dist(n, c) === 1);
    if (spots.length) { G.pos = { x: spots[0].x, y: spots[0].y }; R.openChest(G, c.x, c.y, rng); }
  }
  G.pos = { ...G.map.exit };
  return R.takeExit(G).ok ? 'clear' : 'exit failed';
}

