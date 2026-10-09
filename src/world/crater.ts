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
  if (a < -SKID - SKIP_REACH || a > 3.5 || Math.abs(s) > 3.5) return 0;
  const t = (a + SKID) / SKID;
  let h = 0;
  if (t > -0.05 && t < 1.12) {
    const w = 0.4 + 0.55 * t;
    const ends = smooth(-0.04, 0.08, t) * (1 - smooth(1.0, 1.1, t));
    h += (-(0.06 + 0.32 * t) * Math.exp(-sq(s / w)) + 0.1 * (0.4 + t) * Math.exp(-sq((Math.abs(s) - 1.5 * w) / 0.4))) * ends;
  }
  h += 0.5 * Math.exp(-sq((a - 1.6) / 0.85) - sq(s / 1.1));
  for (const [c, dep] of [
    [-SKID - 5.4, 0.1],
    [-SKID - 2.3, 0.15],
  ]) {
    const q = sq((a - c) / 0.9) + sq(s / 0.5);
    h += -dep * Math.exp(-q * 1.5) + dep * 0.4 * Math.exp(-sq((Math.sqrt(q) - 1.3) / 0.35));
  }
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
    m = Math.max(m, sk, 1 - smooth(3, 6.5, trailDistance(x, z)));
  }
  return m;
}

/** Height added to the terrain by the impact. */
export function craterHeight(x: number, z: number): number {
  if (!SITE.on) return 0;
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
  return bowl + rim + ejecta + gouge + (SITE2.on ? skidHeight(x, z) : 0);
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
    m = max(m, max(ka * (1.0 - smoothstep(2.5, 5.0, abs(k.y))), 1.0 - smoothstep(3.0, 6.5, trailDistance(p))));
  }
  return m;
}
float skidHeight(vec2 p) {
  vec2 k = skidCoords(p);
  if (k.x < ${f(-SKID - SKIP_REACH)} || k.x > 3.5 || abs(k.y) > 3.5) return 0.0;
  float t = (k.x + ${f(SKID)}) / ${f(SKID)};
  float h = 0.0;
  if (t > -0.05 && t < 1.12) {
    float w = 0.4 + 0.55 * t;
    float ends = smoothstep(-0.04, 0.08, t) * (1.0 - smoothstep(1.0, 1.1, t));
    float sw = k.y / w;
    float bq = (abs(k.y) - 1.5 * w) / 0.4;
    h += (-(0.06 + 0.32 * t) * exp(-sw * sw) + 0.1 * (0.4 + t) * exp(-bq * bq)) * ends;
  }
  float ba = (k.x - 1.6) / 0.85;
  float bs = k.y / 1.1;
  h += 0.5 * exp(-ba * ba - bs * bs);
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
float craterHeight(vec2 p) {
  if (uSiteOn < 0.5) return 0.0;
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
  return bowl + rim + ejecta + gouge + (uSite2On > 0.5 ? skidHeight(p) : 0.0);
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
    // the second pod came in low and fast: friction singed the last stretch of its skid
    vec2 k = skidCoords(p);
    float t = (k.x + ${f(SKID)}) / ${f(SKID)};
    float kw = 0.4 + 0.55 * t;
    if (t > 0.0 && t < 1.05) sc = max(sc, 0.7 * exp(-(k.y * k.y) / (kw * kw)) * smoothstep(0.5, 1.0, t));
  }
  return clamp(sc * (0.75 + 0.6 * gnoise(p * 0.9)), 0.0, 1.0);
}
`;
