/**
 * Where the escape pod came down: a skid trench gouged across the desert,
 * ending in an impact crater with a raised, splashed-forward rim. The height
 * offset here is added to the terrain on the CPU and (via CRATER_GLSL) on the
 * GPU, so both must stay in step.
 */

/**
 * Where the crater is, once it exists: centre (x, z) and the unit direction the
 * pod was travelling (dx, dz). It is placed at run time, ahead of the player
 * (see SiteSpawner), and mirrored into the shared uniforms uSite / uSiteOn.
 */
export const SITE = { x: 0, z: 0, dx: 1, dz: 0, on: false };
/** Crater radius, depth, rim height, trench length. */
const R = 3.4;
const DEPTH = 1.05;
const RIM = 0.42;
const TRENCH = 20;

const sq = (x: number) => x * x;
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Position along the trench (0 at its start, 1 at the crater) and signed distance across it. */
function trench(x: number, z: number) {
  const sx = SITE.x - SITE.dx * TRENCH;
  const sz = SITE.z - SITE.dz * TRENCH;
  const t = ((x - sx) * SITE.dx + (z - sz) * SITE.dz) / TRENCH;
  const s = (x - sx) * -SITE.dz + (z - sz) * SITE.dx;
  return { t, s };
}

/** Beyond this distance from the centre the crater changes nothing (dunes, rocks, height). */
export const CRATER_REACH = R * 3.2;

/** The pod's heading on the ground (x, z): it lies nose-right, so the skid comes in from the left. */
export const POD_DIR = { x: 0.9928, y: -0.1191 };

/** Length of the skid trench leading into the crater. */
export const TRENCH_LENGTH = TRENCH;

/**
 * The second pod, which came down near the first at a much lower angle: where
 * it lies (x, z) and the direction it skidded (dx, dz). Its survivor's trail
 * runs from it through (mx, mz) to (ex, ez). Mirrored into the uniforms
 * uSite2, uSite2Trail and uSite2On.
 */
export const SITE2 = { x: 0, z: 0, dx: 1, dz: 0, mx: 0, mz: 0, ex: 0, ez: 0, on: false };
/** Length of the second pod's skid trench, and how far before it the pod first skipped off the sand. */
export const SKID = 22;
export const SKIP_REACH = 7.5;
/** The second pod's bowl: centre along the skid from the pod, half-length, half-width, depth. */
export const BOWL2 = { at: -0.5, along: 3.2, across: 2.3, depth: 0.9 };
/** Beyond this distance from the second pod, its bowl and ejecta change nothing. */
export const BOWL2_REACH = 9.5;

/** Distance along the second pod's skid from the pod (negative behind it) and across it. */
function skid(x: number, z: number) {
  const ox = x - SITE2.x;
  const oz = z - SITE2.z;
  return { a: ox * SITE2.dx + oz * SITE2.dz, s: ox * -SITE2.dz + oz * SITE2.dx };
}

function segDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / Math.max(1e-6, dx * dx + dz * dz)));
  return Math.hypot(x - ax - dx * u, z - az - dz * u);
}

/** Distance from the survivor's trail (pod, bend, end). */
function trailDistance(x: number, z: number) {
  return Math.min(
    segDistance(x, z, SITE2.x, SITE2.z, SITE2.mx, SITE2.mz),
    segDistance(x, z, SITE2.mx, SITE2.mz, SITE2.ex, SITE2.ez),
  );
}

/**
 * Height added by the second pod: two skip marks where it first touched down,
 * then a long shallow trench that deepens toward the pod, ending in a bank of
 * sand ploughed up in front of its nose.
 */
