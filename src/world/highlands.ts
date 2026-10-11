import { BufferGeometry, Float32BufferAttribute } from 'three';
import { fbm, gnoise } from './noise';

/**
 * The highlands: far to the north-east of the ship, a mountain of rock. Its
 * body is a long sandy rise, gentle toward the ship and steeper behind. Its
 * rock is the desert's rock: boulders, piled into spires along a ridgeline and
 * scattered over its flanks (they are placed in highlandLife.ts). The research
 * station sits in a saddle of the ridge, the spires rising round it, and a
 * footpath winds up to it between the rocks.
 *
 * The camera looks north, so the ridge stands behind the station (north and
 * east of it) and never hides it.
 *
 * Positions are often given in the summit's frame: `a` is the distance out
 * from the station toward the ship (down the path), `b` the distance across
 * (positive to the north-west).
 */
export const HIGH = {
  /** The station, in the saddle (where the tracker leads). */
  x: 0,
  z: 0,
  /** The way the path comes up (unit, from the station toward the ship). */
  ox: -Math.SQRT1_2,
  oz: Math.SQRT1_2,
  on: false,
};

/**
 * The next place the tracker leads, once the station's data is in: far to the
 * east of the station.
 */
export function eastSite(out: { x: number; z: number }) {
  out.x = HIGH.x + 300;
  out.z = HIGH.z - 20;
  return out;
}

/** Beyond this distance from the station the highlands add nothing. */
export const HIGH_REACH = 112;
/** How far from the station the highland ground (and the mesh that draws it) reaches. */
export const HIGH_MESH = 114;
/** The saddle's height over the desert. */
export const PEAK = 17.5;
/** The mountain's body: its height, and how far it reaches in front, behind and to the sides. */
const MOUND = 17;
const FRONT = 78;
const BACK = 46;
const SIDE = 64;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** A point in the summit's frame, in the world. */
export function fromFrame(a: number, b: number, out: { x: number; z: number }) {
  out.x = HIGH.x + a * HIGH.ox - b * HIGH.oz;
  out.z = HIGH.z + a * HIGH.oz + b * HIGH.ox;
  return out;
}
/** A point in the world, in the summit's frame. */
export function toFrame(x: number, z: number, out: { a: number; b: number }) {
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  out.a = dx * HIGH.ox + dz * HIGH.oz;
  out.b = -dx * HIGH.oz + dz * HIGH.ox;
  return out;
}

/** How far out in the mountain's body: 0 in the middle, 1 at its foot. */
function moundD(x: number, z: number, a: number, b: number) {
  const u = a + 6;
  const wob = 1 + fbm(x * 0.025 + 17.3, z * 0.025 - 4.1, 2) * 0.18;
  return Math.hypot(u / (u > 0 ? FRONT : BACK), b / SIDE) / wob;
}

/** Where the ridge of spires runs behind the station: its distance back, at `b` across. */
export function ridgeA(b: number) {
  return -14 - 0.0035 * b * b + 2.5 * Math.sin(b * 0.09 + 0.6);
}

/** The station's ground, kept clear: (a, b) in the summit's frame, with a margin. */
export function inStation(a: number, b: number, margin = 0) {
  return a > -9.5 - margin && a < 10.5 + margin && b > -14.5 - margin && b < 12.5 + margin;
}

/** The ground before the path is worn into it. */
function ground(x: number, z: number, a: number, b: number) {
  const d = moundD(x, z, a, b);
  if (d >= 1) return 0;
  const t = 1 - d * d;
  let h = MOUND * t * t;
  // the ground swells under the ridge behind the station
  const ra = (a - ridgeA(b)) / 10;
  h += 7 * Math.exp(-ra * ra) * smooth(72, 34, Math.abs(b)) * t;
  // lumps and hollows on the flanks
  h += fbm(x * 0.06 + 3.3, z * 0.06 - 7.7, 2) * 1.6 * smooth(0.1, 0.45, d) * t;
  // the saddle the station stands in: gently level, its edge wandering
  const r = Math.hypot(a, b) + fbm(x * 0.1 + 4.4, z * 0.1 - 1.7, 2) * 5;
  const lv = smooth(20, 9, r);
  h += (PEAK + gnoise(x * 0.15, z * 0.15) * 0.15 - h) * lv * 0.9;
  return h;
}

// ------------------------------------------------------------------ the path

/**
 * The footpath: worn by feet, not built. It wanders up from the desert,
 * swinging round the outcrops, its width coming and going. Its bends, in the
 * summit's frame, from the desert to the station.
 */
