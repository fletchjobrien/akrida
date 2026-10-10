import { fbm, gnoise } from './noise';

/**
 * The highlands: a rocky plateau rising out of the desert far to the north-east
 * of the ship. Its layered cliffs face south-west, toward the view, so their
 * strata always show, and it climbs higher toward the north, where it cannot
 * stand between the camera and the creature. At its heart is an amphitheatre:
 * a round basin walled by terraced cliffs, open to the south-west by a valley
 * whose sandy floor ramps gently up into it. Buttes stand out in the desert
 * around it, with rubble at their feet.
 *
 * `highlandHeight` and `HIGHLAND_GLSL` must stay in step: the ground the
 * creature walks on is the ground that is drawn.
 */
export const HIGH = {
  /** Centre of the amphitheatre (where the tracker leads). */
  x: 0,
  z: 0,
  /** The way it opens (unit, from the centre toward the ship). */
  ox: -Math.SQRT1_2,
  oz: Math.SQRT1_2,
  on: false,
};

/** Beyond this distance from the centre it adds nothing. */
export const HIGH_REACH = 112;
/** The plateau's radius, and how far its middle sits back from the basin (away from the opening). */
const RP = 44;
const SHIFT = 8;
/** The basin's radius. */
const RB = 13;
/** Height of one layer of rock: the cliffs are built of ledges about this tall. */
const STEP = 3.2;
/** How far the whole region (and the basin floor) rises out of the desert. */
const FLOOR = 2.2;
/**
 * Buttes out in the desert, in the basin's own frame: distance toward the
 * opening, distance across (toward the north-west), radius, height. None
 * stands across the way in from the ship.
 */
const BUTTES: [number, number, number, number][] = [
  [56, 31, 6, 9.6],
  [72, -30, 5, 7.2],
  [22, 54, 7, 12],
  [-8, -52, 6, 8.4],
  [96, 23, 4, 6],
  [42, -47, 7.5, 9.6],
  [-42, 56, 6, 14.4],
];

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
/** Sharp-crested noise, 0..1: crags and ridges. */
const ridge = (x: number, z: number) => {
  const r = Math.max(0, 1 - Math.abs(gnoise(x, z)) * 2);
  return r * r;
};

/** Distance to the plateau's edge measure (its rim wanders). */
function edgeOf(x: number, z: number, dx: number, dz: number) {
  return Math.hypot(dx + HIGH.ox * SHIFT, dz + HIGH.oz * SHIFT) + fbm(x * 0.035 + 17.3, z * 0.035 - 4.1, 3) * 16;
}

/** Height the highlands add to the desert. */
export function highlandHeight(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  const r = Math.hypot(dx, dz);
  if (r > HIGH_REACH) return 0;
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  const edge = edgeOf(x, z, dx, dz);
  const plateau = smooth(RP, RP - 12, edge);
  // the amphitheatre: a round basin, and the valley that opens it toward the ship
  const wob = fbm(x * 0.06 - 3.7, z * 0.06 + 8.2, 2) * 4;
  const bowl = smooth(RB, RB - 8, r + wob);
  const w = 6 + Math.max(0, a) * 0.16;
  const valley = smooth(-2, 4, a) * smooth(w, w - 5, Math.abs(b) + wob);
  const cut = Math.max(bowl, valley);
  // higher toward the north, lower on the side nearer the view; rugged, in ridges and spurs
  const north = -dz / Math.max(r, 1);
  const top = 8 + 18 * smooth(-0.5, 0.8, north);
  const rough = ridge(x * 0.045 + 2.1, z * 0.045 - 6.3) * 0.75 + ridge(x * 0.11 - 9.4, z * 0.11 + 1.7) * 0.25;
  let relief = plateau * (1 - cut) * top * (0.7 + 0.6 * rough);
  for (const [ba, bb, br, bh] of BUTTES) {
    const d = Math.hypot(a - ba, b - bb) + gnoise(x * 0.2 + ba, z * 0.2 + bb) * 1.6;
    relief = Math.max(relief, bh * smooth(br, br - 3.5, d));
  }
  // layered: ledges and steeper risers, the beds of the rock, wandering a little
  const shift = gnoise(x * 0.04 + 1.9, z * 0.04 - 2.6) * 0.5;
  const t = relief / STEP + shift;
  const ft = Math.floor(t);
  const terr = Math.max(0, (ft + smooth(0.45, 1, t - ft) - shift) * STEP);
  relief += (terr - relief) * 0.5 * smooth(0, 3, relief);
  // the region rises gently out of the sand, the basin floor with it, and
  // rubble heaps up at the feet of the cliffs
  const lift = FLOOR * smooth(RP + 10, RP - 8, edge);
  const apron = 1.4 * smooth(RP + 9, RP, edge) * (1 - plateau);
  return lift + relief + apron;
}