function skidHeight(x: number, z: number): number {
  const { a, s } = skid(x, z);
  if (a < -SKID - SKIP_REACH || a > 9 || Math.abs(s) > 8) return 0;
  const t = (a + SKID) / SKID;
  let h = 0;
  if (t > -0.05 && t < 1.12 && Math.abs(s) < 3.5) {
    const w = 0.4 + 0.55 * t;
    const ends = smooth(-0.04, 0.08, t) * (1 - smooth(0.92, 1.0, t));
    h += (-(0.06 + 0.32 * t) * Math.exp(-sq(s / w)) + 0.1 * (0.4 + t) * Math.exp(-sq((Math.abs(s) - 1.5 * w) / 0.4))) * ends;
  }
  h += bowl2(a, s);
  for (const [c, dep] of [
    [-SKID - 5.4, 0.1],
    [-SKID - 2.3, 0.15],
  ]) {
    const q = sq((a - c) / 0.9) + sq(s / 0.5);
    h += -dep * Math.exp(-q * 1.5) + dep * 0.4 * Math.exp(-sq((Math.sqrt(q) - 1.3) / 0.35));
  }
  return h;
}

/**
 * Where the second pod finally hit and stopped: a bowl stretched along its
 * path, as low-angle impacts make, with a rim and ejecta thrown out to the
 * sides in two wings and little thrown up- or downrange (Gault and Wedekind
 * 1978). `a`, `s` are along and across the skid, from the pod.
 */
function bowl2(a: number, s: number) {
  const u = (a - BOWL2.at) / BOWL2.along;
  const v = s / BOWL2.across;
  const q = u * u + v * v;
  const r = Math.sqrt(q);
  const lat = (v * v) / (q + 1e-4);
  const inner = Math.min(1, q);
  const bowl = -BOWL2.depth * sq(1 - inner);
  const rim = 0.27 * (0.5 + 0.7 * lat) * Math.exp(-sq((r - 0.95) / 0.3));
  const wings = 0.12 * lat * lat * Math.exp(-Math.max(0, r - 1) / 0.9) * smooth(0.9, 1.15, r) * (1 - smooth(2.2, 3.4, r));
  // sand shoved up in front of the nose as it stopped
  const bank = 0.3 * Math.exp(-sq((a - 2.3) / 0.8) - sq(s / 1.2));
  return bowl + rim + wings + bank;
}

/**
 * The ship they escaped from, which came down beyond both pods: its centre
 * (x, z) and the direction its bow points (dx, dz). Mirrored into uSite3 and
 * uSite3On.
 */
export const SITE3 = { x: 0, z: 0, dx: 1, dz: 0, on: false };
/** Ship length, and the trench it ploughed before it stopped. */
export const SHIP_LENGTH = 20;
export const SHIP_TRENCH = 28;
/** How far beyond the bow, behind the trench and to the sides the ship changes the ground. */
export const SHIP_REACH = { bow: 19, side: 11 };

function shipCoords(x: number, z: number) {
  const ox = x - SITE3.x;
  const oz = z - SITE3.z;
  return { a: ox * SITE3.dx + oz * SITE3.dz, s: ox * -SITE3.dz + oz * SITE3.dx };
}

/**
 * Height added by the ship: a long trench, flat-floored with banked sides,
 * that deepens and widens toward the wreck and runs on under it, ending in a
 * great bank of sand shoved up in front of the bow, splashed out to the sides.
 */
function shipHeight(x: number, z: number): number {
  const { a, s } = shipCoords(x, z);
  const half = SHIP_LENGTH / 2;
  if (a < -half - SHIP_TRENCH - 4 || a > SHIP_REACH.bow || Math.abs(s) > SHIP_REACH.side) return 0;
  const t = (a + half + SHIP_TRENCH) / SHIP_TRENCH;
  const tc = Math.min(1, Math.max(0, t));
  const w = 1.6 + 3.2 * tc;
  const dep = 0.15 + 0.75 * tc;
  const ends = smooth(-0.03, 0.06, t) * (1 - smooth(half - 3, half, a));
  const floor = 1 - smooth(0.55 * w, w, Math.abs(s));
  const berm = 0.32 * (0.3 + tc) * Math.exp(-sq((Math.abs(s) - 1.15 * w) / (0.45 + 0.25 * tc)));
  let h = (-dep * floor + berm) * ends;
  h += 1.3 * Math.exp(-sq((a - half - 1.6) / 1.6) - sq(s / 3.2));
  h += 0.3 * Math.exp(-sq((a - half + 1) / 3)) * Math.exp(-sq((Math.abs(s) - 5) / 1.5));
  return h;
}

