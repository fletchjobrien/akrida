import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Euler,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { hash01, hashU } from './noise';
import { duneField, terrainHeight } from './terrain';
import { toonMaterial } from '../render/shared';
import { PALETTE } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { rng } from '../core/math';

/** A rock the creature can collide with. Radius is on the ground plane. */
export interface RockInfo {
  x: number;
  z: number;
  radius: number;
  height: number;
}

const VARIANTS = 6;

function makeRockGeometry(seed: number): BufferGeometry {
  const rand = rng(seed * 9973 + 17);
  const base = new IcosahedronGeometry(1, seed % 2);
  const pos = base.getAttribute('position') as BufferAttribute;
  // Jitter consistently per original vertex so faces stay connected.
  const jitter = new Map<string, Vector3>();
  const v = new Vector3();
  const squash = 0.5 + rand() * 0.25;
  const stretch = 0.9 + rand() * 0.5;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let j = jitter.get(key);
    if (!j) {
      j = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.42);
      jitter.set(key, j);
    }
    v.add(j);
    v.x *= stretch;
    v.y *= squash;
    // flat-ish base, the rock sits in the sand
    if (v.y < -0.18) v.y = -0.18 + (v.y + 0.18) * 0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const geo = base.index ? base.toNonIndexed() : base;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Rocks are streamed around the player from a deterministic hash of world
 * cells, so the same rocks are always in the same place.
 */
export class Rocks {
  readonly meshes: InstancedMesh[] = [];
  readonly nearby: RockInfo[] = [];
  private readonly cellSize = 6;
  private readonly range = 6; // cells in each direction
  private lastCx = Number.NaN;
  private lastCz = Number.NaN;
  private readonly capacity = 160;
  private readonly material: Material;

  constructor() {
    this.material = toonMaterial({
      dark: PALETTE.rockDark,
      mid: PALETTE.rockMid,
      light: PALETTE.rockLight,
      litAt: 0.62,
      midAt: 0.05,
      outline: 0.55,
      highlight: 1,
    });
    for (let i = 0; i < VARIANTS; i++) {
      const mesh = new InstancedMesh(makeRockGeometry(i), this.material, this.capacity);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.layers.enable(SHADOW_LAYER);
      this.meshes.push(mesh);
    }
  }

  update(x: number, z: number) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    if (cx === this.lastCx && cz === this.lastCz) return;
    this.lastCx = cx;
    this.lastCz = cz;
    this.rebuild(cx, cz);
  }

  private rebuild(cx: number, cz: number) {
    const counts = new Array(VARIANTS).fill(0);
    this.nearby.length = 0;
    const m = new Matrix4();
    const q = new Quaternion();
    const e = new Euler();
    const p = new Vector3();
    const s = new Vector3();

    const place = (wx: number, wz: number, size: number, seed: number) => {
      const rand = rng(seed);
      const variant = Math.floor(rand() * VARIANTS);
      if (counts[variant] >= this.capacity) return;
      const sx = size * (0.8 + rand() * 0.5);
      const sy = size * (0.7 + rand() * 0.6);
      const sz = size * (0.8 + rand() * 0.5);
      const h = terrainHeight(wx, wz);
      e.set((rand() - 0.5) * 0.3, rand() * Math.PI * 2, (rand() - 0.5) * 0.3);
      q.setFromEuler(e);
      p.set(wx, h - sy * 0.12, wz);
      s.set(sx, sy, sz);
      m.compose(p, q, s);
      this.meshes[variant].setMatrixAt(counts[variant]++, m);
      this.nearby.push({ x: wx, z: wz, radius: Math.max(sx, sz) * 0.85, height: sy * 0.6 });
    };

    for (let gz = cz - this.range; gz <= cz + this.range; gz++) {
      for (let gx = cx - this.range; gx <= cx + this.range; gx++) {
        const r = hash01(gx, gz);
        const ox = (hash01(gx + 7177, gz - 311) - 0.5) * this.cellSize * 0.8;
        const oz = (hash01(gx - 913, gz + 5021) - 0.5) * this.cellSize * 0.8;
        const wx = (gx + 0.5) * this.cellSize + ox;
        const wz = (gz + 0.5) * this.cellSize + oz;
        const bare = 1 - duneField(wx, wz) * 0.85;
        const seed = hashU(gx, gz);
        if (r < 0.055 * bare) {
          // a cluster: one rock with a few small ones scattered around it
          const rand = rng(seed ^ 0x9e3779b9);
          const big = 0.45 + rand() * 0.75;
          place(wx, wz, big, seed);
          const n = Math.floor(rand() * 4);
          for (let k = 0; k < n; k++) {
            const a = rand() * Math.PI * 2;
            const d = big * (1.2 + rand() * 1.4);
            place(wx + Math.cos(a) * d, wz + Math.sin(a) * d, 0.1 + rand() * 0.22, seed + k + 1);
          }
        } else if (r < 0.2 * bare) {
          place(wx, wz, 0.08 + hash01(gx + 3, gz + 9) * 0.16, seed);
        }
      }
    }

    // Rare great boulders on a coarser grid.
    const big = this.cellSize * 7;
    const bx0 = Math.floor((cx * this.cellSize) / big);
    const bz0 = Math.floor((cz * this.cellSize) / big);
    for (let gz = bz0 - 1; gz <= bz0 + 1; gz++) {
      for (let gx = bx0 - 1; gx <= bx0 + 1; gx++) {
        if (hash01(gx * 31 + 5, gz * 17 - 3) > 0.45) continue;
        const wx = (gx + 0.2 + hash01(gx, gz + 77) * 0.6) * big;
        const wz = (gz + 0.2 + hash01(gx + 77, gz) * 0.6) * big;
        const seed = hashU(gx + 100003, gz - 7);
        const rand = rng(seed);
        place(wx, wz, 1.6 + rand() * 1.6, seed);
        const n = 2 + Math.floor(rand() * 4);
        for (let k = 0; k < n; k++) {
          const a = rand() * Math.PI * 2;
          const d = 2.2 + rand() * 2.5;
          place(wx + Math.cos(a) * d, wz + Math.sin(a) * d, 0.2 + rand() * 0.6, seed + k * 13 + 1);
        }
      }
    }

    for (let i = 0; i < VARIANTS; i++) {
      this.meshes[i].count = counts[i];
      this.meshes[i].instanceMatrix.needsUpdate = true;
    }
  }
}
