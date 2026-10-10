import { Euler, InstancedMesh, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { rgb } from '../render/palette';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { rng } from '../core/math';
import { HIGH, HIGH_REACH, highlandMask } from './highlands';
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

const BOULDER_CAP = 420;
const PEBBLE = [rgb(0x6e3f30).toArray(), rgb(0x9a5a40).toArray(), rgb(0x4e3028).toArray()];
const RED_DUST = rgb(0xc58a62).toArray();
const RED_DUST_FADE = rgb(0xe0b48a).toArray();

/**
 * What goes on in the highlands: the first sight of them, their sound (wind
 * moaning through the rock, louder in gusts, and a low hum at their heart),
 * pebbles that now and then skitter down a cliff near the creature, and,
 * rarely, a far-off rockfall.
 */
export class Highlands {
  justDiscovered = false;
  discovered = false;
  /** Where the creature looks when it first sees them: high on the cliffs over the basin. */
  readonly lookPoint = new Vector3();
  private pebbleTimer = 4;
  private rockfallTimer = 30;
  /** Boulders and rubble fallen from the cliffs, in the red of the rock. */
  readonly boulders: InstancedMesh[] = [];

  constructor(
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    rocks: Rocks,
  ) {
    const mat = toonMaterial({ dark: 0x6e3a2c, mid: 0xa45a3e, light: 0xd08a5c, litAt: 0.6, midAt: 0.05, outline: 0.55, highlight: 1 });
    for (const g of this.geos) {
      const mesh = new InstancedMesh(g, mat, BOULDER_CAP);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.layers.enable(SHADOW_LAYER);
      this.boulders.push(mesh);
    }
    this.placing = this.scatter(rocks);
  }

  private readonly geos = Array.from({ length: 4 }, (_, i) => makeRockGeometry(i + 11));

  /** The boulders are placed a few milliseconds at a time, so starting up never stalls. */
  private placing: Generator<void> | null;

  addTo(scene: Object3D) {
    for (const m of this.boulders) scene.add(m);
  }

  /**
   * Boulders where they would have come to rest: on the level ground at the
   * foot of a cliff, heaped thickest close under it, a few big blocks further
   * out, and none perched on the faces themselves.
   */
  private *scatter(rocks: Rocks): Generator<void> {
    const geos = this.geos;
    const VARIANTS = geos.length;
    const CAP = BOULDER_CAP;
    const slope = (x: number, z: number) => {
      const e = 0.4;
      return Math.hypot(terrainHeight(x + e, z) - terrainHeight(x - e, z), terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
    };
    const m = new Matrix4();
    const q = new Quaternion();
    const eu = new Euler();
    const p = new Vector3();
    const sc = new Vector3();
    const corner = new Vector3();
    const STEP = 2.2;
    const R = HIGH_REACH;
    for (let gz = -R; gz <= R; gz += STEP) {
      yield;
      for (let gx = -R; gx <= R; gx += STEP) {
        const ix = Math.round(gx / STEP);
        const iz = Math.round(gz / STEP);
        const x = HIGH.x + gx + (hash01(ix * 3 + 1, iz) - 0.5) * STEP;
        const z = HIGH.z + gz + (hash01(ix, iz * 3 + 7) - 0.5) * STEP;
        if (highlandMask(x, z) < 0.25) continue;
        // the heart of the basin, and the way up the valley into it, are left clear
        const la = (x - HIGH.x) * HIGH.ox + (z - HIGH.z) * HIGH.oz;
        const lb = -(x - HIGH.x) * HIGH.oz + (z - HIGH.z) * HIGH.ox;
        if (Math.hypot(la, lb) < 6 || (la > 0 && la < 48 && Math.abs(lb) < 2.5)) continue;
        if (slope(x, z) > 0.45) continue;
        // how close under a cliff: steep ground a little way off
        let near = 0;
        for (const [dx, dz] of [
          [2.4, 0],
          [-2.4, 0],
          [0, 2.4],
          [0, -2.4],
          [1.7, 1.7],
          [-1.7, -1.7],
          [1.7, -1.7],
          [-1.7, 1.7],
        ]) {
          if (slope(x + dx, z + dz) > 1.1 && terrainHeight(x + dx, z + dz) > terrainHeight(x, z) + 0.6) near++;
        }
        const h = hash01(ix + 911, iz - 377);
        const chance = near > 0 ? 0.35 + near * 0.1 : 0.025;
        if (h > chance) continue;
        const rand = rng(Math.floor(h * 1e9) ^ (ix * 7919 + iz * 104729));
        const n = near > 0 ? 1 + Math.floor(rand() * 3) : 1;
        for (let k = 0; k < n; k++) {
          const v = Math.floor(rand() * VARIANTS);
          const mesh = this.boulders[v];
          if (mesh.count >= CAP) continue;
          const big = k === 0 ? (near > 0 ? 0.35 + rand() * 0.75 : 0.6 + rand() * 1.2) : 0.12 + rand() * 0.25;
          const bx = x + (k ? (rand() - 0.5) * 1.6 : 0);
          const bz = z + (k ? (rand() - 0.5) * 1.6 : 0);
          eu.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5);
          q.setFromEuler(eu);
          sc.set(big * (0.8 + rand() * 0.5), big * (0.6 + rand() * 0.6), big * (0.8 + rand() * 0.5));
          p.set(bx, terrainHeight(bx, bz) - sc.y * 0.15, bz);
          m.compose(p, q, sc);
          mesh.setMatrixAt(mesh.count++, m);
          if (big > 0.45) {
            // big ones are in the way
            const pts: number[] = [];
            let radius = 0;
            const pos = geos[v].getAttribute('position');
            for (let i = 0; i < pos.count; i += 3) {
              corner.fromBufferAttribute(pos, i).applyMatrix4(m);
              pts.push(corner.x, corner.z);
              radius = Math.max(radius, Math.hypot(corner.x - bx, corner.z - bz));
            }
            rocks.addStatic({ x: bx, z: bz, radius, height: sc.y * 0.6, hull: convexHull(pts) });
          }
        }
      }
    }
    for (const mesh of this.boulders) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Go on placing boulders for up to `ms` milliseconds. */
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
    this.place(3);
    if (!HIGH.on) return;
    const dc = Math.hypot(listener.x - HIGH.x, listener.z - HIGH.z);
    // first sight: the nearest cliffs rising over the dunes
    if (!this.discovered && (dc < 82 || highlandMask(listener.x, listener.z) > 0.05)) {
      this.discovered = true;
      this.justDiscovered = true;
      this.lookPoint.set(HIGH.x - HIGH.ox * 14, 0, HIGH.z - HIGH.oz * 14);
      this.lookPoint.y = terrainHeight(this.lookPoint.x, this.lookPoint.z) + 4;
    }
    const near = smooth(HIGH_REACH + 15, 52, dc);
    const heart = smooth(26, 5, dc);
    this.audio.setHighlands(near, heart, wind.strength);
    if (near <= 0) return;

    // pebbles let go off a cliff close by
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
  }

  /** Find a cliff face near the listener (in view, up the screen) and send a few pebbles down it. */
  private trickle(listener: Vector3) {
    for (let k = 0; k < 14; k++) {
      // mostly ahead, up the screen, where the faces are seen
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const d = 3 + Math.random() * 9;
      const x = listener.x + Math.cos(a) * d;
      const z = listener.z + Math.sin(a) * d;
      const e = 0.3;
      const gx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
      const gz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
      const s = Math.hypot(gx, gz);
      const y = terrainHeight(x, z);
      if (s < 1.3 || y < listener.y + 1) continue;
      // down the face, away from it
      const dx = -gx / s;
      const dz = -gz / s;
      const n = 4 + Math.floor(Math.random() * 6);
      for (let i = 0; i < n; i++) {
        this.dust.spawn(
          x + (Math.random() - 0.5) * 0.4,
          y + 0.1 + Math.random() * 0.3,
          z + (Math.random() - 0.5) * 0.4,
          dx * (0.6 + Math.random() * 0.9),
          0.2 + Math.random() * 0.6,
          dz * (0.6 + Math.random() * 0.9),
          1.4 + Math.random() * 0.8,
          PEBBLE[i % PEBBLE.length],
          1,
          { g: 9, drag: 0.25, windK: 0.02 },
        );
      }
      // a thin veil of red dust shaken loose with them
      for (let i = 0; i < 5; i++) {
        this.dust.spawn(
          x + (Math.random() - 0.5) * 0.6,
          y + Math.random() * 0.4,
          z + (Math.random() - 0.5) * 0.6,
          dx * 0.3 + (Math.random() - 0.5) * 0.2,
          -0.15 - Math.random() * 0.2,
          dz * 0.3 + (Math.random() - 0.5) * 0.2,
          1.6 + Math.random(),
          RED_DUST,
          2,
          { g: 0.3, drag: 1.5, windK: 0.5, c2: RED_DUST_FADE, soft: true },
        );
      }
      const dist = Math.hypot(x - listener.x, z - listener.z);
      this.audio.highlandPebbles(0.16 / (1 + dist * 0.18), Math.max(-0.8, Math.min(0.8, (x - listener.x) / 8)));
      return;
    }
  }
}
