import {
  GLSL3,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { fbm, gnoise, NOISE_GLSL } from './noise';
import { STAIN_GLSL } from './stains';
import { CRATER_GLSL, craterHeight, siteMask } from './crater';
import { HIGHLAND_GLSL, highlandHeight, highlandMask } from './highlands';
import { LIGHTING_GLSL, shared } from '../render/shared';
import { glslRgb, PALETTE } from '../render/palette';

/**
 * The desert height field. Large swells, fields of transverse dunes with a
 * gentle windward slope and a steep slip face, and small hummocks.
 * `TERRAIN_GLSL` below must mirror this function exactly.
 */
const DUNE_DX = -0.96296;
const DUNE_DZ = -0.26963;
const DUNE_WAVELENGTH = 19.0;
const DUNE_CREST = 0.7;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function duneProfile(u: number): number {
  if (u < DUNE_CREST) {
    const r = u / DUNE_CREST;
    return r * r * (2 - r);
  }
  const s = (u - DUNE_CREST) / (1 - DUNE_CREST);
  return (1 - s) * (1 - s);
}

export function duneField(x: number, z: number): number {
  return smooth(-0.06, 0.16, fbm(x * 0.0065 - 7.1, z * 0.0065 + 3.3, 2)) * (1 - siteMask(x, z)) * (1 - highlandMask(x, z));
}

export function terrainHeight(x: number, z: number): number {
  const swell = fbm(x * 0.011 + 31.7, z * 0.011 - 12.3, 3) * 7.0;
  const hummock = fbm(x * 0.09 + 3.1, z * 0.09 - 8.4, 2) * 0.22;
  const field = duneField(x, z);
  const warp = fbm(x * 0.016 + 5.2, z * 0.016 + 9.1, 2) * 1.3;
  const t = (x * DUNE_DX + z * DUNE_DZ) / DUNE_WAVELENGTH + warp;
  const amp = Math.min(1.4, Math.max(0.2, 0.75 + 0.9 * gnoise(x * 0.03 + 1.3, z * 0.03 + 7.7))) * 1.9 * field;
  const dune = duneProfile(t - Math.floor(t)) * amp;
  return swell + hummock + dune + craterHeight(x, z) + highlandHeight(x, z);
}

const _n = new Vector3();
export function terrainNormal(x: number, z: number, out = _n): Vector3 {
  const e = 0.08;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

export const TERRAIN_GLSL = /* glsl */ `
${CRATER_GLSL}
${HIGHLAND_GLSL}
const vec2 DUNE_DIR = vec2(${DUNE_DX}, ${DUNE_DZ});
float duneProfile(float u) {
  if (u < ${DUNE_CREST.toFixed(4)}) {
    float r = u / ${DUNE_CREST.toFixed(4)};
    return r * r * (2.0 - r);
  }
  float s = (u - ${DUNE_CREST.toFixed(4)}) / ${(1 - DUNE_CREST).toFixed(4)};
  return (1.0 - s) * (1.0 - s);
}
float duneField(vec2 p) {
  return smoothstep(-0.06, 0.16, fbm(p * 0.0065 + vec2(-7.1, 3.3), 2)) * (1.0 - siteMask(p)) * (1.0 - highlandMask(p));
}
float terrainHeight(vec2 p) {
  float swell = fbm(p * 0.011 + vec2(31.7, -12.3), 3) * 7.0;
  float hummock = fbm(p * 0.09 + vec2(3.1, -8.4), 2) * 0.22;
  float field = duneField(p);
  float warp = fbm(p * 0.016 + vec2(5.2, 9.1), 2) * 1.3;
  float t = dot(p, DUNE_DIR) / ${DUNE_WAVELENGTH.toFixed(4)} + warp;
  float amp = clamp(0.75 + 0.9 * gnoise(p * 0.03 + vec2(1.3, 7.7)), 0.2, 1.4) * 1.9 * field;
  float dune = duneProfile(fract(t)) * amp;
  return swell + hummock + dune + craterHeight(p) + highlandHeight(p);
}
`;

const TERRAIN_VERT = /* glsl */ `
precision highp float;
precision highp int;
${NOISE_GLSL}
${TERRAIN_GLSL}
uniform vec2 uGridOffset;
out vec3 vWorldPos;
out float vSteep;
void main() {
  vec2 p = position.xz + uGridOffset;
  vec3 wp = vec3(p.x, terrainHeight(p), p.y);
  vWorldPos = wp;
  // how steep the ground is at large (not its fine detail), for where bare rock shows
  vSteep = 0.0;
  if (highlandMask(p) > 0.0) {
    float e = 0.45;
    vec3 mn = normalize(vec3(terrainHeight(p - vec2(e, 0.0)) - terrainHeight(p + vec2(e, 0.0)), 2.0 * e,
                             terrainHeight(p - vec2(0.0, e)) - terrainHeight(p + vec2(0.0, e))));
    vSteep = 1.0 - mn.y;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

/** Shared sand shading used by the ground and by footprints. */
export const SAND_GLSL = /* glsl */ `
${TERRAIN_GLSL}
${STAIN_GLSL}

const vec3 SAND_HI = ${glslRgb(PALETTE.sandHi)};
const vec3 SAND_LIT = ${glslRgb(PALETTE.sandLit)};
const vec3 SAND_MID = ${glslRgb(PALETTE.sandMid)};
const vec3 SAND_SHADE = ${glslRgb(PALETTE.sandShade)};
const vec3 SAND_DEEP = ${glslRgb(PALETTE.sandDeep)};
const vec3 SOOT_LIT = ${glslRgb(0xc9b07c)};
const vec3 SOOT_MID = ${glslRgb(0xa48d61)};
const vec3 SOOT_SHADE = ${glslRgb(0x7c684a)};
const vec3 SOOT_DEEP = ${glslRgb(0x5c4c38)};
const vec3 SOOT_GLASS = ${glslRgb(0x3e3532)};

vec3 sandBand(int i) {
  if (i <= 0) return SAND_HI;
  if (i == 1) return SAND_LIT;
  if (i == 2) return SAND_MID;
  if (i == 3) return SAND_SHADE;
  return SAND_DEEP;
}

// Ripples carved by the wind, only used for shading.
float rippleHeight(vec2 p) {
  float w = gnoise(p * 0.55) * 1.6 + gnoise(p * 1.7 + 4.0) * 0.35;
  float t = dot(p, DUNE_DIR) * 2.9 + w;
  float u = fract(t);
  float prof = u < 0.75 ? u / 0.75 : (1.0 - u) / 0.25;
  float mask = smoothstep(-0.2, 0.25, gnoise(p * 0.07 + 9.0));
  return prof * 0.022 * mask;
}

// Fractured, pitted rock in the highlands (shading only), as much as gRock says.
float gRock = 0.0;
float rockDetail(vec2 p) {
  return gnoise(p * 1.9) * 0.09 + gnoise(p * 5.3 + 3.1) * 0.03;
}

float detailHeight(vec2 p) {
  // dragged, clawed and churned sand (shading only), which also wipes out the ripples
  vec4 st = stainAt(p);
  float hm = highlandMask(p);
  return terrainHeight(p) + rippleHeight(p) * (1.0 - st.a) * (1.0 - gRock) * (1.0 - 0.4 * hm) + stainHeight(st) + rockDetail(p) * gRock;
}

vec3 sandNormal(vec2 p) {
  const float e = 0.035;
  float h0 = detailHeight(p);
  float hx = detailHeight(p + vec2(e, 0.0));
  float hz = detailHeight(p + vec2(0.0, e));
  return normalize(vec3(h0 - hx, e, h0 - hz));
}

// Light level to palette band index. bias shifts darker (+) or lighter (-).
int sandBandIndex(vec3 wp, vec3 n, float dither, float bias) {
  float ndl = dot(n, uSunDir);
  float sh = shadowAt(wp, n);
  float cl = cloudShadowAt(wp.xz, dither);
  float l = ndl * mix(0.22, 1.0, sh) * (1.0 - 0.5 * cl);
  l += (dither - 0.5) * 0.07;
  int i = l > 0.47 ? 1 : (l > 0.3 ? 2 : (l > 0.115 ? 3 : 4));
  return clamp(i + int(bias), 0, 4);
}
`;

const TERRAIN_FRAG = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
${LIGHTING_GLSL}
${SAND_GLSL}
in vec3 vWorldPos;
in float vSteep;

// The beds of the highland rock, from the bottom up, repeating: orange, rust,
// cream, red-brown, salmon sandstone.
vec3 stratum(int k) {
  if (k == 0) return ${glslRgb(0xd9905c)};
  if (k == 1) return ${glslRgb(0xc06a44)};
  if (k == 2) return ${glslRgb(0xe8bf8a)};
  if (k == 3) return ${glslRgb(0xa4553c)};
  return ${glslRgb(0xcf8a66)};
}

vec3 rockColor(vec3 wp, vec3 n, float d, float steep) {
  vec2 p = wp.xz;
  // the beds run nearly level, gently warped, so every cliff shows the same bands
  float sy = wp.y * 0.72 + gnoise(p * 0.05) * 1.2 + gnoise(p * 0.4) * 0.12;
  int k = int(mod(floor(sy), 5.0));
  vec3 base = stratum(k);
  // soft wrapped light, so faces turned from the sun still read as rock
  float ndl = dot(n, uSunDir);
  float sh = shadowAt(wp, n);
  float l = (ndl * 0.55 + 0.45) * mix(0.55, 1.0, sh) + (d - 0.5) * 0.08;
  int band = l > 0.86 ? 0 : (l > 0.66 ? 1 : (l > 0.46 ? 2 : (l > 0.28 ? 3 : 4)));
  // thin dark partings between the beds
  if (fract(sy) < 0.07 + (d - 0.5) * 0.03) band = min(band + 1, 4);
  // desert varnish: dark streaks run down the steepest faces
  float streak = gnoise(vec2(dot(p, vec2(0.71, -0.71)) * 2.4, wp.y * 0.22 + 5.0));
  bool varnish = steep > 0.45 && streak > 0.2 + (d - 0.5) * 0.1;
  if (varnish) band = min(band + 1, 4);
  // grit and pebbles caught on the ledges
  float g = hash01(floor(p / uPixelWorld) + vec2(77.0, -19.0));
  if (g < 0.02) band = min(band + 1, 4);
  float mult = band == 0 ? 1.1 : (band == 1 ? 1.0 : (band == 2 ? 0.84 : (band == 3 ? 0.67 : 0.5)));
  vec3 c = base * mult;
  if (varnish) c = mix(c, c * vec3(0.78, 0.66, 0.72), 0.6);
  return min(c, vec3(1.0));
}

void main() {
  vec2 p = vWorldPos.xz;
  float d = worldDither();
  float hm = highlandMask(p);
  // bare rock where the ground is steep at large: cliffs, crags, the flanks of buttes
  gRock = hm * smoothstep(0.2, 0.42, vSteep);
  vec3 n = sandNormal(p);
  int band = sandBandIndex(vWorldPos, n, d, 0.0);

  // Pixel-sized pebbles and grit, locked to a world grid of screen-pixel size.
  vec2 cell = p / uPixelWorld;
  float field = duneField(p);
  float density = mix(0.010, 0.0025, field);
  float h1 = hash01(floor(cell));
  float h2 = hash01(floor(cell * 0.5) + vec2(913.0, 177.0));
  bool speck = h1 < density || h2 < density * 0.12;
  if (speck) band = max(band + 1, 3);

  // Sun glints that sparkle in the light.
  float gl = hash01(floor(cell) + vec2(-71.0, 33.0));
  if (band == 1 && gl < 0.0035 && sin(uTime * (3.0 + gl * 900.0) + gl * 4000.0) > 0.92) band = 0;

  // Veils of blowing sand streaming across the ground in gusts.
  vec2 wd = normalize(uWindDir);
  vec2 q = vec2(dot(p, wd), dot(p, vec2(-wd.y, wd.x)));
  q.x -= uWindTravel * 1.6;
  float veil = fbm(q * vec2(0.09, 0.42) + vec2(0.0, uTime * 0.05), 3);
  veil += gnoise(q * vec2(0.5, 2.2)) * 0.12;
  float thresh = mix(0.5, 0.08, uWindStrength);
  float over = veil - thresh;
  if (over > (d - 0.5) * 0.08) {
    if (band > 1) band -= 1;
    else if (band == 1 && d < clamp(over * 3.0, 0.0, 0.3)) band = 0;
  }

  // Churned sand: clods catch the light unevenly and lie darker in their hollows.
  vec4 st = stainAt(p);
  if (st.a > 0.02) {
    float ch = hash01(floor(cell) + vec2(55.0, -21.0));
    if (ch < st.a * 0.2) band = min(band + 1, 4);
    else if (ch > 1.0 - st.a * 0.08 && band >= 2) band -= 1;
  }
  // Troughs, gouges and hollows hold a little shade even under a high sun; heaped lips catch it.
  float sh = stainHeight(st);
  if (sh < -0.012 + (d - 0.5) * 0.012) band = min(max(band, 1) + 1, 4);
  if (sh < -0.045 + (d - 0.5) * 0.02) band = min(band + 1, 4);
  if (sh > 0.022 + (d - 0.5) * 0.012 && band >= 2) band -= 1;

  vec3 col = sandBand(band);

  // The highlands: red sand, and bare layered rock on the cliffs and crags.
  if (hm > 0.0) {
    // sand blown in from the desert, reddened by the rock it has worn from
    col = mix(col, col * vec3(1.0, 0.85, 0.7), hm * 0.6);
    // the edge of the bare rock wanders, as scree and drifted sand would leave it
    float edgeN = gnoise(p * 1.3 + 5.5) * 0.3 + gnoise(p * 4.1) * 0.12;
    if (gRock > 0.5 + (d - 0.5) * 0.4 + edgeN) col = rockColor(vWorldPos, n, d, max(vSteep, 1.0 - n.y));
  }

  // Burnt sand and fused glass where the pod came down.
  float sc = smoothstep(0.3, 0.55, scorchAt(p));
  if (sc > d) {
    int sb = clamp(band, 1, 4);
    col = sb == 1 ? SOOT_LIT : (sb == 2 ? SOOT_MID : (sb == 3 ? SOOT_SHADE : SOOT_DEEP));
    float gh = hash01(floor(cell) + vec2(401.0, -97.0));
    if (sc > 0.9 && gh < 0.018) col = gh < 0.004 && band <= 2 ? SAND_HI : SOOT_GLASS;
  }

  // Dried blood: darker at the rim where it dried first, darker still where it is fresher,
  // and the older stains half dusted over by blowing sand.
  if (st.r > 0.3 + d * 0.4) {
    float fl = hash01(floor(cell) + vec2(-13.0, 87.0));
    if (fl > 0.32 * (1.0 - st.g) * (1.0 - st.r * 0.4)) {
      bool rim = st.r < 0.62 + (d - 0.5) * 0.1;
      int bb = clamp(band + (rim ? 1 : 0) + (st.g > 0.45 + d * 0.3 ? 1 : 0), 1, 4);
      col = bb == 1 ? BLOOD_LIT : (bb == 2 ? BLOOD_MID : (bb == 3 ? BLOOD_SHADE : BLOOD_DEEP));
    }
  }

  outColor = vec4(col, 1.0);
  outInfo = vec4(0.5, 1.0, 0.0, 0.0);
}
`;

export class Terrain {
  readonly mesh: Mesh;
  readonly cell: number;
  private offset = new Vector2();

  constructor(size = 128, segments = 224) {
    const geo = new PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    this.cell = size / segments;
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { ...shared, uGridOffset: { value: this.offset } },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  /** Keep the grid centred on the view, snapped so vertices never swim. */
  follow(x: number, z: number) {
    this.offset.set(Math.round(x / this.cell) * this.cell, Math.round(z / this.cell) * this.cell);
  }
}
