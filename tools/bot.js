// A simple bot used by the tests and the balance sim.
import * as R from '../src/game/rules.js';
import { dist } from '../src/game/grid.js';

// A simple bot: each hero in turn equips upgrades, uses a power when it can, walks into reach, attacks and
// spends on the weakest foe; then the round ends.
export function botTurn(G, rng) {
  G.party.forEach((h, i) => { if (h.hp > 0 && G.stage === 'scene' && !G.cleared) { R.selectHero(G, i); heroTurn(G, rng); } });
  if (G.stage === 'scene' && !G.cleared) R.endTurn(G, rng);
}
const score = x => (x ? Object.entries(x.stats).reduce((t, [k, v]) => t + v * ({ damage: 2, maxHp: 1, armor: 30, dice: 400, critMult: 200, cleave: 150 }[k] || 5), 0) + (x.set ? 300 : 0) : -1);
function heroTurn(G, rng) {
  if (G.pit) { R.climb(G, rng); return; }
  // the Runepriest's reactions on this hero: mend when low, haste when about to attack
  for (const p of R.priestsOf(G)) {
    if (p === G.hero) continue;
    R.react(G, p.hid, 'mending', G.hero.hid);
    if (R.foesInReach(G).length && p.energy >= 70) R.react(G, p.hid, 'haste', G.hero.hid);
  }
  for (const it of [...G.bag]) if (score(it) > score(G.hero.gear[it.slot])) R.equip(G, it.id);
  const s = R.heroStats(G);
  if (G.hero.hp < s.maxHp * 0.4) { const w = G.wares.find(c => c.key === 'draught'); if (w) R.useWare(G, w.id, rng); }
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
  if (!G.turn.acted && atk && R.foesInReach(G).length) {
    const t = R.powerSpec(G, atk).mode === 'foe' ? R.powerTargets(G, atk).sort((a, b) => R.living(G).filter(o => Math.max(Math.abs(o.x - b.x), Math.abs(o.y - b.y)) <= 1).length - R.living(G).filter(o => Math.max(Math.abs(o.x - a.x), Math.abs(o.y - a.y)) <= 1).length)[0] : null;
    R.usePower(G, atk.key, t ? { ids: [t.id] } : null, rng);
  }
  if (R.canAttack(G) && R.foesInReach(G).length) {
    R.attack(G, rng);
    for (let guard = 0; guard < 40 && R.strikeLeft(G); guard++) {
      const t = R.foesInReach(G).sort((a, b) => (b.type !== 'minion') - (a.type !== 'minion') || a.hp - b.hp);
      const target = G.strike.minion && !G.strike.hits && !G.strike.crits ? t.find(f => f.type === 'minion') : t[0];
      if (!target || !R.spend(G, target.id, rng).ok) break;
    }
    // Surge for a second attack when there is energy to spare and something left to hit
    if (R.canSurge(G) && G.hero.energy >= 85 && R.foesInReach(G).length) {
      R.surge(G); R.attack(G, rng);
      for (let guard = 0; guard < 40 && R.strikeLeft(G); guard++) { const t = R.foesInReach(G).sort((a, b) => a.hp - b.hp)[0]; if (!t || !R.spend(G, t.id, rng).ok) break; }
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
}
export function playScene(G, rng, maxRounds = 40) {
  for (let r = 0; r < maxRounds && G.stage === 'scene' && !G.cleared; r++) { botTurn(G, rng); G.fx.length = 0; }
  if (G.stage !== 'scene' || !G.cleared) return G.stage === 'dead' ? 'dead' : 'stuck';
  for (const c of G.map.chests) {
    const spots = [...R.heroMoves(G).values()].filter(n => dist(n, c) === 1);
    if (spots.length) { G.pos = { x: spots[0].x, y: spots[0].y }; R.openChest(G, c.x, c.y, rng); }
  }
  G.pos = { ...G.map.exit };
  return R.takeExit(G).ok ? 'clear' : 'exit failed';
}

