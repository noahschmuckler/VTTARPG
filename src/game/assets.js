// Loads the sprite manifest and images; makes per-calling tinted copies of the hero sheet,
// and paints the custom pieces the packs don't have (cliff faces, chasm mouths).
import { HERO_TINT } from './content.js';

export const A = { manifest: null, tiles: {}, units: {}, heroes: {}, brick: null, ready: false };

const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Failed to load ' + src)); im.src = src; });

export async function loadAssets(base = 'assets/', onProgress = () => {}) {
  const manifest = await (await fetch(base + 'manifest.json')).json();
  A.manifest = manifest;
  const jobs = [];
  for (const k of Object.keys(manifest.tiles)) jobs.push(['tiles', k, `${base}tiles/${k}.png`]);
  for (const k of Object.keys(manifest.units)) jobs.push(['units', k, `${base}units/${k}.png`]);
  let done = 0;
  await Promise.all(jobs.map(async ([kind, k, src]) => {
    A[kind][k] = await load(src);
    onProgress(++done / jobs.length);
  }));
  A.brick = makeBrick();
  A.ready = true;
  return A;
}

// The hero sheet, tinted for a calling (cached).
export function heroSheet(cls) {
  if (A.heroes[cls]) return A.heroes[cls];
  const src = A.units.hero, c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const g = c.getContext('2d');
  g.filter = HERO_TINT[cls] || 'none';
  g.drawImage(src, 0, 0);
  A.heroes[cls] = c;
  return c;
}

// Custom: a sandstone block pattern matching the Kenney floor palette, for the sides of raised ground.
function makeBrick() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#c9a77a';
  g.fillRect(0, 0, 64, 32);
  const rows = [[0, 0, 32, 16], [32, 0, 32, 16], [-16, 16, 32, 16], [16, 16, 32, 16], [48, 16, 32, 16]];
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const [x, y, w, h] of rows) {
    const l = 0.86 + rnd() * 0.2;
    g.fillStyle = `rgb(${Math.round(214 * l)},${Math.round(184 * l)},${Math.round(140 * l)})`;
    g.fillRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = 'rgba(255,240,210,0.35)';
    g.fillRect(x + 1, y + 1, w - 2, 2);
    g.fillStyle = 'rgba(80,50,20,0.25)';
    g.fillRect(x + 1, y + h - 3, w - 2, 2);
  }
  g.fillStyle = 'rgba(90,60,30,0.55)';
  g.fillRect(0, 15, 64, 2);
  g.fillRect(0, 31, 64, 1);
  for (const [x, y] of [[0, 0], [32, 0], [16, 16], [48, 16]]) g.fillRect(x, y, 1.5, 16);
  return c;
}
