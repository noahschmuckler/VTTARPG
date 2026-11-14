// Balance sim: a simple bot plays the whole campaign N times per class. Usage: node tools/sim.js [runs]
import * as R from '../src/game/rules.js';
import { rngFrom } from '../src/game/grid.js';
import { playScene } from './bot.js';
const N = Number(process.argv[2] || 20);
for (const cls of Object.keys(R.CLASSES)) {
  const reached = {}; let wins = 0, rounds = 0, scenes = 0;
  for (let i = 0; i < N; i++) {
    const rng = rngFrom(1000 + i * 7), G = R.newRun('Bot', cls, rng);
    let lives = 3;
    R.startScene(G, rng);
    for (;;) {
      const r = playScene(G, rng);
      rounds += G.round; scenes++;
      if (r === 'dead' && lives-- > 0) { R.retryScene(G, rng); continue; }
      if (r !== 'clear') { const k = `${G.act + 1}.${G.scene + 1} ${r}`; reached[k] = (reached[k] || 0) + 1; break; }
      if (G.stage === 'victory') { wins++; break; }
      if (G.stage === 'camp') R.leaveCamp(G);
      R.startScene(G, rng);
    }
  }
  console.log(cls.padEnd(12), `wins ${wins}/${N}`, `avg rounds/scene ${(rounds / scenes).toFixed(1)}`, JSON.stringify(reached));
}
