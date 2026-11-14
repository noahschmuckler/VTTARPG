// Grid helpers: tiles, neighbours, paths, reach and line of sight. Pure functions, no DOM.
// A map is { w, h, tiles: [{ e, kind: 'floor' | 'chasm', floor, rough, prop }] } indexed y * w + x.
// e = elevation level (0–3). Props may block movement (`block`) and sight (`tall`).

export const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
export const key = (x, y) => `${x},${y}`;
export const inside = (m, x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h;
export const tile = (m, x, y) => (inside(m, x, y) ? m.tiles[y * m.w + x] : null);
export const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); // squares, diagonals count 1
export const adjacent = (a, b) => dist(a, b) === 1;
export const standable = t => !!t && t.kind === 'floor' && !t.prop?.block;

// One step from a to b. Returns its cost, or Infinity. `occ(x, y)` says a unit stands there.
export function stepCost(m, a, b, occ, opts = {}) {
  const tb = tile(m, b.x, b.y), ta = tile(m, a.x, a.y);
  if (!standable(tb) || occ(b.x, b.y)) return Infinity;
  if (opts.forbid && opts.forbid(b.x, b.y)) return Infinity;
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx && dy) { // no squeezing diagonally past a blocked corner
    const c1 = tile(m, a.x + dx, a.y), c2 = tile(m, a.x, a.y + dy);
    if (!standable(c1) || !standable(c2)) return Infinity;
    if (Math.abs(c1.e - ta.e) > 1 || Math.abs(c2.e - ta.e) > 1) return Infinity;
  }
  const climb = tb.e - ta.e;
  if (Math.abs(climb) > 1) return Infinity; // ledges taller than one level need a leap, grapple or teleport
  return 1 + (tb.rough ? 1 : 0) + (climb > 0 ? 1 : 0);
}

// Dijkstra from `from` with a budget. Returns Map key → { x, y, cost, prev }.
export function reachable(m, from, budget, occ, opts = {}) {
  const out = new Map([[key(from.x, from.y), { x: from.x, y: from.y, cost: 0, prev: null }]]);
  const open = [out.get(key(from.x, from.y))];
  while (open.length) {
    open.sort((p, q) => p.cost - q.cost);
    const cur = open.shift();
    for (const [dx, dy] of DIRS8) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const c = cur.cost + stepCost(m, cur, { x: nx, y: ny }, occ, opts);
      if (c > budget) continue;
      const k = key(nx, ny), old = out.get(k);
      if (old && old.cost <= c) continue;
      const node = { x: nx, y: ny, cost: c, prev: cur };
      out.set(k, node);
      open.push(node);
    }
  }
  return out;
}
export function pathTo(nodes, x, y) {
  let n = nodes.get(key(x, y));
  if (!n) return null;
  const path = [];
  while (n) { path.unshift({ x: n.x, y: n.y }); n = n.prev; }
  return path;
}

// Path for a foe toward any tile satisfying goal(x, y); unlimited budget, then trimmed by the caller.
export function pathToGoal(m, from, goal, occ, opts = {}) {
  if (goal(from.x, from.y)) return [{ x: from.x, y: from.y }];
  const nodes = reachable(m, from, opts.budget ?? 60, occ, opts);
  let best = null;
  for (const n of nodes.values()) if (goal(n.x, n.y) && (!best || n.cost < best.cost)) best = n;
  if (!best) return null;
  return pathTo(nodes, best.x, best.y);
}

// Squares on the line between a and b (excluding both ends).
export function lineCells(a, b) {
  const out = [], n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 3;
  const seen = new Set([key(a.x, a.y), key(b.x, b.y)]);
  for (let i = 1; i < n; i++) {
    const t = i / n, x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
    const k = key(x, y);
    if (!seen.has(k)) { seen.add(k); out.push({ x, y }); }
  }
  return out;
}
// Sight is blocked by tall props (columns, stacked barrels) and by ground higher than both ends.
export function lineOfSight(m, a, b) {
  const ea = tile(m, a.x, a.y)?.e ?? 0, eb = tile(m, b.x, b.y)?.e ?? 0, top = Math.max(ea, eb);
  for (const c of lineCells(a, b)) {
    const t = tile(m, c.x, c.y);
    if (!t) return false;
    if (t.prop?.tall) return false;
    if (t.kind === 'floor' && t.e > top) return false;
  }
  return true;
}

// Unit vector (in grid steps) pointing from a to b, snapped to 8 directions.
export function dirFrom(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (!dx && !dy) return [1, 0];
  const ang = Math.atan2(dy, dx), i = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS8[i];
}

// Seedable RNG (mulberry32) so tests and saved runs can be replayed.
export function rngFrom(seed) {
  let s = seed >>> 0;
  const f = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.state = () => s;
  return f;
}
export const d6 = rng => 1 + Math.floor(rng() * 6);