/** 0..1: how much this is highland ground (no dunes, red sand, rock, cliffs that stop you). */
export function highlandMask(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  if (Math.hypot(dx, dz) > HIGH_REACH) return 0;
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  let m = smooth(RP + 24, RP + 4, edgeOf(x, z, dx, dz));
  for (const [ba, bb, br] of BUTTES) m = Math.max(m, smooth(br + 9, br, Math.hypot(a - ba, b - bb)));
  return m;
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

export const HIGHLAND_GLSL = /* glsl */ `
uniform vec4 uHigh; // centre x, z; opening direction x, z
uniform float uHighOn;
const float HIGH_REACH = ${f(HIGH_REACH)};
const vec4 BUTTES[${BUTTES.length}] = vec4[${BUTTES.length}](
  ${BUTTES.map((b) => `vec4(${b.map(f).join(', ')})`).join(',\n  ')}
);
float hRidge(vec2 p) {
  float r = max(0.0, 1.0 - abs(gnoise(p)) * 2.0);
  return r * r;
}
float highlandEdge(vec2 p, vec2 d) {
  return length(d + uHigh.zw * ${f(SHIFT)}) + fbm(p * 0.035 + vec2(17.3, -4.1), 3) * 16.0;
}
float highlandHeight(vec2 p) {
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  float r = length(d);
  if (r > HIGH_REACH) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float edge = highlandEdge(p, d);
  float plateau = smoothstep(${f(RP)}, ${f(RP - 12)}, edge);
  float wob = fbm(p * 0.06 + vec2(-3.7, 8.2), 2) * 4.0;
  float bowl = smoothstep(${f(RB)}, ${f(RB - 8)}, r + wob);
  float w = 6.0 + max(0.0, a) * 0.16;
  float valley = smoothstep(-2.0, 4.0, a) * smoothstep(w, w - 5.0, abs(b) + wob);
  float cut = max(bowl, valley);
  float north = -d.y / max(r, 1.0);
  float top = 8.0 + 18.0 * smoothstep(-0.5, 0.8, north);
  float rough = hRidge(p * 0.045 + vec2(2.1, -6.3)) * 0.75 + hRidge(p * 0.11 + vec2(-9.4, 1.7)) * 0.25;
  float relief = plateau * (1.0 - cut) * top * (0.7 + 0.6 * rough);
  for (int i = 0; i < ${BUTTES.length}; i++) {
    vec4 bt = BUTTES[i];
    float dd = length(vec2(a, b) - bt.xy) + gnoise(p * 0.2 + bt.xy) * 1.6;
    relief = max(relief, bt.w * smoothstep(bt.z, bt.z - 3.5, dd));
  }
  float shift = gnoise(p * 0.04 + vec2(1.9, -2.6)) * 0.5;
  float t = relief / ${f(STEP)} + shift;
  float ft = floor(t);
  float terr = max(0.0, (ft + smoothstep(0.45, 1.0, t - ft) - shift) * ${f(STEP)});
  relief += (terr - relief) * 0.5 * smoothstep(0.0, 3.0, relief);
  float lift = ${f(FLOOR)} * smoothstep(${f(RP + 10)}, ${f(RP - 8)}, edge);
  float apron = 1.4 * smoothstep(${f(RP + 9)}, ${f(RP)}, edge) * (1.0 - plateau);
  return lift + relief + apron;
}
float highlandMask(vec2 p) {
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  if (length(d) > HIGH_REACH) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float m = smoothstep(${f(RP + 24)}, ${f(RP + 4)}, highlandEdge(p, d));
  for (int i = 0; i < ${BUTTES.length}; i++) {
    vec4 bt = BUTTES[i];
    m = max(m, smoothstep(bt.z + 9.0, bt.z, length(vec2(a, b) - bt.xy)));
  }
  return m;
}
`;
