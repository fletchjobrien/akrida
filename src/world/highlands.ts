import { BufferGeometry, Float32BufferAttribute } from 'three';
import { fbm, gnoise } from './noise';

/**
 * The highlands: a rugged mountain rising out of the desert far to the
 * north-east of the ship, with rocky hills around it. Its summit was levelled
 * for a research station, and a graded road climbs a spur to it from the side
 * facing the ship. The rock is the desert's own grey-brown stone and the sand
 * is the desert's sand, so the mountain grows out of the land around it.
 *
 * The mountain climbs higher toward the north, so the summit and the road are
 * never hidden from the view behind it.
 *
 * `highlandHeight` and `HIGHLAND_GLSL` must stay in step: the ground the
 * creature walks on is the ground that is drawn.
 */
export const HIGH = {
  /** The summit (where the station stands, and where the tracker leads). */
  x: 0,
  z: 0,
  /** The way the road comes up (unit, from the summit toward the ship). */
  ox: -Math.SQRT1_2,
  oz: Math.SQRT1_2,
  on: false,
};

/** Beyond this distance from the summit it adds nothing. */
export const HIGH_REACH = 112;
/** The mountain's radius at its foot, and the summit's height over the desert. */
const RM = 64;
export const PEAK = 22;
/** The levelled summit's radius. */
export const SUMMIT = 14;
/** The road: half its width, and how far it runs from the summit's edge down to the desert. */
const ROAD_W = 1.6;
const ROAD_LEN = 66;
/**
 * Rocky hills around the mountain, in the summit's frame: distance toward the
 * road's end, distance across (toward the north-west), radius, height. None
 * stands across the road.
 */
const HILLS: [number, number, number, number][] = [
  [60, 34, 12, 8],
  [76, -30, 9, 5.5],
  [24, 60, 14, 11],
  [-12, -56, 11, 7],
  [96, 26, 7, 4],
  [44, -50, 12, 8],
  [-46, 58, 13, 13],
];

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Sharp-crested noise, 0..1: ridges, spurs and crags. */
const ridge = (x: number, z: number) => {
  const r = Math.max(0, 1 - Math.abs(gnoise(x, z)) * 2);
  return r * r;
};
/** Big ridges and spurs only, so the rock reads as broad faces meeting at sharp edges. */
const rugged = (x: number, z: number) => ridge(x * 0.045 + 2.1, z * 0.045 - 6.3) * 0.65 + ridge(x * 0.11 - 9.4, z * 0.11 + 1.7) * 0.35;

/** Where the trail's middle runs across (it wanders), at distance `a` out from the summit. */
export function roadCentre(a: number) {
  return (Math.sin(a * 0.07) * 5 + Math.sin(a * 0.19 + 1) * 1.6) * smooth(SUMMIT - 4, SUMMIT + 10, a);
}

/** The trail's half-width at distance `a`: worn wider and narrower as it goes. */
function trailWidth(a: number) {
  return ROAD_W + 0.6 * gnoise(a * 0.09, 3.3);
}

/** The summit's ragged rim: how far the levelled ground reaches at (x, z). */
function summitRim(x: number, z: number) {
  return SUMMIT + fbm(x * 0.09 + 4.4, z * 0.09 - 1.7, 2) * 7;
}

/** The levelled ground's height: undulating gently, more so toward its rim. */
function summitLevel(x: number, z: number, r: number) {
  return PEAK + (0.08 + 0.32 * smooth(6, SUMMIT, r)) * (gnoise(x * 0.12, z * 0.12) * 2 + gnoise(x * 0.5 + 3, z * 0.5) * 0.4);
}

/** The road's height over the desert at distance `a` out from the summit. */
function roadHeight(a: number) {
  return PEAK * (1 - smooth(SUMMIT - 2, SUMMIT + ROAD_LEN, a));
}