const BENDS: [number, number][] = [
  [102, 18],
  [88, 12],
  [74, 2],
  [61, -7],
  [49, -9],
  [39, -3],
  [30, 6],
  [21, 9],
  [13, 5],
  [5, 1],
];
/** The path as a dense line (a, b pairs), and the distance along it at each point. */
const PATH: number[] = [];
const PATH_S: number[] = [];
{
  const P = BENDS;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    const n = 10;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (q0: number, q1: number, q2: number, q3: number) =>
        0.5 * (2 * q1 + (-q0 + q2) * t + (2 * q0 - 5 * q1 + 4 * q2 - q3) * t2 + (-q0 + 3 * q1 - 3 * q2 + q3) * t3);
      PATH.push(cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]));
    }
  }
  PATH.push(...P[P.length - 1]);
  let s = 0;
  for (let i = 0; i < PATH.length; i += 2) {
    if (i) s += Math.hypot(PATH[i] - PATH[i - 2], PATH[i + 1] - PATH[i - 1]);
    PATH_S.push(s);
  }
}
/** The path's whole length. */
export const PATH_LEN = PATH_S[PATH_S.length - 1];

/** The nearest point of the path to (a, b): its distance, how far along, and where. */
export const near = { d: Infinity, s: 0, a: 0, b: 0 };
export function pathNear(a: number, b: number) {
  near.d = Infinity;
  if (a < -2 || a > 112 || b < -20 || b > 28) return near;
  let best = Infinity;
  for (let i = 0; i + 3 < PATH.length; i += 2) {
    const ax = PATH[i];
    const ab = PATH[i + 1];
    const ex = PATH[i + 2] - ax;
    const eb = PATH[i + 3] - ab;
    const l2 = ex * ex + eb * eb;
    let t = ((a - ax) * ex + (b - ab) * eb) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qa = ax + ex * t;
    const qb = ab + eb * t;
    const d2 = (a - qa) * (a - qa) + (b - qb) * (b - qb);
    if (d2 < best) {
      best = d2;
      near.a = qa;
      near.b = qb;
      near.s = PATH_S[i >> 1] + (PATH_S[(i >> 1) + 1] - PATH_S[i >> 1]) * t;
    }
  }
  near.d = Math.sqrt(best);
  return near;
}

/** The path's half-width, `s` along it: wider where it crosses open ground. */
export function pathWidth(s: number) {
  return 1.2 + 0.45 * gnoise(s * 0.08, 7.1);
}

/** A point of the path, `s` along it (summit frame). */
export function pathAt(s: number, out: { a: number; b: number }) {
  let i = 0;
  while (i < PATH_S.length - 2 && PATH_S[i + 1] < s) i++;
  const t = Math.min(1, Math.max(0, (s - PATH_S[i]) / (PATH_S[i + 1] - PATH_S[i] || 1)));
  out.a = PATH[i * 2] + (PATH[i * 2 + 2] - PATH[i * 2]) * t;
  out.b = PATH[i * 2 + 1] + (PATH[i * 2 + 3] - PATH[i * 2 + 1]) * t;
  return out;
}

const _f = { a: 0, b: 0 };
const _w = { x: 0, z: 0 };

/** 0..1: kept clear of rock: the path (with a margin) and the station's ground. */
export function highlandClear(x: number, z: number, margin = 0): number {
  if (!HIGH.on) return 0;
  toFrame(x, z, _f);
  if (inStation(_f.a, _f.b, margin)) return 1;
  const n = pathNear(_f.a, _f.b);
  if (n.d === Infinity) return 0;
  return smooth(pathWidth(n.s) + 0.6 + margin, pathWidth(n.s) - 0.2, n.d);
}

// ------------------------------------------------------------------ the table

/** The ground is laid on a triangular lattice this far apart. */
const STEP = 1.3;
const F2 = (Math.sqrt(3) - 1) / 2;
const G2 = (3 - Math.sqrt(3)) / 6;

/** A point of the lattice, in the world. */
const latX = (a: number, b: number) => (a - (a + b) * G2) * STEP;
const latZ = (a: number, b: number) => (b - (a + b) * G2) * STEP;

interface Table {
  key: string;
  a0: number;
  b0: number;
  na: number;
  nb: number;
  h: Float32Array;
  /** How worn by feet each point is (0..1), for the shading. */
  worn: Float32Array;
}
let table: Table | null = null;

/**
 * The height the highlands add, worked out once at every point of the
 * lattice, the path worn into it. The ground the creature walks on and the
 * mesh that draws it both read this, so they always agree.
 */
