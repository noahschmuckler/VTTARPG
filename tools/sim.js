// Balance sim: a simple bot plays the whole campaign N times per line-up. Usage: node tools/sim.js [runs] [solo|party|all]
import * as R from '../src/game/rules.js';
import { rngFrom } from '../src/game/grid.js';
import { playScene } from './bot.js';
const N = Number(process.argv[2] || 20), which = process.argv[3] || 'all';
const solo = Object.keys(R.CLASSES).map(c => [c]);
const parties = [['ironclad', 'ranger', 'runepriest'], ['ironclad', 'arcanist', 'shadowblade'], ['runepriest', 'ranger', 'arcanist'], ['ironclad', 'ranger'], ['ironclad', 'runepriest', 'ranger', 'arcanist']];
const lineups = which === 'solo' ? solo : which === 'party' ? parties : [...solo, ...parties];
for (const line of lineups) {
  const reached = {}; let wins = 0, rounds = 0, scenes = 0, downs = 0;
  for (let i = 0; i < N; i++) {
    const rng = rngFrom(1000 + i * 7), G = R.newRun(line.map(cls => ({ cls })), rng);
    let lives = 3;
    R.startScene(G, rng);
    for (;;) {
      const r = playScene(G, rng);
      rounds += G.round; scenes++;
      downs += G.log.filter(l => / is down!/.test(l.text)).length;
      if (r === 'dead' && lives-- > 0) { R.retryScene(G, rng); continue; }
      if (r !== 'clear') { const k = `${G.act + 1}.${G.scene + 1} ${r}`; reached[k] = (reached[k] || 0) + 1; break; }
      if (G.stage === 'victory') { wins++; break; }
      if (G.stage === 'camp') R.leaveCamp(G);
      R.startScene(G, rng);
    }
  }
  console.log(line.join('+').padEnd(44), `wins ${wins}/${N}`, `rounds/scene ${(rounds / scenes).toFixed(1)}`, `downs/scene ${(downs / scenes).toFixed(2)}`, JSON.stringify(reached));
}