/** The highlands' shape before it is cut into faces: mountain, hills, and the ridge the trail climbs. */
function highlandShape(x: number, z: number): number {
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  const r = Math.hypot(dx, dz);
  if (r > HIGH_REACH) return 0;
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  // the mountain: steep near the top and spreading at the foot, higher toward the north
  const north = -dz / Math.max(r, 1);
  const t = Math.min(1, Math.max(0, r / (RM + fbm(x * 0.03 + 17.3, z * 0.03 - 4.1, 2) * 18)));
  const profile = Math.pow(1 - t, 1.25);
  const rough = rugged(x, z);
  let h = PEAK * profile * (0.62 + 0.55 * rough) * (0.85 + 0.3 * smooth(-0.6, 0.8, north));
  // rocky hills around it
  for (const [ha, hb, hr, hh] of HILLS) {
    const d = Math.hypot(a - ha, b - hb) / (hr + gnoise(x * 0.08 + ha, z * 0.08 + hb) * 3);
    if (d < 1) h = Math.max(h, hh * Math.pow(1 - d, 1.5) * (0.6 + 0.7 * rough));
  }
  // a broad ridge, rough-flanked, that the trail follows up
  const rh = roadHeight(a);
  const off = Math.abs(b - roadCentre(a));
  const w = trailWidth(a);
  const along = smooth(SUMMIT - 4, SUMMIT, a) * (1 - smooth(SUMMIT + ROAD_LEN, SUMMIT + ROAD_LEN + 8, a));
  return Math.max(h, rh * smooth(w + 26, w + 2, off) * (0.8 + 0.4 * rough * smooth(w + 2, w + 10, off)) * along);
}

/** Size of the faces the rock is cut into. The ground is laid on a lattice of half that. */
const FACET = 2.6;
const STEP = FACET / 2;
const F2 = (Math.sqrt(3) - 1) / 2;
const G2 = (3 - Math.sqrt(3)) / 6;
/** How far from the summit the highland ground (and the mesh that draws it) reaches. */
export const HIGH_MESH = 114;

/** A point of the lattice, in the world. */
const latX = (a: number, b: number) => (a - (a + b) * G2) * STEP;
const latZ = (a: number, b: number) => (b - (a + b) * G2) * STEP;

/** The trail and the levelled summit, worn smoothly into the faces of the rock. */
function carve(x: number, z: number, h: number) {
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  const r = Math.hypot(dx, dz);
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  // the trail: worn into the ridge, not graded flat, so the ground keeps some of its lie
  const along = smooth(SUMMIT - 4, SUMMIT, a) * (1 - smooth(SUMMIT + ROAD_LEN, SUMMIT + ROAD_LEN + 8, a));
  if (along > 0) {
    const off = Math.abs(b - roadCentre(a));
    const w = trailWidth(a);
    const trail = smooth(w + 3, w - 0.5, off) * along;
    if (trail > 0) h += (roadHeight(a) + gnoise(x * 0.35, z * 0.35) * 0.25 - h) * trail * 0.8;
  }
  // the summit, levelled for the station inside a ragged rim, the rock rising past it
  if (r < SUMMIT + 16) {
    const rim = summitRim(x, z);
    const levelled = smooth(rim + 4, rim - 3, r);
    h += (summitLevel(x, z, r) - h) * levelled * 0.95;
  }
  return h;
}

interface Table {
  key: string;
  a0: number;
  b0: number;
  na: number;
  nb: number;
  h: Float32Array;
}
let table: Table | null = null;

/**
 * The height the highlands add, worked out once at every point of the lattice.
 * The shape is taken at the corners of the big faces and laid flat across
 * them, so the rock is made of broad flat faces meeting at sharp edges, like
 * the boulders; then the trail and the summit are worn in at every point.
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
  // start on a corner of a big face
  a0 = 2 * Math.floor(a0 / 2) - 2;
  b0 = 2 * Math.floor(b0 / 2) - 2;
  const na = Math.ceil(a1) - a0 + 4;
  const nb = Math.ceil(b1) - b0 + 4;
  // the shape at the corners of the big faces
  const ca = (na >> 1) + 1;
  const cb = (nb >> 1) + 1;
  const shape = new Float32Array(ca * cb);
  for (let i = 0; i < ca; i++) {
    for (let j = 0; j < cb; j++) {
      const x = latX(a0 + 2 * i, b0 + 2 * j);
      const z = latZ(a0 + 2 * i, b0 + 2 * j);
      if (Math.hypot(x - HIGH.x, z - HIGH.z) < R) shape[i * cb + j] = highlandShape(x, z);
    }
  }
  const S = (i: number, j: number) => shape[i * cb + j];
  const h = new Float32Array(na * nb);
  for (let ia = 0; ia < na; ia++) {
    for (let ib = 0; ib < nb; ib++) {
      const x = latX(a0 + ia, b0 + ib);
      const z = latZ(a0 + ia, b0 + ib);
      if (Math.hypot(x - HIGH.x, z - HIGH.z) > R - 2) continue;
      // every point lies on a corner or the middle of an edge of a big face
      const i = ia >> 1;
      const j = ib >> 1;
      const oa = ia & 1;
      const ob = ib & 1;
      const s = oa && ob ? (S(i, j) + S(i + 1, j + 1)) / 2 : oa ? (S(i, j) + S(i + 1, j)) / 2 : ob ? (S(i, j) + S(i, j + 1)) / 2 : S(i, j);
      h[ia * nb + ib] = carve(x, z, s);
    }
  }
  return (table = { key, a0, b0, na, nb, h });
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
 * The mesh the highlands are drawn with: the lattice itself, so every edge of
 * the rock is a true edge of the mesh. Its height is only what the highlands
 * add; the desert under it is added on the GPU, as for the rest of the ground.
 */