function heights(): Table {
  const key = `${HIGH.x},${HIGH.z},${HIGH.ox},${HIGH.oz}`;
  if (table && table.key === key) return table;
  const R = HIGH_MESH + 4;
  const toA = (x: number, z: number) => (x + (x + z) * F2) / STEP;
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (const [x, z] of [
    [HIGH.x - R, HIGH.z - R],
    [HIGH.x + R, HIGH.z - R],
    [HIGH.x - R, HIGH.z + R],
    [HIGH.x + R, HIGH.z + R],
  ]) {
    a0 = Math.min(a0, toA(x, z));
    a1 = Math.max(a1, toA(x, z));
    b0 = Math.min(b0, toA(z, x));
    b1 = Math.max(b1, toA(z, x));
  }
  a0 = Math.floor(a0) - 2;
  b0 = Math.floor(b0) - 2;
  const na = Math.ceil(a1) - a0 + 4;
  const nb = Math.ceil(b1) - b0 + 4;
  const h = new Float32Array(na * nb);
  const worn = new Float32Array(na * nb);
  for (let ia = 0; ia < na; ia++) {
    for (let ib = 0; ib < nb; ib++) {
      const x = latX(a0 + ia, b0 + ib);
      const z = latZ(a0 + ia, b0 + ib);
      if (Math.hypot(x - HIGH.x, z - HIGH.z) > R - 2) continue;
      toFrame(x, z, _f);
      const fa = _f.a;
      const fb = _f.b;
      let y = ground(x, z, fa, fb);
      // the path: the ground levelled across it and worn a little hollow,
      // following the lie of the land along it
      const n = pathNear(fa, fb);
      if (n.d < 6) {
        const w = pathWidth(n.s);
        const ends = smooth(0, 4, n.s);
        fromFrame(n.a, n.b, _w);
        const yc = ground(_w.x, _w.z, n.a, n.b);
        const k = smooth(w + 3, w - 0.3, n.d) * ends;
        y += (yc - 0.12 - y) * k * 0.85;
        worn[ia * nb + ib] = smooth(w + 0.5, w - 0.7, n.d) * ends * (1 - smooth(PATH_LEN - 6, PATH_LEN + 2, n.s));
      }
      h[ia * nb + ib] = y;
    }
  }
  return (table = { key, a0, b0, na, nb, h, worn });
}

/** Height the highlands add to the desert: laid flat across each triangle of the lattice. */
export function highlandHeight(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  if (dx * dx + dz * dz > HIGH_MESH * HIGH_MESH) return 0;
  const t = heights();
  const u = x / STEP;
  const v = z / STEP;
  const sk = (u + v) * F2;
  const fa = u + sk;
  const fb = v + sk;
  const a = Math.floor(fa);
  const b = Math.floor(fb);
  const s = fa - a;
  const w = fb - b;
  const k = (a - t.a0) * t.nb + (b - t.b0);
  const H = t.h;
  const h00 = H[k];
  const h11 = H[k + t.nb + 1];
  return s > w ? h00 + s * (H[k + t.nb] - h00) + w * (h11 - H[k + t.nb]) : h00 + w * (H[k + 1] - h00) + s * (h11 - H[k + 1]);
}

/**
 * The mesh the highlands' ground is drawn with: the lattice itself, with
 * smooth normals and how worn each point is. Its height is only what the
 * highlands add; the desert under it is added on the GPU, as for the rest of
 * the ground.
 */
export function highlandGeometry(): BufferGeometry {
  const t = heights();
  const index = new Int32Array(t.na * t.nb).fill(-1);
  const pos: number[] = [];
  const worn: number[] = [];
  let n = 0;
  for (let ia = 0; ia < t.na; ia++) {
    for (let ib = 0; ib < t.nb; ib++) {
      const x = latX(t.a0 + ia, t.b0 + ib);
      const z = latZ(t.a0 + ia, t.b0 + ib);
      if (Math.hypot(x - HIGH.x, z - HIGH.z) > HIGH_MESH + 1.5) continue;
      index[ia * t.nb + ib] = n++;
      pos.push(x, t.h[ia * t.nb + ib], z);
      worn.push(t.worn[ia * t.nb + ib]);
    }
  }
  const tri: number[] = [];
  for (let ia = 0; ia < t.na - 1; ia++) {
    for (let ib = 0; ib < t.nb - 1; ib++) {
      const k = ia * t.nb + ib;
      const p00 = index[k];
      const p10 = index[k + t.nb];
      const p01 = index[k + 1];
      const p11 = index[k + t.nb + 1];
      if (p00 < 0 || p11 < 0) continue;
      if (p10 >= 0) tri.push(p00, p11, p10);
      if (p01 >= 0) tri.push(p00, p01, p11);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('aWorn', new Float32BufferAttribute(worn, 1));
  geo.setIndex(tri);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  // the desert under it rises and falls a little
  geo.boundingSphere!.radius += 10;
  return geo;
}

/** 0..1: how much this is highland ground (no dunes or desert rocks; slopes that stop you). */
export function highlandMask(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  if (dx * dx + dz * dz > HIGH_REACH * HIGH_REACH) return 0;
  toFrame(x, z, _f);
  return smooth(1.15, 0.9, moundD(x, z, _f.a, _f.b));
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export const HIGHLAND_GLSL = /* glsl */ `
uniform vec4 uHigh; // station x, z; the way the path comes up x, z
uniform float uHighOn;
float highlandMask(vec2 p) {
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  if (dot(d, d) > ${f(HIGH_REACH * HIGH_REACH)}) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float u = a + 6.0;
  float wob = 1.0 + fbm(p * 0.025 + vec2(17.3, -4.1), 2) * 0.18;
  float md = length(vec2(u / (u > 0.0 ? ${f(FRONT)} : ${f(BACK)}), b / ${f(SIDE)})) / wob;
  return smoothstep(1.15, 0.9, md);
}
`;
