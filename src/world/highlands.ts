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
const ROAD_W = 2.4;
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
const rugged = (x: number, z: number) =>
  ridge(x * 0.045 + 2.1, z * 0.045 - 6.3) * 0.55 + ridge(x * 0.11 - 9.4, z * 0.11 + 1.7) * 0.3 + ridge(x * 0.26 + 4.4, z * 0.26 + 7.7) * 0.15;

/** Where the road's middle runs across (it winds a little), at distance `a` out from the summit. */
export function roadCentre(a: number) {
  return Math.sin(a * 0.07) * 5 * smooth(SUMMIT, SUMMIT + 12, a);
}

/** The road's height over the desert at distance `a` out from the summit. */
function roadHeight(a: number) {
  return PEAK * (1 - smooth(SUMMIT - 2, SUMMIT + ROAD_LEN, a));
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
  // the mountain: steep near the top and spreading at the foot, higher toward the north
  const north = -dz / Math.max(r, 1);
  const t = Math.min(1, Math.max(0, r / (RM + fbm(x * 0.03 + 17.3, z * 0.03 - 4.1, 2) * 18)));
  const profile = Math.pow(1 - t, 1.25);
  const rough = rugged(x, z);
  let h = PEAK * profile * (0.62 + 0.55 * rough) * (0.85 + 0.3 * smooth(-0.6, 0.8, north));
  // crags and broken outcrops, rougher toward the top
  h += ridge(x * 0.55 + 1.3, z * 0.55 - 2.9) * 1.1 * Math.min(1, profile * 2.5);
  // rocky hills around it
  for (const [ha, hb, hr, hh] of HILLS) {
    const d = Math.hypot(a - ha, b - hb) / (hr + gnoise(x * 0.08 + ha, z * 0.08 + hb) * 3);
    if (d < 1) h = Math.max(h, hh * Math.pow(1 - d, 1.5) * (0.6 + 0.7 * rough));
  }
  // the spur the road climbs, and the road itself, graded smooth
  const rh = roadHeight(a);
  const off = Math.abs(b - roadCentre(a));
  const along = smooth(SUMMIT - 4, SUMMIT, a) * (1 - smooth(SUMMIT + ROAD_LEN, SUMMIT + ROAD_LEN + 8, a));
  // a broad ridge, rough-flanked, that the road follows up
  h = Math.max(h, rh * smooth(ROAD_W + 26, ROAD_W + 2, off) * (0.8 + 0.4 * rough * smooth(ROAD_W + 2, ROAD_W + 10, off)) * along);
  const road = smooth(ROAD_W + 4, ROAD_W, off) * along;
  h += (rh + gnoise(x * 0.4, z * 0.4) * 0.08 - h) * road;
  // the summit, levelled for the station, crags rising round it to the north
  const level = PEAK + 0.15 * gnoise(x * 0.2, z * 0.2);
  const flat = smooth(SUMMIT + 3, SUMMIT - 2, r);
  h += (level - h) * flat;
  return h;
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
float hRidge(vec2 p) {
  float r = max(0.0, 1.0 - abs(gnoise(p)) * 2.0);
  return r * r;
}
float hRugged(vec2 p) {
  return hRidge(p * 0.045 + vec2(2.1, -6.3)) * 0.55 + hRidge(p * 0.11 + vec2(-9.4, 1.7)) * 0.3 + hRidge(p * 0.26 + vec2(4.4, 7.7)) * 0.15;
}
float roadCentre(float a) {
  return sin(a * 0.07) * 5.0 * smoothstep(${f(SUMMIT)}, ${f(SUMMIT + 12)}, a);
}
float highlandHeight(vec2 p) {
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  float r = length(d);
  if (r > HIGH_REACH) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float north = -d.y / max(r, 1.0);
  float t = clamp(r / (${f(RM)} + fbm(p * 0.03 + vec2(17.3, -4.1), 2) * 18.0), 0.0, 1.0);
  float profile = pow(1.0 - t, 1.25);
  float rough = hRugged(p);
  float h = ${f(PEAK)} * profile * (0.62 + 0.55 * rough) * (0.85 + 0.3 * smoothstep(-0.6, 0.8, north));
  h += hRidge(p * 0.55 + vec2(1.3, -2.9)) * 1.1 * min(1.0, profile * 2.5);
  for (int i = 0; i < ${HILLS.length}; i++) {
    vec4 hl = HILLS[i];
    float dd = length(vec2(a, b) - hl.xy) / (hl.z + gnoise(p * 0.08 + hl.xy) * 3.0);
    if (dd < 1.0) h = max(h, hl.w * pow(1.0 - dd, 1.5) * (0.6 + 0.7 * rough));
  }
  float rh = ${f(PEAK)} * (1.0 - smoothstep(${f(SUMMIT - 2)}, ${f(SUMMIT + ROAD_LEN)}, a));
  float off = abs(b - roadCentre(a));
  float along = smoothstep(${f(SUMMIT - 4)}, ${f(SUMMIT)}, a) * (1.0 - smoothstep(${f(SUMMIT + ROAD_LEN)}, ${f(SUMMIT + ROAD_LEN + 8)}, a));
  h = max(h, rh * smoothstep(${f(ROAD_W + 26)}, ${f(ROAD_W + 2)}, off) * (0.8 + 0.4 * rough * smoothstep(${f(ROAD_W + 2)}, ${f(ROAD_W + 10)}, off)) * along);
  float road = smoothstep(${f(ROAD_W + 4)}, ${f(ROAD_W)}, off) * along;
  h += (rh + gnoise(p * 0.4) * 0.08 - h) * road;
  float level = ${f(PEAK)} + 0.15 * gnoise(p * 0.2);
  float levelled = smoothstep(${f(SUMMIT + 3)}, ${f(SUMMIT - 2)}, r);
  h += (level - h) * levelled;
  return h;
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
/** 0..1: the graded road and the levelled summit (kept clear of rock and boulders). */
float highlandRoad(vec2 p) {
  if (uHighOn < 0.5) return 0.0;
  vec2 d = p - uHigh.xy;
  float r = length(d);
  if (r > HIGH_REACH) return 0.0;
  float a = dot(d, uHigh.zw);
  float b = dot(d, vec2(-uHigh.w, uHigh.z));
  float along = smoothstep(${f(SUMMIT - 4)}, ${f(SUMMIT)}, a) * (1.0 - smoothstep(${f(SUMMIT + ROAD_LEN)}, ${f(SUMMIT + ROAD_LEN + 8)}, a));
  float road = smoothstep(${f(ROAD_W + 1.5)}, ${f(ROAD_W - 0.5)}, abs(b - roadCentre(a))) * along;
  return max(road, smoothstep(${f(SUMMIT + 1)}, ${f(SUMMIT - 2)}, r));
}
`;

/** 0..1: the graded road and the levelled summit (kept clear of boulders). */
export function highlandRoad(x: number, z: number): number {
  if (!HIGH.on) return 0;
  const dx = x - HIGH.x;
  const dz = z - HIGH.z;
  const r = Math.hypot(dx, dz);
  if (r > HIGH_REACH) return 0;
  const a = dx * HIGH.ox + dz * HIGH.oz;
  const b = -dx * HIGH.oz + dz * HIGH.ox;
  const along = smooth(SUMMIT - 4, SUMMIT, a) * (1 - smooth(SUMMIT + ROAD_LEN, SUMMIT + ROAD_LEN + 8, a));
  const road = smooth(ROAD_W + 1.5, ROAD_W - 0.5, Math.abs(b - roadCentre(a))) * along;
  return Math.max(road, smooth(SUMMIT + 1, SUMMIT - 2, r));
}