/** 1 near the crash, 0 away from it: keeps dunes and rocks out of the way. */
export function siteMask(x: number, z: number): number {
  if (!SITE.on) return 0;
  const r = Math.hypot(x - SITE.x, z - SITE.z);
  const near = 1 - smooth(R * 1.8, R * 3.2, r);
  const { t, s } = trench(x, z);
  const along = smooth(-0.12, 0.02, t) * (1 - smooth(1, 1.1, t)) * (1 - smooth(2.5, 6, Math.abs(s)));
  let m = Math.max(near, along);
  if (SITE2.on) {
    const k = skid(x, z);
    const along = smooth(-SKID - SKIP_REACH - 1, -SKID - SKIP_REACH + 0.5, k.a) * (1 - smooth(3, 5, k.a));
    const sk = along * (1 - smooth(2.5, 5, Math.abs(k.s)));
    const near2 = 1 - smooth(6.5, BOWL2_REACH, Math.hypot(x - SITE2.x, z - SITE2.z));
    m = Math.max(m, sk, near2, 1 - smooth(3, 6.5, trailDistance(x, z)));
  }
  if (SITE3.on) {
    const k = shipCoords(x, z);
    const along = smooth(-SHIP_LENGTH / 2 - SHIP_TRENCH - 5, -SHIP_LENGTH / 2 - SHIP_TRENCH, k.a) * (1 - smooth(SHIP_REACH.bow - 4, SHIP_REACH.bow, k.a));
    m = Math.max(m, along * (1 - smooth(SHIP_REACH.side - 4, SHIP_REACH.side, Math.abs(k.s))));
  }
  return m;
}

/** Height added to the terrain by the impact. */
export function craterHeight(x: number, z: number): number {
  if (!SITE.on) return 0;
  return firstHeight(x, z) + (SITE2.on ? skidHeight(x, z) : 0) + (SITE3.on ? shipHeight(x, z) : 0);
}

/** Height added by the first pod's crater and trench. */
function firstHeight(x: number, z: number): number {
  const ox = x - SITE.x;
  const oz = z - SITE.z;
  const r = Math.hypot(ox, oz);
  if (r > 26) {
    const { t, s } = trench(x, z);
    if (t < -0.1 || t > 1.05 || Math.abs(s) > 4) return 0;
  }
  const along = r > 1e-4 ? (ox * SITE.dx + oz * SITE.dz) / r : 0;
  const u = Math.min(1, sq(r / R));
  const bowl = -DEPTH * sq(1 - u);
  const rim = RIM * (1 + 0.6 * along) * Math.exp(-sq((r - R * 0.95) / 0.85));
  const ejecta =
    0.13 * (1 + along) * Math.exp(-Math.max(0, r - R) / 2.5) * smooth(R * 0.9, R * 1.15, r) * (1 - smooth(R * 2.2, R * 3.2, r));
  const { t, s } = trench(x, z);
  let gouge = 0;
  if (t > -0.1 && t < 1.05) {
    const w = 0.45 + 0.7 * t;
    const ends = smooth(-0.05, 0.08, t);
    gouge = (-(0.12 + 0.35 * t) * Math.exp(-sq(s / w)) + 0.1 * (0.5 + t) * Math.exp(-sq((Math.abs(s) - 1.5 * w) / 0.45))) * ends;
  }
  return bowl + rim + ejecta + gouge;
}

const f = (n: number) => n.toFixed(5);

