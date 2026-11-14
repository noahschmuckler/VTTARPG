// Procedural battle maps: a walled diorama with raised platforms, chasms, pillars, clutter and rough ground.
// The viewer looks from the south-east corner of the grid ("front" = high x + y), so the hero enters at the
// front and the foes pour in through gates in the back walls.
import { tile, inside, standable, stepCost, reachable, key } from './grid.js';

const STYLES = {
  ruins: { floors: ['stone', 'dirt'], rough: ['stoneUneven', 'stoneMissingTiles', 'dirtTiles', 'stoneTile'], w: 16, h: 16 },
  hall: { floors: ['planks', 'stone'], rough: ['planksBroken', 'stoneMissingTiles'], w: 15, h: 15 },
  pits: { floors: ['dirt', 'stone'], rough: ['dirtTiles', 'stoneUneven'], w: 16, h: 16 },
  arena: { floors: ['stone', 'dirt'], rough: ['stoneUneven', 'stoneMissingTiles', 'stoneTile'], w: 17, h: 17 },
  chasm: { floors: ['stone', 'dirt'], rough: ['stoneUneven', 'dirtTiles'], w: 17, h: 16 },
};
const LOW = ['barrel', 'barrels', 'woodenCrate', 'woodenCrates', 'tableRound', 'tableShortChairs', 'tableRoundChairs', 'woodenPile', 'tableChairsBroken'];
const TALL = ['stoneColumn', 'stoneColumn', 'stoneColumnWood', 'barrelsStacked'];
const D = 'NESW';

export function generateMap(arena, rng, { chests = 1 } = {}) {
  const S = STYLES[arena] || STYLES.ruins;
  const w = S.w, h = S.h;
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const ri = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const [base, alt] = S.floors;
  const tiles = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push({ e: 0, kind: 'floor', floor: base, d: 'N', rough: false, prop: null });
  // patches of the second floor
  for (let i = 0, n = ri(3, 6); i < n; i++) {
    const cx = ri(0, w - 1), cy = ri(0, h - 1), r = ri(1, 3);
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (inside({ w, h }, x, y) && Math.hypot(x - cx, y - cy) <= r + 0.3) tiles[y * w + x].floor = alt;
  }
  const m = { w, h, tiles, arena, spawns: [], chests: [], start: { x: w - 3, y: h - 3 }, exit: { x: 1, y: Math.floor(h / 2) } };
  const T = (x, y) => tile(m, x, y);
  // keep clear: the hero's entry corner, the gates and the exit
  const keep = new Set();
  const keepAround = (cx, cy, r) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) keep.add(key(x, y)); };
  keepAround(m.start.x, m.start.y, 2);
  m.spawns = [{ x: Math.floor(w * 0.3), y: 0 }, { x: Math.floor(w * 0.75), y: 0 }, { x: 0, y: Math.floor(h * 0.3) }, { x: 0, y: Math.floor(h * 0.75) }];
  for (const s of m.spawns) keepAround(s.x, s.y, 1);
  keepAround(m.exit.x, m.exit.y, 1);
  const free = (x, y) => inside(m, x, y) && !keep.has(key(x, y));

  // chasms
  if (arena === 'chasm') {
    // a crack running corner to corner, crossed by two plank bridges
    const cx = Math.floor(w / 2) + ri(-1, 1);
    for (let y = 0; y < h; y++) {
      const off = Math.round(Math.sin(y / 3) * 1.5);
      for (let dx = -1; dx <= 1; dx++) { const x = cx + off + dx; if (free(x, y)) T(x, y).kind = 'chasm'; }
    }
    for (const by of [ri(2, Math.floor(h / 2) - 2), ri(Math.floor(h / 2) + 1, h - 3)]) {
      for (let x = 0; x < w; x++) if (T(x, by).kind === 'chasm') Object.assign(T(x, by), { kind: 'floor', floor: 'bridge', d: 'E', e: 0, bridge: true });
    }
  } else if (arena === 'pits' || arena === 'ruins') {
    const n = arena === 'pits' ? ri(3, 5) : ri(0, 2);
    for (let i = 0; i < n; i++) {
      const px = ri(2, w - 5), py = ri(2, h - 5), pw = ri(2, 3), ph = ri(2, 3);
      for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) if (free(x, y) && rng() < 0.92) T(x, y).kind = 'chasm';
    }
  }
  // raised platforms (one level; sometimes a second level on top)
  const plats = arena === 'arena' ? 3 : arena === 'hall' ? 2 : ri(1, 3);
  for (let i = 0; i < plats; i++) {
    const pw = ri(3, 5), ph = ri(3, 4), px = ri(1, w - pw - 2), py = ri(1, h - ph - 2);
    for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) if (free(x, y) && T(x, y).kind === 'floor' && !T(x, y).bridge) T(x, y).e = 1;
    if (pw >= 4 && ph >= 3 && rng() < 0.6) {
      for (let y = py + 1; y < py + ph - 1; y++) for (let x = px + 1; x < px + pw - 1; x++) if (free(x, y) && T(x, y).e === 1) T(x, y).e = 2;
    }
  }
  if (arena === 'arena') { // the dais at the back for the boss
    for (let y = 1; y <= 3; y++) for (let x = Math.floor(w / 2) - 2; x <= Math.floor(w / 2) + 2; x++) if (free(x, y)) { T(x, y).e = Math.max(T(x, y).e, 1); T(x, y).kind = 'floor'; }
  }
  // rough ground
  const roughN = Math.floor(w * h * 0.07);
  for (let i = 0; i < roughN; i++) {
    const x = ri(0, w - 1), y = ri(0, h - 1), t = T(x, y);
    if (t.kind === 'floor' && !t.bridge && free(x, y)) { t.rough = true; t.floor = pick(S.rough); }
  }
  // props
  const place = (list, n, tall) => {
    for (let i = 0, tries = 0; i < n && tries < 200; tries++) {
      const x = ri(1, w - 2), y = ri(1, h - 2), t = T(x, y);
      if (!free(x, y) || t.kind !== 'floor' || t.prop || t.bridge || t.rough) continue;
      t.prop = { k: pick(list), d: pick(D), block: true, tall };
      i++;
    }
  };
  place(TALL, arena === 'arena' ? ri(6, 8) : ri(3, 6), true);
  place(LOW, ri(4, 8), false);
  // chests sit against the back half of the map
  for (let i = 0, tries = 0; i < chests && tries < 200; tries++) {
    const x = ri(1, w - 2), y = ri(1, Math.floor(h * 0.6)), t = T(x, y);
    if (!free(x, y) || !standable(t) || t.rough || t.bridge) continue;
    t.prop = { k: 'chestClosed', d: pick(['S', 'E']), block: true, tall: false, chest: true };
    m.chests.push({ x, y, opened: false });
    i++;
  }
  // the exit: a spiral stair in the west wall, shown once the scene is clear
  Object.assign(T(m.exit.x, m.exit.y), { kind: 'floor', e: 0, prop: null, rough: false });
  // gates and start are plain floor at ground level
  for (const s of [...m.spawns, m.start]) Object.assign(T(s.x, s.y), { kind: 'floor', e: 0, prop: null, rough: false });
  ensureConnected(m);
  return m;
}

