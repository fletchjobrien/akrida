import { BufferAttribute, Euler, InstancedMesh, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { rgb } from '../render/palette';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { rng } from '../core/math';
import { fromFrame, HIGH, HIGH_REACH, highlandHeight, highlandMask, inStation, PATH_LEN, pathAt, pathNear, pathWidth, ridgeA, toFrame } from './highlands';
import { PALETTE } from '../render/palette';
import { terrainHeight } from './terrain';
import { convexHull, makeRockGeometry, type Rocks } from './rocks';
import { hash01 } from './noise';
import type { Dust } from './particles';
import type { Wind } from './wind';
import type { AudioEngine } from '../audio/AudioEngine';

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const VARIANTS = 8;
const CAP = 720;
const PEBBLE = [rgb(PALETTE.rockDark).toArray(), rgb(PALETTE.rockMid).toArray(), rgb(0x463e3b).toArray()];
const DUST = rgb(PALETTE.sandShade).toArray();
const DUST_FADE = rgb(PALETTE.sandMid).toArray();
const STREAM = rgb(PALETTE.sandLit).toArray();
const STREAM_FADE = rgb(PALETTE.sandHi).toArray();

/** A rock big enough to matter: for pebbles to fall from, and the wind to strip. */
interface Crag {
  x: number;
  z: number;
  top: number;
  r: number;
}

/**
 * The mountain's rock, and what goes on among it. The rock is the desert's
 * own: the same boulders, made the same way, but huge, and piled up:
 *
 * - spires along the ridge behind the station, highest either side of it and
 *   lower just behind it, so the station sits in a notch of the ridge;
 * - a low wall of rock wrapped round the back and sides of the station;
 * - outcrops over the flanks, thicker high up and behind;
 * - boulders lining the footpath, and scree at the foot of everything.
 *
 * Then: the first sight of the mountain, its sound (wind moaning through the
 * rock, a low hum near the station), pebbles that now and then skitter down a
 * rock near the creature, a far-off rockfall now and then, sand streaming off
 * the spires in the wind.
 */
export class Highlands {
  justDiscovered = false;
  discovered = false;
  /** Where the creature looks when it first sees them: the tallest spire. */
  readonly lookPoint = new Vector3();
  private pebbleTimer = 4;
  private rockfallTimer = 30;
  private streamTimer = 1;
  readonly boulders: InstancedMesh[] = [];
  private readonly crags: Crag[] = [];
  private readonly spires: Crag[] = [];

  private readonly geos = Array.from({ length: VARIANTS }, (_, i) => makeRockGeometry(i + 11));
  /** Each rock's highest and lowest point (it is placed by these). */
  private readonly top: number[] = [];
  private readonly bottom: number[] = [];

  constructor(
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    rocks: Rocks,
  ) {
    // the same stone, lit the same way, as the rocks out in the desert
    const mat = toonMaterial({
      dark: PALETTE.rockDark,
      mid: PALETTE.rockMid,
      light: PALETTE.rockLight,
      litAt: 0.62,
      midAt: 0.05,
      outline: 0.55,
      // the creases catch the light more softly on rock this big
      highlight: 0.45,
    });
    for (const g of this.geos) {
      const pos = g.getAttribute('position') as BufferAttribute;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 0; i < pos.count; i++) {
        hi = Math.max(hi, pos.getY(i));
        lo = Math.min(lo, pos.getY(i));
      }
      this.top.push(hi);
      this.bottom.push(lo);
      const mesh = new InstancedMesh(g, mat, CAP);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.layers.enable(SHADOW_LAYER);
      this.boulders.push(mesh);
    }
    this.placing = this.raise(rocks);
  }

  /** The rock is raised a few milliseconds at a time, so starting up never stalls. */
  private placing: Generator<void> | null;

  addTo(scene: Object3D) {
    for (const m of this.boulders) scene.add(m);
  }

  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly eu = new Euler();
  private readonly p = new Vector3();
  private readonly sc = new Vector3();
  private readonly corner = new Vector3();
  private readonly w = { x: 0, z: 0 };
  private readonly fr = { a: 0, b: 0 };

  /**
   * Set one rock: its foot at height `y` (sunk by `sink` of its height), size
   * `s` across and `sy` high, leaning by `lx`, `lz`. Returns the height of
   * its top. Big ones are in the way.
   */
  private rock(rocks: Rocks, x: number, z: number, y: number, s: number, sy: number, sink: number, lx: number, lz: number, seed: number) {
    const rand = rng(seed);
    const v = Math.floor(rand() * VARIANTS);
    const mesh = this.boulders[v];
    if (mesh.count >= CAP) return y;
    const sx = s * (0.85 + rand() * 0.3);
    const sz = s * (0.85 + rand() * 0.3);
    const ht = (this.top[v] - this.bottom[v]) * sy;
    this.eu.set(lx, rand() * Math.PI * 2, lz, 'YXZ');
    this.q.setFromEuler(this.eu);
    this.p.set(x, y - this.bottom[v] * sy - ht * sink, z);
    this.sc.set(sx, sy, sz);
    this.m.compose(this.p, this.q, this.sc);
    mesh.setMatrixAt(mesh.count++, this.m);
    if (s > 0.45) {
      const pts: number[] = [];
      let radius = 0;
      const pos = this.geos[v].getAttribute('position');
      for (let i = 0; i < pos.count; i += 3) {
        this.corner.fromBufferAttribute(pos, i).applyMatrix4(this.m);
        pts.push(this.corner.x, this.corner.z);
        radius = Math.max(radius, Math.hypot(this.corner.x - x, this.corner.z - z));
      }
      rocks.addStatic({ x, z, radius, height: sy * 0.6, hull: convexHull(pts) });
    }
    const top = y + ht * (1 - sink);
    if (s > 1.6) this.crags.push({ x, z, top, r: s * 0.8 });
    return top;
  }

  /** Scree: small stones fallen round a rock's foot. */
  private scree(rocks: Rocks, x: number, z: number, reach: number, n: number, rand: () => number, seed: number) {
    for (let k = 0; k < n; k++) {
      const an = rand() * Math.PI * 2;
      const d = reach * (1 + rand() * 0.8);
      const sx = x + Math.cos(an) * d;
      const sz = z + Math.sin(an) * d;
      if (this.clear(sx, sz, 0.3)) continue;
      const s = 0.12 + rand() * rand() * 0.6;
      this.rock(rocks, sx, sz, terrainHeight(sx, sz), s, s * (0.6 + rand() * 0.5), 0.3, (rand() - 0.5) * 0.6, (rand() - 0.5) * 0.6, seed + k * 31);
    }
  }

  /** Kept clear of rock: the path and the station's ground. */
  private clear(x: number, z: number, margin: number) {
    toFrame(x, z, this.fr);
    if (inStation(this.fr.a, this.fr.b, margin)) return true;
    const n = pathNear(this.fr.a, this.fr.b);
    return n.d < pathWidth(n.s) + 0.4 + margin;
  }

  /**
   * A spire: a great boulder sunk in the ground, smaller ones stacked on it,
   * each taller for its width, up to about `height`; others leaning on its
   * foot, and scree round it.
   */
  private spire(rocks: Rocks, a: number, b: number, height: number, seed: number) {
    const rand = rng(seed);
    const { x, z } = fromFrame(a, b, this.w);
    if (this.clear(x, z, 4)) return;
    const g = terrainHeight(x, z);
    let s = Math.min(9, 3.2 + height * 0.28) * (0.85 + rand() * 0.3);
    let top = this.rock(rocks, x, z, g, s, s * (0.75 + rand() * 0.3), 0.3, (rand() - 0.5) * 0.25, (rand() - 0.5) * 0.25, seed);
    let cx = x;
    let cz = z;
    for (let k = 1; top < g + height && k < 6; k++) {
      s *= 0.62 + rand() * 0.14;
      cx += (rand() - 0.5) * s * 0.5;
      cz += (rand() - 0.5) * s * 0.5;
      const sy = s * (1.1 + rand() * 0.8);
      top = this.rock(rocks, cx, cz, top, s, sy, 0.38, (rand() - 0.5) * 0.35, (rand() - 0.5) * 0.35, seed + k * 101);
    }
    this.spires.push({ x: cx, z: cz, top, r: s });
    // others fallen against its foot, leaning in
    const base = Math.min(9, 3.2 + height * 0.28);
    const n = 3 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const an = rand() * Math.PI * 2;
      const d = base * (0.6 + rand() * 0.35);
      const fx = x + Math.cos(an) * d;
      const fz = z + Math.sin(an) * d;
      if (this.clear(fx, fz, 1)) continue;
      const fs = base * (0.35 + rand() * 0.3);
      // lean toward the spire
      const lean = 0.15 + rand() * 0.25;
      this.rock(rocks, fx, fz, terrainHeight(fx, fz), fs, fs * (0.7 + rand() * 0.5), 0.3, -Math.sin(an) * lean, Math.cos(an) * lean, seed + 500 + k * 7);
    }
    this.scree(rocks, x, z, base, 4 + Math.floor(rand() * 5), rand, seed + 900);
  }

  /** An outcrop: a boulder or two with a few small ones round them. */
  private outcrop(rocks: Rocks, x: number, z: number, size: number, seed: number) {
    const rand = rng(seed);
    const g = terrainHeight(x, z);
    const top = this.rock(rocks, x, z, g, size, size * (0.7 + rand() * 0.6), 0.25, (rand() - 0.5) * 0.3, (rand() - 0.5) * 0.3, seed);
    if (size > 1.6 && rand() < 0.45) {
      const s2 = size * (0.45 + rand() * 0.2);
      this.rock(rocks, x + (rand() - 0.5) * size * 0.4, z + (rand() - 0.5) * size * 0.4, top, s2, s2 * (0.9 + rand() * 0.6), 0.35, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.4, seed + 3);
    }
    const n = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const an = rand() * Math.PI * 2;
      const d = size * (0.8 + rand() * 0.6);
      const ox = x + Math.cos(an) * d;
      const oz = z + Math.sin(an) * d;
      if (this.clear(ox, oz, 0.6)) continue;
      const s = size * (0.3 + rand() * 0.3);
      this.rock(rocks, ox, oz, terrainHeight(ox, oz), s, s * (0.6 + rand() * 0.6), 0.25, (rand() - 0.5) * 0.4, (rand() - 0.5) * 0.4, seed + 11 + k);
    }
    this.scree(rocks, x, z, size, 2 + Math.floor(rand() * 4), rand, seed + 77);
  }

  private *raise(rocks: Rocks): Generator<void> {
    const rand = rng(0x5ad1e);
    // the ridge: spires behind the station, a notch for it in the middle
    for (let b = -66; b <= 66; ) {
      const ab = Math.abs(b);
      const height = (5 + 15 * smooth(5, 18, ab) * smooth(66, 28, ab) + 4 * smooth(44, 10, ab)) * (0.75 + rand() * 0.5);
      this.spire(rocks, ridgeA(b) + (rand() - 0.5) * 5, b, height, 1000 + Math.floor(rand() * 1e6));
      // a second, broken line further back, and some in front of it, so the ridge has depth
      if (rand() < 0.55) this.spire(rocks, ridgeA(b) - 9 - rand() * 8, b + (rand() - 0.5) * 6, height * (0.5 + rand() * 0.4), 2000 + Math.floor(rand() * 1e6));
      b += 6.5 + rand() * 4;
      yield;
    }
    // the station is wrapped in rock: a low wall behind it, rising into the ridge,
    for (let b = -13; b <= 11; b += 3 + rand() * 1.5) {
      const { x, z } = fromFrame(-11 - rand() * 2.5, b, this.w);
      this.outcrop(rocks, x, z, 2.2 + rand() * 1.6, 3000 + Math.floor(rand() * 1e6));
    }
    yield;
    // tall crags on the north-west side, lower ones to the south-east (they stand in front of it)
    this.spire(rocks, -3, 18, 11, 4001);
    this.spire(rocks, 6, 20, 8, 4002);
    this.spire(rocks, -8, 15, 9, 4003);
    this.spire(rocks, -5, -19, 5, 4004);
    this.spire(rocks, 3, -21, 3.5, 4005);
    yield;
    // the mountain's rock: outcrops all over it, heaped bigger high up and
    // behind, with only the path and pockets of sand between them
    const STEP = 4;
    for (let gb = -70; gb <= 70; gb += STEP) {
      for (let ga = -60; ga <= 104; ga += STEP) {
        const ia = Math.round(ga / STEP);
        const ib = Math.round(gb / STEP);
        const a = ga + (hash01(ia * 3 + 1, ib) - 0.5) * STEP;
        const b = gb + (hash01(ia, ib * 3 + 7) - 0.5) * STEP;
        const { x, z } = fromFrame(a, b, this.w);
        const hm = highlandMask(x, z);
        if (hm < 0.45) continue;
        const up = smooth(1, 14, highlandHeight(x, z));
        const chance = Math.min(0.92, (0.25 + 0.6 * up) * (a < 0 ? 1.25 : 0.95) * smooth(0.45, 0.8, hm));
        const h = hash01(ia + 911, ib - 377);
        if (h > chance) continue;
        const r2 = hash01(ia - 51, ib + 433);
        // low beside the path, so they never hide the creature walking it
        const n = pathNear(a, b);
        const size = n.d < 4.5 ? 0.5 + r2 * 0.9 : n.d < 9 ? 1 + r2 * 1.3 : (1.4 + r2 * 2.6) * (0.55 + up * 0.85);
        if (this.clear(x, z, size * 0.8 + 0.6)) continue;
        this.outcrop(rocks, x, z, size, 5000 + ia * 7919 + ib * 104729);
      }
      yield;
    }
    // stones lining the path, now one side, now the other
    const at = { a: 0, b: 0 };
    let side = 1;
    for (let s = 4; s < PATH_LEN - 10; s += 2.5 + rand() * 3) {
      pathAt(s, at);
      const ahead = pathAt(s + 0.5, { a: 0, b: 0 });
      const da = ahead.a - at.a;
      const db = ahead.b - at.b;
      const l = Math.hypot(da, db) || 1;
      if (rand() < 0.75) side = -side;
      const off = pathWidth(s) + 0.9 + rand() * 1.4;
      const { x, z } = fromFrame(at.a - (db / l) * off * side, at.b + (da / l) * off * side, this.w);
      if (highlandMask(x, z) < 0.3 || this.clear(x, z, 0.3)) continue;
      const big = rand() < 0.3;
      const size = big ? 0.7 + rand() * 0.6 : 0.2 + rand() * 0.35;
      this.rock(rocks, x, z, terrainHeight(x, z), size, size * (0.6 + rand() * 0.5), 0.25, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, 7000 + Math.floor(s * 100));
    }
    yield;
    // scree and boulders round the mountain's foot
    for (let k = 0; k < 140; k++) {
      const an = rand() * Math.PI * 2;
      const d = HIGH_REACH * (0.35 + rand() * 0.55);
      const x = HIGH.x + Math.cos(an) * d;
      const z = HIGH.z + Math.sin(an) * d;
      const hm = highlandMask(x, z);
      if (hm < 0.25 || hm > 0.85 || this.clear(x, z, 1)) continue;
      const size = rand() < 0.25 ? 0.6 + rand() * 1.1 : 0.12 + rand() * 0.35;
      this.rock(rocks, x, z, terrainHeight(x, z), size, size * (0.6 + rand() * 0.5), 0.25, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.5, 8000 + k);
    }
    // the creature first looks up at the tallest spire
    let best = this.spires[0];
    for (const sp of this.spires) if (sp.top > best.top) best = sp;
    this.lookPoint.set(best.x, best.top, best.z);
    for (const mesh of this.boulders) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.frustumCulled = true;
    }
  }

  /** Go on raising the rock for up to `ms` milliseconds. */
  place(ms: number) {
    if (!this.placing) return;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (this.placing.next().done) {
        this.placing = null;
        break;
      }
    }
    for (const mesh of this.boulders) mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, listener: Vector3, wind: Wind) {
    this.justDiscovered = false;
    if (!HIGH.on) return;
    const dc = Math.hypot(listener.x - HIGH.x, listener.z - HIGH.z);
    // the rock is raised once the creature is on its way
    if (dc < 200) this.place(3);
    // first sight: the spires rising over the dunes
    if (!this.discovered && !this.placing && (dc < 105 || highlandMask(listener.x, listener.z) > 0.05)) {
      this.discovered = true;
      this.justDiscovered = true;
    }
    const near = smooth(HIGH_REACH + 15, 52, dc);
    const heart = smooth(26, 5, dc);
    this.audio.setHighlands(near, heart, wind.strength);
    if (near <= 0) return;

    // pebbles let go off a rock close by
    if (highlandMask(listener.x, listener.z) > 0.2) {
      this.pebbleTimer -= dt * (0.6 + wind.strength);
      if (this.pebbleTimer <= 0) {
        this.pebbleTimer = 3 + Math.random() * 7;
        this.trickle(listener);
      }
    }
    // and, now and then, something bigger far off
    if (near > 0.5) {
      this.rockfallTimer -= dt;
      if (this.rockfallTimer <= 0) {
        this.rockfallTimer = 40 + Math.random() * 60;
        this.audio.highlandRockfall(0.12 + Math.random() * 0.08, (Math.random() - 0.5) * 1.4);
      }
    }
    // sand streams off the spires in the wind, thickest in the gusts
    this.streamTimer -= dt * (0.4 + wind.strength * 2.2);
    if (this.streamTimer <= 0) {
      this.streamTimer = 0.25 + Math.random() * 0.5;
      this.streamer(listener, wind);
    }
  }

  /** A veil of sand torn off the top of a spire, streaming downwind and fading. */
  private streamer(listener: Vector3, wind: Wind) {
    for (let k = 0; k < 6; k++) {
      const sp = this.spires[Math.floor(Math.random() * this.spires.length)];
      if (!sp || Math.hypot(sp.x - listener.x, sp.z - listener.z) > 55) continue;
      const n = 6 + Math.floor(wind.strength * 10);
      for (let i = 0; i < n; i++) {
        const sp2 = 1.4 + Math.random() * 2;
        this.dust.spawn(
          sp.x + (Math.random() - 0.5) * sp.r,
          sp.top - Math.random() * 0.8,
          sp.z + (Math.random() - 0.5) * sp.r,
          wind.dir.x * sp2,
          0.1 + Math.random() * 0.3,
          wind.dir.y * sp2,
          2.4 + Math.random() * 2,
          STREAM,
          2,
          { g: -0.05, drag: 0.4, windK: 1.4, c2: STREAM_FADE, soft: true },
        );
      }
      return;
    }
  }

  /** Find a rock near the listener, standing over it, and send a few pebbles down its face. */
  private trickle(listener: Vector3) {
    for (let k = 0; k < 20; k++) {
      const c = this.crags[Math.floor(Math.random() * this.crags.length)];
      if (!c) return;
      const dist = Math.hypot(c.x - listener.x, c.z - listener.z);
      if (dist > 16 || dist < 2 || c.top < listener.y + 1.2) continue;
      // down the face toward the creature
      const dx = (listener.x - c.x) / dist;
      const dz = (listener.z - c.z) / dist;
      const x = c.x + dx * c.r * 0.4;
      const z = c.z + dz * c.r * 0.4;
      const y = c.top - 0.2;
      const n = 4 + Math.floor(Math.random() * 6);
      for (let i = 0; i < n; i++) {
        this.dust.spawn(
          x + (Math.random() - 0.5) * 0.4,
          y + Math.random() * 0.3,
          z + (Math.random() - 0.5) * 0.4,
          dx * (0.8 + Math.random() * 1.2),
          0.3 + Math.random() * 0.6,
          dz * (0.8 + Math.random() * 1.2),
          1.6 + Math.random() * 0.8,
          PEBBLE[i % PEBBLE.length],
          1,
          { g: 9, drag: 0.2, windK: 0.02 },
        );
      }
      // a thin veil of dust shaken loose with them
      for (let i = 0; i < 5; i++) {
        this.dust.spawn(
          x + (Math.random() - 0.5) * 0.6,
          y - Math.random() * 1.2,
          z + (Math.random() - 0.5) * 0.6,
          dx * 0.4 + (Math.random() - 0.5) * 0.2,
          -0.15 - Math.random() * 0.2,
          dz * 0.4 + (Math.random() - 0.5) * 0.2,
          1.6 + Math.random(),
          DUST,
          2,
          { g: 0.3, drag: 1.5, windK: 0.5, c2: DUST_FADE, soft: true },
        );
      }
      this.audio.highlandPebbles(0.16 / (1 + dist * 0.18), Math.max(-0.8, Math.min(0.8, (c.x - listener.x) / 8)));
      return;
    }
  }
}