export function highlandGeometry(): BufferGeometry {
  const t = heights();
  const index = new Int32Array(t.na * t.nb).fill(-1);
  const pos: number[] = [];
  let n = 0;
  for (let ia = 0; ia < t.na; ia++) {
    for (let ib = 0; ib < t.nb; ib++) {
      const x = latX(t.a0 + ia, t.b0 + ib);
      const z = latZ(t.a0 + ia, t.b0 + ib);
      if (Math.hypot(x - HIGH.x, z - HIGH.z) > HIGH_MESH + 1.5) continue;
      index[ia * t.nb + ib] = n++;
      pos.push(x, t.h[ia * t.nb + ib], z);
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
  geo.setIndex(tri);
  geo.computeBoundingSphere();
  // the desert under it rises and falls a little
  geo.boundingSphere!.radius += 10;
  return geo;
}

/** 0..1: how much this is highland ground (no dunes, rock, cliffs that stop you). */
export function highlandMask(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  const r = Math.hypot(dx, dz);
  if (r > HIGH_REACH) return 0;
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  let m = smooth(RM + 18, RM - 4, r);
  for (const [ha, hb, hr] of HILLS) m = Math.max(m, smooth(hr + 8, hr * 0.6, Math.hypot(a - ha, b - hb)));
  return m;
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export const HIGHLAND_GLSL = /* glsl */ `
uniform vec4 uHigh; // summit x, z; the way the road comes up x, z
uniform float uHighOn;
const float HIGH_REACH = ${f(HIGH_REACH)};
const vec4 HILLS[${HILLS.length}] = vec4[${HILLS.length}](
  ${HILLS.map((h) => `vec4(${h.map(f).join(', ')})`).join(',\n  ')}
);
float roadCentre(float a) {
  return (sin(a * 0.07) * 5.0 + sin(a * 0.19 + 1.0) * 1.6) * smoothstep(${f(SUMMIT - 4)}, ${f(SUMMIT + 10)}, a);
}
float trailWidth(float a) {
  return ${f(ROAD_W)} + 0.6 * gnoise(vec2(a * 0.09, 3.3));
}
float highlandMask(vec2 p) {
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  float r = length(d);
  if (r > HIGH_REACH) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float m = smoothstep(${f(RM + 18)}, ${f(RM - 4)}, r);
  for (int i = 0; i < ${HILLS.length}; i++) {
    vec4 hl = HILLS[i];
    m = max(m, smoothstep(hl.z + 8.0, hl.z * 0.6, length(vec2(a, b) - hl.xy)));
  }
  return m;
}
/** 0..1: the worn trail (its middle), and how far across it (-1..1, for ruts). */
float highlandTrail(vec2 p, out float across) {
  across = 0.0;
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  if (length(d) > HIGH_REACH) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float w = trailWidth(a);
  float along = smoothstep(${f(SUMMIT - 2)}, ${f(SUMMIT + 2)}, a) * (1.0 - smoothstep(${f(SUMMIT + ROAD_LEN)}, ${f(SUMMIT + ROAD_LEN + 8)}, a));
  float off = b - roadCentre(a);
  across = off / w;
  return smoothstep(w + 0.4, w - 0.6, abs(off)) * along;
}
/** 0..1: kept clear of bare rock and boulders: the trail, and the ground the station stands on. */
float highlandRoad(vec2 p) {
  float across;
  float t = highlandTrail(p, across);
  if (uHighOn < 0.5) return 0.0;
  return max(t, smoothstep(11.0, 8.0, length(p - uHigh.xy)));
}
`;

/** 0..1: kept clear of boulders: the trail, and the ground the station stands on. */
export function highlandRoad(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  const r = Math.hypot(dx, dz);
  if (r > HIGH_REACH) return 0;
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  const w = trailWidth(a);
  const along = smooth(SUMMIT - 2, SUMMIT + 2, a) * (1 - smooth(SUMMIT + ROAD_LEN, SUMMIT + ROAD_LEN + 8, a));
  const trail = smooth(w + 1.2, w - 0.6, Math.abs(b - roadCentre(a))) * along;
  return Math.max(trail, smooth(11, 8, r));
}