export const CRATER_GLSL = /* glsl */ `
uniform vec4 uSite; // centre x, z; travel direction x, z
uniform float uSiteOn;
#define SITE uSite.xy
#define SITE_DIR uSite.zw
const float SITE_R = ${f(R)};
vec2 trenchCoords(vec2 p) {
  vec2 st = SITE - SITE_DIR * ${f(TRENCH)};
  vec2 o = p - st;
  return vec2(dot(o, SITE_DIR) / ${f(TRENCH)}, o.x * -SITE_DIR.y + o.y * SITE_DIR.x);
}
uniform vec4 uSite2;      // second pod x, z; skid direction x, z
uniform vec4 uSite2Trail; // its survivor's trail: bend x, z; end x, z
uniform float uSite2On;
vec2 skidCoords(vec2 p) {
  vec2 o = p - uSite2.xy;
  return vec2(dot(o, uSite2.zw), o.x * -uSite2.w + o.y * uSite2.z);
}
float segDistance(vec2 p, vec2 a, vec2 b) {
  vec2 d = b - a;
  float u = clamp(dot(p - a, d) / max(1e-6, dot(d, d)), 0.0, 1.0);
  return length(p - a - d * u);
}
float trailDistance(vec2 p) {
  return min(segDistance(p, uSite2.xy, uSite2Trail.xy), segDistance(p, uSite2Trail.xy, uSite2Trail.zw));
}
uniform vec4 uSite3; // the ship: centre x, z; bow direction x, z
uniform float uSite3On;
vec2 shipCoords(vec2 p) {
  vec2 o = p - uSite3.xy;
  return vec2(dot(o, uSite3.zw), o.x * -uSite3.w + o.y * uSite3.z);
}
float shipHeight(vec2 p) {
  vec2 k = shipCoords(p);
  float half_ = ${f(SHIP_LENGTH / 2)};
  if (k.x < -half_ - ${f(SHIP_TRENCH + 4)} || k.x > ${f(SHIP_REACH.bow)} || abs(k.y) > ${f(SHIP_REACH.side)}) return 0.0;
  float t = (k.x + half_ + ${f(SHIP_TRENCH)}) / ${f(SHIP_TRENCH)};
  float tc = clamp(t, 0.0, 1.0);
  float w = 1.6 + 3.2 * tc;
  float dep = 0.15 + 0.75 * tc;
  float ends = smoothstep(-0.03, 0.06, t) * (1.0 - smoothstep(half_ - 3.0, half_, k.x));
  float floor_ = 1.0 - smoothstep(0.55 * w, w, abs(k.y));
  float bq = (abs(k.y) - 1.15 * w) / (0.45 + 0.25 * tc);
  float berm = 0.32 * (0.3 + tc) * exp(-bq * bq);
  float h = (-dep * floor_ + berm) * ends;
  float ba = (k.x - half_ - 1.6) / 1.6;
  float bs = k.y / 3.2;
  h += 1.3 * exp(-ba * ba - bs * bs);
  float wa = (k.x - half_ + 1.0) / 3.0;
  float ws = (abs(k.y) - 5.0) / 1.5;
  h += 0.3 * exp(-wa * wa) * exp(-ws * ws);
  return h;
}
float siteMask(vec2 p) {
  if (uSiteOn < 0.5) return 0.0;
  float r = length(p - SITE);
  float near = 1.0 - smoothstep(SITE_R * 1.8, SITE_R * 3.2, r);
  vec2 ts = trenchCoords(p);
  float along = smoothstep(-0.12, 0.02, ts.x) * (1.0 - smoothstep(1.0, 1.1, ts.x)) * (1.0 - smoothstep(2.5, 6.0, abs(ts.y)));
  float m = max(near, along);
  if (uSite2On > 0.5) {
    vec2 k = skidCoords(p);
    float ka = smoothstep(${f(-SKID - SKIP_REACH - 1)}, ${f(-SKID - SKIP_REACH + 0.5)}, k.x) * (1.0 - smoothstep(3.0, 5.0, k.x));
    float near2 = 1.0 - smoothstep(6.5, ${f(BOWL2_REACH)}, length(p - uSite2.xy));
    m = max(m, max(max(ka * (1.0 - smoothstep(2.5, 5.0, abs(k.y))), near2), 1.0 - smoothstep(3.0, 6.5, trailDistance(p))));
  }
  if (uSite3On > 0.5) {
    vec2 k3 = shipCoords(p);
    float al = smoothstep(${f(-SHIP_LENGTH / 2 - SHIP_TRENCH - 5)}, ${f(-SHIP_LENGTH / 2 - SHIP_TRENCH)}, k3.x) * (1.0 - smoothstep(${f(SHIP_REACH.bow - 4)}, ${f(SHIP_REACH.bow)}, k3.x));
    m = max(m, al * (1.0 - smoothstep(${f(SHIP_REACH.side - 4)}, ${f(SHIP_REACH.side)}, abs(k3.y))));
  }
  return m;
}
float bowl2(vec2 k) {
  float u = (k.x - ${f(BOWL2.at)}) / ${f(BOWL2.along)};
  float v = k.y / ${f(BOWL2.across)};
  float q = u * u + v * v;
  float r = sqrt(q);
  float lat = (v * v) / (q + 1e-4);
  float inner = min(1.0, q);
  float bowl = -${f(BOWL2.depth)} * (1.0 - inner) * (1.0 - inner);
  float rq = (r - 0.95) / 0.3;
  float rim = 0.27 * (0.5 + 0.7 * lat) * exp(-rq * rq);
  float wings = 0.12 * lat * lat * exp(-max(0.0, r - 1.0) / 0.9) * smoothstep(0.9, 1.15, r) * (1.0 - smoothstep(2.2, 3.4, r));
  float ba = (k.x - 2.3) / 0.8;
  float bs = k.y / 1.2;
  return bowl + rim + wings + 0.3 * exp(-ba * ba - bs * bs);
}
float skidHeight(vec2 p) {
  vec2 k = skidCoords(p);
  if (k.x < ${f(-SKID - SKIP_REACH)} || k.x > 9.0 || abs(k.y) > 8.0) return 0.0;
  float t = (k.x + ${f(SKID)}) / ${f(SKID)};
  float h = 0.0;
  if (t > -0.05 && t < 1.12 && abs(k.y) < 3.5) {
    float w = 0.4 + 0.55 * t;
    float ends = smoothstep(-0.04, 0.08, t) * (1.0 - smoothstep(0.92, 1.0, t));
    float sw = k.y / w;
    float bq = (abs(k.y) - 1.5 * w) / 0.4;
    h += (-(0.06 + 0.32 * t) * exp(-sw * sw) + 0.1 * (0.4 + t) * exp(-bq * bq)) * ends;
  }
  h += bowl2(k);
  for (int i = 0; i < 2; i++) {
    float c = i == 0 ? ${f(-SKID - 5.4)} : ${f(-SKID - 2.3)};
    float dep = i == 0 ? 0.1 : 0.15;
    float qa = (k.x - c) / 0.9;
    float qs = k.y / 0.5;
    float q = qa * qa + qs * qs;
    float rq = (sqrt(q) - 1.3) / 0.35;
    h += -dep * exp(-q * 1.5) + dep * 0.4 * exp(-rq * rq);
  }
  return h;
}
float firstHeight(vec2 p) {
  vec2 o = p - SITE;
  float r = length(o);
  vec2 ts = trenchCoords(p);
  if (r > 26.0 && (ts.x < -0.1 || ts.x > 1.05 || abs(ts.y) > 4.0)) return 0.0;
  float along = r > 1e-4 ? dot(o, SITE_DIR) / r : 0.0;
  float u = min(1.0, (r / SITE_R) * (r / SITE_R));
  float bowl = -${f(DEPTH)} * (1.0 - u) * (1.0 - u);
  float rq = (r - SITE_R * 0.95) / 0.85;
  float rim = ${f(RIM)} * (1.0 + 0.6 * along) * exp(-rq * rq);
  float ejecta = 0.13 * (1.0 + along) * exp(-max(0.0, r - SITE_R) / 2.5) * smoothstep(SITE_R * 0.9, SITE_R * 1.15, r)
    * (1.0 - smoothstep(SITE_R * 2.2, SITE_R * 3.2, r));
  float gouge = 0.0;
  if (ts.x > -0.1 && ts.x < 1.05) {
    float w = 0.45 + 0.7 * ts.x;
    float ends = smoothstep(-0.05, 0.08, ts.x);
    float sw = ts.y / w;
    float bq = (abs(ts.y) - 1.5 * w) / 0.45;
    gouge = (-(0.12 + 0.35 * ts.x) * exp(-sw * sw) + 0.1 * (0.5 + ts.x) * exp(-bq * bq)) * ends;
  }
  return bowl + rim + ejecta + gouge;
}
float craterHeight(vec2 p) {
  if (uSiteOn < 0.5) return 0.0;
  return firstHeight(p) + (uSite2On > 0.5 ? skidHeight(p) : 0.0) + (uSite3On > 0.5 ? shipHeight(p) : 0.0);
}
// 0..1: how burnt the sand is (crater floor and the trench nearest it)
float scorchAt(vec2 p) {
  if (uSiteOn < 0.5) return 0.0;
  float r = length(p - SITE);
  float c = 1.0 - smoothstep(SITE_R * 0.4, SITE_R * 1.9, r);
  vec2 ts = trenchCoords(p);
  float w = 0.45 + 0.7 * ts.x;
  float tr = ts.x > 0.0 && ts.x < 1.05 ? exp(-(ts.y * ts.y) / (w * w * 1.4)) * smoothstep(0.15, 0.95, ts.x) : 0.0;
  float sc = max(c, tr * 0.85);
  if (uSite2On > 0.5) {
    // the second pod: its bowl burnt black and crisp like the first crater, and the
    // skid singed more and more toward it
    vec2 k = skidCoords(p);
    float t = (k.x + ${f(SKID)}) / ${f(SKID)};
    float kw = 0.4 + 0.55 * t;
    vec2 bq = vec2((k.x - ${f(BOWL2.at)}) / ${f(BOWL2.along)}, k.y / ${f(BOWL2.across)});
    float c2 = 1.0 - smoothstep(0.35, 1.75, length(bq));
    float tr2 = t > 0.0 && t < 1.05 ? 0.85 * exp(-(k.y * k.y) / (kw * kw * 1.4)) * smoothstep(0.3, 0.95, t) : 0.0;
    sc = max(sc, max(c2, tr2));
  }
  if (uSite3On > 0.5) {
    // the ship: its trench burnt more and more toward the wreck, the ground under and
    // around it blackened, and blast marks flung out where it broke apart
    vec2 k3 = shipCoords(p);
    float half_ = ${f(SHIP_LENGTH / 2)};
    float t3 = (k3.x + half_ + ${f(SHIP_TRENCH)}) / ${f(SHIP_TRENCH)};
    float w3 = 1.6 + 3.2 * clamp(t3, 0.0, 1.0);
    float tr3 = t3 > 0.0 ? 0.9 * (1.0 - smoothstep(0.5 * w3, 1.1 * w3, abs(k3.y))) * smoothstep(0.35, 0.95, t3) * (1.0 - smoothstep(half_ + 1.0, half_ + 4.0, k3.x)) : 0.0;
    float hull = (1.0 - smoothstep(half_ - 1.0, half_ + 3.5, abs(k3.x))) * (1.0 - smoothstep(4.0, 7.5, abs(k3.y)));
    vec2 b1 = (k3 - vec2(1.5, 4.8)) / vec2(2.6, 1.7);
    vec2 b2 = (k3 - vec2(-4.0, -5.2)) / vec2(2.0, 1.4);
    float blasts = max(1.0 - smoothstep(0.3, 1.0, length(b1)), 1.0 - smoothstep(0.3, 1.0, length(b2)));
    sc = max(sc, max(tr3, max(hull, blasts)));
  }
  return clamp(sc * (0.75 + 0.6 * gnoise(p * 0.9)), 0.0, 1.0);
}
`;