// Every standable square must be reachable from the start; clear clutter or fill holes until it is.
function ensureConnected(m) {
  const none = () => false;
  for (let guard = 0; guard < 40; guard++) {
    const seen = reachable(m, m.start, 999, none);
    const lost = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const t = tile(m, x, y);
      if (t.kind === 'floor' && !seen.has(key(x, y))) lost.push({ x, y, t });
    }
    const chestLost = m.chests.some(c => !neighbours(m, c).some(n => seen.has(key(n.x, n.y))));
    if (!lost.some(l => !l.t.prop) && !chestLost) return;
    // try to open a route: flatten a lost square's step or remove the clutter next to the known region
    let fixed = false;
    for (const l of lost) {
      for (const n of neighbours(m, l)) {
        if (!seen.has(key(n.x, n.y))) continue;
        const tn = tile(m, n.x, n.y);
        if (l.t.prop && !l.t.prop.chest) { l.t.prop = null; fixed = true; break; }
        if (!l.t.prop && Math.abs(l.t.e - tn.e) > 1) { l.t.e = tn.e + Math.sign(l.t.e - tn.e); fixed = true; break; }
        if (!l.t.prop && stepCost(m, n, l, none) === Infinity) { l.t.e = tn.e; fixed = true; break; }
      }
    }
    if (!fixed) for (const l of lost) if (!l.t.prop) { l.t.kind = 'chasm'; fixed = true; }
    for (const c of m.chests) { // a chest needs an open side
      if (neighbours(m, c).some(n => seen.has(key(n.x, n.y)))) continue;
      for (const n of neighbours(m, c)) { const t = tile(m, n.x, n.y); if (t && t.kind === 'floor') { t.prop = null; t.e = tile(m, c.x, c.y).e; } }
      fixed = true;
    }
    if (!fixed) return;
  }
}
const neighbours = (m, p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).filter(q => inside(m, q.x, q.y));
