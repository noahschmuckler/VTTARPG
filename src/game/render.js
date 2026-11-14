// The isometric (3/4) view: Kenney tiles and props, Flare-format monsters, custom cliffs, effects and overlays.
// The renderer never decides anything: it shows the state, and plays the rules' effect list (G.fx) as tweens.
import { A, heroSheet } from './assets.js';
import { tile, key } from './grid.js';
import { HERO_COLOR } from './content.js';

export const HW = 64, HH = 37, EH = 30, DEPTH = 3;
const WALLS = ['stoneWall', 'stoneWall', 'stoneWallAged', 'stoneWallWindow', 'stoneWall', 'stoneWallColumn', 'stoneWallAged', 'stoneWallBroken', 'stoneWallWindowBars', 'stoneWall', 'stoneWallHole'];
const BOLT = { arcanist: '#ff9a3d', runepriest: '#5fd3c4', ranger: '#e9e2d0', arrow: '#e9e2d0', lightning: '#9fd0ff', hammer: '#5fd3c4' };
const ease = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

export class View {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.disp = new Map();
    this.tw = [];          // running tweens
    this.vfx = [];         // particles, bolts, rings
    this.texts = [];       // floating numbers
    this.hl = {};          // overlays set by the controller
    this.time = 0;
    this.shake = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    const r = devicePixelRatio || 1;
    this.dpr = r;
    this.c.width = Math.round(innerWidth * r);
    this.c.height = Math.round(innerHeight * r);
    this.c.style.width = innerWidth + 'px';
    this.c.style.height = innerHeight + 'px';
  }
  // ------------------------------------------------------------ setup
  attach(G) {
    this.G = G;
    this.disp.clear();
    this.vfx = []; this.texts = []; this.tw = [];
    this.ensure('hero');
    for (const f of G.foes) if (!f.dead) this.ensure(f.id);
    // fit most of the map on screen, then look at the hero
    const span = (G.map.w + G.map.h) * HW;
    this.cam.zoom = Math.max(0.5, Math.min(0.9, innerWidth / (span * 0.7), innerHeight / (span * 0.48)));
    const mid = { x: (G.pos.x + G.map.w / 2) / 2, y: (G.pos.y + G.map.h / 2) / 2 };
    const t = this.iso(mid.x, mid.y, 0);
    this.cam.x = t.x; this.cam.y = t.y;
  }
  unit(id) { return id === 'hero' ? { ...this.G.pos, hero: true } : this.G.foes.find(f => f.id === id); }
  ensure(id) {
    if (this.disp.has(id)) return this.disp.get(id);
    const u = this.unit(id);
    if (!u) return null;
    const e = this.elev(u.x, u.y);
    const d = { id, x: u.x, y: u.y, e, dir: id === 'hero' ? 5 : 1, anim: 'idle', at: Math.random() * 3, once: null, alpha: 1, flash: 0, sink: 0, hp: u.hp, maxHp: u.maxHp, hero: id === 'hero' };
    this.disp.set(id, d);
    return d;
  }
  elev(x, y) { const t = tile(this.G.map, Math.round(x), Math.round(y)); return t ? (t.kind === 'chasm' ? -1.2 : t.e) : 0; }
  iso(x, y, e = 0) { return { x: (x - y) * HW, y: (x + y) * HH - e * EH }; }
  centerOn(p, now = false) {
    const t = this.iso(p.x, p.y, this.elev(p.x, p.y));
    if (now) { this.cam.x = t.x; this.cam.y = t.y; return; }
    const sx = this.cam.x, sy = this.cam.y;
    this.tween(0.35, k => { this.cam.x = sx + (t.x - sx) * ease(k); this.cam.y = sy + (t.y - sy) * ease(k); });
  }
  // world → canvas pixels
  toScreen(wx, wy) {
    const z = this.cam.zoom * this.dpr;
    return { x: (wx - this.cam.x) * z + this.c.width / 2, y: (wy - this.cam.y) * z + this.c.height / 2 };
  }
  toWorld(px, py) {
    const z = this.cam.zoom * this.dpr;
    return { x: (px * this.dpr - this.c.width / 2) / z + this.cam.x, y: (py * this.dpr - this.c.height / 2) / z + this.cam.y };
  }
  // Which square is under the pointer (front squares win, raised tops included)?
  pick(px, py) {
    const G = this.G; if (!G?.map) return null;
    const w = this.toWorld(px, py);
    const m = G.map;
    let best = null;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      const t = tile(m, x, y), e = t.kind === 'chasm' ? 0 : t.e;
      const c = this.iso(x, y, e);
      const dx = Math.abs(w.x - c.x) / HW, dy = Math.abs(w.y - c.y) / HH;
      if (dx + dy <= 1 && (!best || x + y > best.x + best.y)) best = { x, y };
    }
    // also allow clicking a unit's body
    for (const d of this.disp.values()) {
      if (d.alpha < 0.3) continue;
      const c = this.iso(d.x, d.y, d.e);
      if (Math.abs(w.x - c.x) < 22 && w.y < c.y + 10 && w.y > c.y - 70) {
        const rx = Math.round(d.x), ry = Math.round(d.y);
        if (!best || rx + ry >= best.x + best.y - 1) best = { x: rx, y: ry };
      }
    }
    return best;
  }
  pan(dx, dy) { this.cam.x -= dx / this.cam.zoom; this.cam.y -= dy / this.cam.zoom; }
  zoomBy(f) { this.cam.zoom = Math.max(0.45, Math.min(1.8, this.cam.zoom * f)); }

  // ------------------------------------------------------------ tweens
  tween(dur, fn, done) {
    return new Promise(res => this.tw.push({ t: 0, dur, fn, done: () => { done && done(); res(); } }));
  }
  wait(s) { return this.tween(s, () => {}); }
  update(dt) {
    this.time += dt;
    for (const t of [...this.tw]) {
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      t.fn(k);
      if (k >= 1) { this.tw.splice(this.tw.indexOf(t), 1); t.done(); }
    }
    for (const d of this.disp.values()) {
      d.at += dt;
      if (d.flash > 0) d.flash = Math.max(0, d.flash - dt * 3);
      if (d.once && d.at > d.once.dur) { if (d.once.hold) { d.at = d.once.dur - 0.0001; } else { d.anim = 'idle'; d.once = null; } }
    }
    this.vfx = this.vfx.filter(v => (v.t += dt) < v.dur);
    this.texts = this.texts.filter(v => (v.t += dt) < v.dur);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2);
  }
  // ------------------------------------------------------------ playing effects
  // Plays one rules effect; resolves when the next one may start.
  async play(e) {
    const G = this.G;
    switch (e.t) {
      case 'spawn': { const d = this.ensure(e.id); if (d) { d.alpha = 0; this.tween(0.4, k => { d.alpha = k; }); this.ring(d, '#c33', 0.5); } return this.wait(0.04); }
      case 'move': return this.move(e);
      case 'face': { const d = this.ensure(e.id); if (d) d.dir = this.dirTo(d, e.at); return; }
      case 'anim': {
        const d = this.ensure(e.id); if (!d) return;
        if (e.face) d.dir = this.dirTo(d, e.face);
        this.once(d, e.a === 'attack' ? 'attack' : 'act', 0.45);
        return this.wait(e.id === 'hero' ? 0.18 : 0.28);
      }
      case 'dmg': {
        const d = this.ensure(e.id); if (!d) return;
        d.flash = 1;
        if (e.id !== 'hero') { const f = this.unit(e.id); d.hp = Math.max(0, (d.hp ?? f.hp) - (f.type === 'minion' ? 1 : e.n)); }
        const txt = e.id === 'hero' ? (e.n ? `-${fmt(e.n)}` : (e.warded ? 'Warded' : '0')) : (this.unit(e.id)?.type === 'minion' ? (e.crit ? 'CRIT' : '') : fmt(e.n));
        if (txt) this.float(d, txt, e.id === 'hero' ? '#ff5a4a' : e.crit ? '#ffd24a' : '#fff', e.crit ? 1.5 : 1.1);
        if (e.label) this.float(d, e.label, '#ffb08a', 0.8, -18);
        if (e.id === 'hero' && e.n) this.shake = Math.min(1, 0.3 + e.n / 1500);
        if (e.id !== 'hero' && d.anim === 'idle') this.once(d, 'hit', 0.25);
        return this.wait(0.12);
      }
      case 'heal': { const d = this.ensure(e.id); if (d) { this.float(d, `+${fmt(e.n)}`, '#7ee07e', 1.1); if (e.id !== 'hero') d.hp = Math.min(d.maxHp, d.hp + e.n); this.ring(d, '#7ee07e', 0.6); } return this.wait(0.1); }
      case 'ward': { const d = this.ensure('hero'); this.float(d, `+${fmt(e.n)} ward`, '#f3d98e', 1); this.ring(d, '#f3d98e', 0.7); return this.wait(0.1); }
      case 'text': { const d = this.ensure(e.id); if (d) this.float(d, e.text, e.color || '#fff', 0.9); return this.wait(0.05); }
      case 'die': {
        const d = this.ensure(e.id); if (!d) return;
        d.hp = 0;
        this.once(d, 'die', 0.7, true);
        this.tween(1.4, k => { if (k > 0.55) d.alpha = Math.min(d.alpha, 1 - (k - 0.55) / 0.45); }, () => { if (e.id !== 'hero') this.disp.delete(e.id); });
        return this.wait(0.15);
      }
      case 'fall': {
        const d = this.ensure(e.id); if (!d) return;
        return this.tween(0.45, k => { d.sink = k * (e.id === 'hero' ? 26 : 60); if (e.id !== 'hero') d.alpha = 1 - k; });
      }
      case 'bolt': return this.bolt(e);
      case 'burst': return this.burst(e);
      case 'hide': { const d = this.ensure('hero'); this.puff(d, '#776f88'); return this.wait(0.15); }
      default: return;
    }
  }
  once(d, anim, dur, hold = false) { d.anim = anim; d.at = 0; d.once = { dur, hold }; }
  dirTo(from, to) {
    const a = this.iso(from.x, from.y), b = this.iso(to.x, to.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    return ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  }
  async move(e) {
    const d = this.ensure(e.id);
    if (!d || !e.path || e.path.length < 2) { if (d && e.path?.length) { d.x = e.path[0].x; d.y = e.path[0].y; } return; }
    const follow = e.id === 'hero';
    if (e.kind === 'walk') {
      for (let i = 1; i < e.path.length; i++) {
        const a = e.path[i - 1], b = e.path[i], ea = this.elev(a.x, a.y), eb = this.elev(b.x, b.y);
        d.dir = this.dirTo(a, b); d.anim = 'run'; d.once = null;
        await this.tween(e.id === 'hero' ? 0.17 : 0.13, k => { d.x = a.x + (b.x - a.x) * k; d.y = a.y + (b.y - a.y) * k; d.e = ea + (eb - ea) * k + (eb > ea ? Math.sin(k * Math.PI) * 0.4 : 0); });
      }
      d.anim = 'idle';
    } else if (e.kind === 'leap') {
      const a = e.path[0], b = e.path[e.path.length - 1], ea = this.elev(a.x, a.y), eb = this.elev(b.x, b.y);
      d.dir = this.dirTo(a, b); this.once(d, 'act', 0.5);
      await this.tween(0.45, k => { d.x = a.x + (b.x - a.x) * k; d.y = a.y + (b.y - a.y) * k; d.e = ea + (eb - ea) * k + Math.sin(k * Math.PI) * 2.2; });
      this.puff(d, '#c9a77a');
    } else if (e.kind === 'blink') {
      const b = e.path[e.path.length - 1];
      this.puff(d, '#b88cff');
      await this.tween(0.12, k => { d.alpha = 1 - k; });
      d.x = b.x; d.y = b.y; d.e = this.elev(b.x, b.y);
      this.puff(d, '#b88cff');
      await this.tween(0.15, k => { d.alpha = k; });
    } else { // push / pull: a hard slide
      const a = e.path[0], b = e.path[e.path.length - 1], ea = this.elev(a.x, a.y), eb = this.elev(b.x, b.y);
      await this.tween(0.22, k => { const q = 1 - (1 - k) ** 2; d.x = a.x + (b.x - a.x) * q; d.y = a.y + (b.y - a.y) * q; d.e = ea + (eb - ea) * q; });
    }
    const end = e.path[e.path.length - 1];
    d.x = end.x; d.y = end.y; d.e = this.elev(end.x, end.y); d.sink = 0;
    if (follow) this.centerOn(end);
  }
  bolt(e) {
    const color = BOLT[e.cls] || '#fff';
    const a = this.iso(e.from.x, e.from.y, this.elev(e.from.x, e.from.y)), b = this.iso(e.to.x, e.to.y, this.elev(e.to.x, e.to.y));
    a.y -= 40; b.y -= 30;
    const v = { kind: e.cls === 'lightning' ? 'zap' : (e.cls === 'arrow' || e.cls === 'ranger') ? 'arrow' : 'orb', a, b, color, t: 0, dur: e.cls === 'lightning' ? 0.35 : 0.3 };
    this.vfx.push(v);
    return this.wait(e.cls === 'lightning' ? 0.12 : 0.22);
  }
  burst(e) {
    const c = this.iso(e.at.x, e.at.y, this.elev(e.at.x, e.at.y));
    const r = e.radius || 1;
    if (e.kind === 'meteor') {
      this.vfx.push({ kind: 'meteor', c, r, t: 0, dur: 0.9 });
      setTimeout(() => { this.shake = 0.9; }, 450);
      return this.wait(0.55);
    }
    const colors = { quake: '#c9a77a', circle: '#5fd3c4', well: '#9b6bff', smoke: '#6c6680', throes: '#7bd35a' };
    this.vfx.push({ kind: 'ring', c, r, color: colors[e.kind] || '#fff', t: 0, dur: e.kind === 'circle' ? 0.9 : 0.6, fill: e.kind === 'smoke' || e.kind === 'throes' });
    if (e.kind === 'quake' || e.kind === 'throes') this.shake = 0.7;
    if (e.kind === 'smoke') for (let i = 0; i < 3; i++) this.puff({ x: e.at.x + (Math.random() - 0.5), y: e.at.y + (Math.random() - 0.5), e: this.elev(e.at.x, e.at.y) }, '#6c6680');
    return this.wait(0.3);
  }
  ring(d, color, dur) { this.vfx.push({ kind: 'ring', c: this.iso(d.x, d.y, d.e), r: 0.6, color, t: 0, dur }); }
  puff(d, color) { this.vfx.push({ kind: 'puff', c: this.iso(d.x, d.y, d.e), color, t: 0, dur: 0.5, seed: Math.random() * 10 }); }
  float(d, text, color, size = 1, dy = 0) {
    const c = this.iso(d.x, d.y, d.e);
    this.texts.push({ x: c.x + (Math.random() - 0.5) * 16, y: c.y - 80 + dy, text, color, size, t: 0, dur: 1.1 });
  }

  // ------------------------------------------------------------ drawing
  draw() {
    const G = this.G, g = this.g, W = this.c.width, H = this.c.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const bg = g.createRadialGradient(W / 2, H * 0.45, 50, W / 2, H / 2, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#2a211a'); bg.addColorStop(1, '#0b0907');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    if (!G?.map) return;
    const z = this.cam.zoom * this.dpr;
    const sh = this.shake ? (Math.random() - 0.5) * this.shake * 10 : 0;
    g.setTransform(z, 0, 0, z, W / 2 - this.cam.x * z + sh, H / 2 - this.cam.y * z + sh * 0.6);
    g.imageSmoothingQuality = 'high';
    const m = G.map;
    // units by the square they stand on
    const at = new Map();
    for (const d of this.disp.values()) {
      const k = key(Math.round(d.x), Math.round(d.y));
      (at.get(k) || at.set(k, []).get(k)).push(d);
    }
    for (let s = 0; s <= m.w + m.h - 2; s++) {
      for (let x = Math.max(0, s - m.h + 1); x <= Math.min(s, m.w - 1); x++) {
        const y = s - x, t = tile(m, x, y);
        if (y === 0) this.wallAt(x, y, t, 'north');
        if (x === 0) this.wallAt(x, y, t, 'west');
        this.drawTile(x, y, t);
        const list = at.get(key(x, y));
        if (list) for (const d of list.sort((p, q) => p.x + p.y - q.x - q.y)) this.drawUnit(d);
      }
    }
    this.drawZone();
    for (const v of this.vfx) this.drawVfx(v);
    // floating text on top
    for (const t of this.texts) {
      const k = t.t / t.dur;
      g.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      g.font = `700 ${Math.round(18 * t.size)}px "Cinzel", Georgia, serif`;
      g.textAlign = 'center';
      g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.strokeText(t.text, t.x, t.y - k * 40);
      g.fillStyle = t.color; g.fillText(t.text, t.x, t.y - k * 40);
      g.globalAlpha = 1;
    }
  }
  img(name, x, y) {
    const im = A.tiles[name], M = A.manifest.tiles[name];
    if (!im) return;
    this.g.drawImage(im, x + M[2], y + M[3], M[0], M[1]);
  }
  wallAt(x, y, t, side) {
    const G = this.G, m = G.map;
    if (t.kind === 'chasm' && t.e === 0 && side) { /* walls still stand over chasms at the edge */ }
    const e = t.kind === 'chasm' ? 0 : t.e;
    const c = this.iso(x, y, e);
    const gate = G.map.spawns.find(s => s.x === x && s.y === y && ((side === 'north' && s.y === 0) || (side === 'west' && s.x === 0)));
    const i = side === 'north' ? x : y + 5;
    const base = gate ? 'stoneWallGateOpen' : WALLS[(i * 7 + m.w) % WALLS.length];
    this.img(`${base}_${side === 'north' ? 'S' : 'E'}`, c.x, c.y);
  }
  face(pts, fill) { const g = this.g; g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } }
  drawTile(x, y, t) {
    const g = this.g, m = this.G.map;
    if (t.kind === 'chasm') {
      const c = this.iso(x, y, 0);
      this.face([c.x - HW, c.y, c.x, c.y - HH, c.x + HW, c.y, c.x, c.y + HH], 'rgba(0,0,0,0.55)');
      g.save(); g.globalAlpha = 0.25 + 0.1 * Math.sin(this.time * 1.3 + x + y);
      this.face([c.x - HW * 0.6, c.y + 6, c.x, c.y - HH * 0.6 + 6, c.x + HW * 0.6, c.y + 6, c.x, c.y + HH * 0.6 + 6], 'rgba(120,60,30,0.25)');
      g.restore();
      this.overlayAt(x, y, 0);
      return;
    }
    const c = this.iso(x, y, t.e);
    if (t.bridge) { // planks over the void: no cliff under them
      this.face([c.x - HW, c.y, c.x, c.y - HH, c.x + HW, c.y, c.x, c.y + HH], 'rgba(0,0,0,0.55)');
      this.img(`${t.floor}_${t.d}`, c.x, c.y);
      this.overlayAt(x, y, t.e);
      return;
    }
    // cliff faces toward the viewer (custom: brick pattern sheared onto each side)
    const below = (nx, ny) => { const n = tile(m, nx, ny); return !n || n.kind === 'chasm' ? -DEPTH : n.e; };
    const dl = t.e - below(x, y + 1), dr = t.e - below(x + 1, y);
    if (dl > 0) this.cliff(c.x - HW, c.y, c.x, c.y + HH, dl * EH, 0.62, below(x, y + 1) === -DEPTH);
    if (dr > 0) this.cliff(c.x, c.y + HH, c.x + HW, c.y, dr * EH, 0.45, below(x + 1, y) === -DEPTH);
    this.img(`${t.floor}_${t.d}`, c.x, c.y);
    if (t.e > 0) { // a lighter rim so raised ground reads at a glance
      g.strokeStyle = 'rgba(255,240,200,0.18)'; g.lineWidth = 1.5;
      this.face([c.x - HW, c.y, c.x, c.y - HH, c.x + HW, c.y, c.x, c.y + HH]); g.stroke();
    }
    this.overlayAt(x, y, t.e);
    if (this.G.map.exit.x === x && this.G.map.exit.y === y && this.G.cleared) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 3);
      this.face([c.x - HW, c.y, c.x, c.y - HH, c.x + HW, c.y, c.x, c.y + HH], `rgba(255,200,90,${0.15 + pulse * 0.2})`);
      this.img('stairsSpiral_S', c.x, c.y);
    }
    if (t.prop) {
      this.img(`${t.prop.k}_${t.prop.d}`, c.x, c.y);
      const ch = t.prop.chest && this.G.map.chests.find(q => q.x === x && q.y === y);
      if (ch && !ch.opened) { // a glint on unopened chests
        const p = 0.5 + 0.5 * Math.sin(this.time * 4 + x);
        g.fillStyle = `rgba(255,230,140,${0.3 + p * 0.5})`;
        g.beginPath(); g.arc(c.x + 6, c.y - 24, 2 + p * 2, 0, 7); g.fill();
      }
    }
  }
  cliff(x1, y1, x2, y2, h, light, abyss) {
    const g = this.g;
    g.save();
    this.face([x1, y1, x2, y2, x2, y2 + h, x1, y1 + h]);
    g.clip();
    const slope = (y2 - y1) / (x2 - x1);
    g.setTransform(g.getTransform().multiply(new DOMMatrix([1, slope, 0, 1, x1, y1])));
    g.fillStyle = g.createPattern(A.brick, 'repeat');
    g.fillRect(0, 0, x2 - x1, h + 40);
    g.restore();
    g.save();
    this.face([x1, y1, x2, y2, x2, y2 + h, x1, y1 + h]);
    g.clip();
    const grd = g.createLinearGradient(0, Math.min(y1, y2), 0, Math.max(y1, y2) + h);
    grd.addColorStop(0, `rgba(30,20,10,${1 - light})`);
    grd.addColorStop(1, abyss ? 'rgba(11,9,7,1)' : `rgba(30,20,10,${Math.min(1, 1.25 - light)})`);
    g.fillStyle = grd;
    g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1) + h);
    g.restore();
  }
  // highlight overlays: move range, power targets, area previews, path, hover
  overlayAt(x, y, e) {
    const hl = this.hl, k = key(x, y), c = this.iso(x, y, e), g = this.g;
    const dia = (fill, stroke, s = 0.92) => {
      this.face([c.x - HW * s, c.y, c.x, c.y - HH * s, c.x + HW * s, c.y, c.x, c.y + HH * s], fill);
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2; g.stroke(); }
    };
    if (hl.move?.has(k)) dia(hl.moveColor || 'rgba(90,170,255,0.20)', 'rgba(140,200,255,0.35)');
    if (hl.reach?.has(k)) dia('rgba(255,80,60,0.13)', null);
    if (hl.targets?.has(k)) dia('rgba(255,200,80,0.25)', 'rgba(255,210,120,0.6)');
    if (hl.area?.has(k)) dia('rgba(255,120,60,0.35)', 'rgba(255,150,90,0.8)');
    if (hl.picked?.has(k)) dia('rgba(255,230,120,0.45)', '#ffe08a');
    if (hl.path?.has(k)) { g.fillStyle = hl.pathDanger?.has(k) ? '#ff6a4a' : '#bfe0ff'; g.beginPath(); g.ellipse(c.x, c.y, 7, 4, 0, 0, 7); g.fill(); }
    if (hl.hover && hl.hover.x === x && hl.hover.y === y) dia(null, hl.hoverColor || 'rgba(255,255,255,0.8)', 0.96);
  }
  drawZone() {
    const z = this.G.zone; if (!z || z.round !== this.G.round) return;
    const c = this.iso(z.x, z.y, this.elev(z.x, z.y)), g = this.g;
    g.save(); g.strokeStyle = 'rgba(95,211,196,0.75)'; g.lineWidth = 3; g.setLineDash([10, 8]); g.lineDashOffset = -this.time * 20;
    g.beginPath(); g.ellipse(c.x, c.y, (z.r + 0.5) * HW * 1.42, (z.r + 0.5) * HH * 1.42, 0, 0, 7); g.stroke(); g.restore();
  }
  drawUnit(d) {
    const G = this.G, g = this.g;
    const u = this.unit(d.id);
    const isHero = d.id === 'hero';
    const sheetName = isHero ? 'hero' : u?.sprite || 'orc';
    const M = A.manifest.units[sheetName];
    const img = isHero ? heroSheet(G.hero.cls) : A.units[sheetName];
    const c = this.iso(d.x, d.y, d.e);
    c.y += d.sink;
    const scale = isHero ? 1.35 : (u?.scale || 1) * 1.05;
    let alpha = d.alpha * (isHero && G.hidden ? 0.45 : 1);
    if (isHero && G.pit) c.y += 6;
    // shadow + ring
    g.save();
    g.globalAlpha = alpha;
    const ringR = isHero ? 22 : 18 * (u?.scale || 1);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(c.x, c.y, ringR, ringR * 0.55, 0, 0, 7); g.fill();
    const rc = isHero ? HERO_COLOR[G.hero.cls] : u?.type === 'boss' ? '#ff4a3a' : u?.type === 'elite' ? '#ffb347' : null;
    if (rc && !(this.hl.foeHover === d.id)) { g.strokeStyle = rc; g.globalAlpha = alpha * 0.8; g.lineWidth = 2; g.beginPath(); g.ellipse(c.x, c.y, ringR, ringR * 0.55, 0, 0, 7); g.stroke(); }
    if (this.hl.inReach?.has(d.id)) { g.strokeStyle = '#ff5a4a'; g.lineWidth = 2.5; g.globalAlpha = alpha * (0.6 + 0.4 * Math.sin(this.time * 6)); g.beginPath(); g.ellipse(c.x, c.y, ringR + 4, (ringR + 4) * 0.55, 0, 0, 7); g.stroke(); }
    g.globalAlpha = alpha;
    // the sprite frame
    let anim = M.anims[d.anim] ? d.anim : (d.anim === 'attack' || d.anim === 'act') ? (M.anims.attack ? 'attack' : 'act') : 'idle';
    if (!M.anims[anim]) anim = 'idle';
    const [start, count] = M.anims[anim];
    const fps = anim === 'run' ? (isHero ? 22 : 14) : anim === 'idle' ? 5 : anim === 'die' ? count / 0.7 : count / 0.45;
    let fi = Math.floor(d.at * fps);
    fi = d.once ? Math.min(count - 1, fi) : fi % count;
    const row = ((M.base - d.dir) % 8 + 8) % 8;
    const sx = (start + fi) * M.fw, sy = row * M.fh;
    const dw = M.fw * scale, dh = M.fh * scale;
    const bob = anim === 'idle' && isHero ? Math.sin(d.at * 2) * 0.6 : 0;
    const dx = c.x - M.ax * scale, dy = c.y - M.ay * scale + bob;
    g.drawImage(img, sx, sy, M.fw, M.fh, dx, dy, dw, dh);
    if (d.flash > 0) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = alpha * d.flash * 0.7;
      g.drawImage(img, sx, sy, M.fw, M.fh, dx, dy, dw, dh);
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();
    // bars and badges
    if (d.alpha < 0.5) return;
    const top = c.y - (isHero ? 92 : Math.min(140, 62 * (u?.scale || 1) + 20));
    if (!isHero && u && !u.dead) {
      const big = u.type !== 'minion';
      const w = big ? 64 : 30, hp = d.hp ?? u.hp;
      g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(c.x - w / 2 - 1, top - 1, w + 2, big ? 7 : 5);
      g.fillStyle = u.type === 'boss' ? '#d8352a' : u.type === 'elite' ? '#e8902a' : '#c44';
      g.fillRect(c.x - w / 2, top, w * Math.max(0, hp / u.maxHp), big ? 5 : 3);
      const badges = [u.pinned && '📌', u.enraged && '♨'].filter(Boolean).join('');
      if (big || badges) {
        g.font = '600 11px "Cinzel", Georgia, serif'; g.textAlign = 'center';
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.8)';
        const label = (big ? u.name : '') + (badges ? ' ' + badges : '');
        g.strokeText(label, c.x, top - 4); g.fillStyle = u.type === 'boss' ? '#ffb0a0' : '#ffe0b0'; g.fillText(label, c.x, top - 4);
      }
    }
    if (isHero) {
      const s = this.G.hero;
      const badges = [G.hidden && '👁', G.pit && '🕳', s.ward > 0 && '🛡'].filter(Boolean).join(' ');
      if (badges) { g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText(badges, c.x, top); }
    }
  }
  drawVfx(v) {
    const g = this.g, k = v.t / v.dur;
    g.save();
    if (v.kind === 'ring') {
      const r = (0.4 + k * (v.r + 0.6)) * HW * 1.2;
      g.globalAlpha = 1 - k;
      g.strokeStyle = v.color; g.lineWidth = 4 * (1 - k) + 1;
      g.beginPath(); g.ellipse(v.c.x, v.c.y, r, r * 0.58, 0, 0, 7); g.stroke();
      if (v.fill) { g.fillStyle = v.color; g.globalAlpha = (1 - k) * 0.35; g.fill(); }
    } else if (v.kind === 'puff') {
      for (let i = 0; i < 7; i++) {
        const a = v.seed + i * 0.9, rr = 8 + k * 26;
        g.globalAlpha = (1 - k) * 0.5; g.fillStyle = v.color;
        g.beginPath(); g.arc(v.c.x + Math.cos(a) * rr, v.c.y - 20 + Math.sin(a) * rr * 0.6 - k * 14, 9 * (1 - k * 0.5), 0, 7); g.fill();
      }
    } else if (v.kind === 'arrow' || v.kind === 'orb') {
      const q = Math.min(1, k / 0.75);
      const x = v.a.x + (v.b.x - v.a.x) * q, y = v.a.y + (v.b.y - v.a.y) * q - Math.sin(q * Math.PI) * (v.kind === 'arrow' ? 18 : 6);
      if (v.kind === 'arrow') {
        const ang = Math.atan2(v.b.y - v.a.y, v.b.x - v.a.x);
        g.translate(x, y); g.rotate(ang);
        g.strokeStyle = v.color; g.lineWidth = 2; g.globalAlpha = q < 1 ? 1 : 0;
        g.beginPath(); g.moveTo(-16, 0); g.lineTo(6, 0); g.stroke();
        g.fillStyle = v.color; g.beginPath(); g.moveTo(9, 0); g.lineTo(3, -3); g.lineTo(3, 3); g.fill();
      } else {
        const grd = g.createRadialGradient(x, y, 0, x, y, 16);
        grd.addColorStop(0, '#fff'); grd.addColorStop(0.3, v.color); grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = q < 1 ? 1 : 1 - (k - 0.75) / 0.25; g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, q < 1 ? 16 : 16 + (k - 0.75) * 120, 0, 7); g.fill();
      }
    } else if (v.kind === 'zap') {
      g.strokeStyle = v.color; g.lineWidth = 3; g.globalAlpha = 1 - k; g.shadowColor = v.color; g.shadowBlur = 12;
      g.beginPath(); g.moveTo(v.a.x, v.a.y - 30);
      for (let i = 1; i <= 6; i++) { const q = i / 6; g.lineTo(v.a.x + (v.b.x - v.a.x) * q + (i < 6 ? (Math.random() - 0.5) * 22 : 0), v.a.y - 30 + (v.b.y - v.a.y + 30) * q + (i < 6 ? (Math.random() - 0.5) * 22 : 0)); }
      g.stroke();
    } else if (v.kind === 'meteor') {
      const fallK = Math.min(1, k / 0.5);
      if (k < 0.5) {
        const x = v.c.x + 160 * (1 - fallK), y = v.c.y - 380 * (1 - fallK);
        const grd = g.createRadialGradient(x, y, 0, x, y, 30);
        grd.addColorStop(0, '#fff6c0'); grd.addColorStop(0.4, '#ff8a3d'); grd.addColorStop(1, 'rgba(255,60,0,0)');
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, 30, 0, 7); g.fill();
        g.strokeStyle = 'rgba(255,140,60,0.5)'; g.lineWidth = 10; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 60, y - 140); g.stroke();
      } else {
        const q = (k - 0.5) / 0.5, r = (v.r + 0.5) * HW * 1.4 * (0.3 + q * 0.7);
        const grd = g.createRadialGradient(v.c.x, v.c.y, 0, v.c.x, v.c.y, r);
        grd.addColorStop(0, `rgba(255,240,180,${1 - q})`); grd.addColorStop(0.5, `rgba(255,120,40,${0.8 * (1 - q)})`); grd.addColorStop(1, 'rgba(120,20,0,0)');
        g.fillStyle = grd; g.beginPath(); g.ellipse(v.c.x, v.c.y, r, r * 0.6, 0, 0, 7); g.fill();
      }
    }
    g.restore();
  }
}
export const fmt = n => Math.round(n).toLocaleString('en-US');
