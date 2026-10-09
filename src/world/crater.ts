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

/** 1 near the crash, 0 away from it: keeps dunes and rocks out of the way. */
export function siteMask(x: number, z: number): number {
  if (!SITE.on) return 0;
  const r = Math.hypot(x - SITE.x, z - SITE.z);
  const near = 1 - smooth(R * 1.8, R * 3.2, r);
  const { t, s } = trench(x, z);
  const along = smooth(-0.12, 0.02, t) * (1 - smooth(1, 1.1, t)) * (1 - smooth(2.5, 6, Math.abs(s)));
  return Math.max(near, along);
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
float siteMask(vec2 p) {
  if (uSiteOn < 0.5) return 0.0;
  float r = length(p - SITE);
  float near = 1.0 - smoothstep(SITE_R * 1.8, SITE_R * 3.2, r);
  vec2 ts = trenchCoords(p);
  float along = smoothstep(-0.12, 0.02, ts.x) * (1.0 - smoothstep(1.0, 1.1, ts.x)) * (1.0 - smoothstep(2.5, 6.0, abs(ts.y)));
  return max(near, along);
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
  return bowl + rim + ejecta + gouge;
}
// 0..1: how burnt the sand is (crater floor and the trench nearest it)
float scorchAt(vec2 p) {
  if (uSiteOn < 0.5) return 0.0;
  float r = length(p - SITE);
  float c = 1.0 - smoothstep(SITE_R * 0.4, SITE_R * 1.9, r);
  vec2 ts = trenchCoords(p);
  float w = 0.45 + 0.7 * ts.x;
  float tr = ts.x > 0.0 && ts.x < 1.05 ? exp(-(ts.y * ts.y) / (w * w * 1.4)) * smoothstep(0.15, 0.95, ts.x) : 0.0;
  return clamp(max(c, tr * 0.85) * (0.75 + 0.6 * gnoise(p * 0.9)), 0.0, 1.0);
}
`;
