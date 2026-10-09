import {
  GLSL3,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { fbm, gnoise, NOISE_GLSL } from './noise';
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
  return smooth(-0.06, 0.16, fbm(x * 0.0065 - 7.1, z * 0.0065 + 3.3, 2));
}

export function terrainHeight(x: number, z: number): number {
  const swell = fbm(x * 0.011 + 31.7, z * 0.011 - 12.3, 3) * 7.0;
  const hummock = fbm(x * 0.09 + 3.1, z * 0.09 - 8.4, 2) * 0.22;
  const field = duneField(x, z);
  const warp = fbm(x * 0.016 + 5.2, z * 0.016 + 9.1, 2) * 1.3;
  const t = (x * DUNE_DX + z * DUNE_DZ) / DUNE_WAVELENGTH + warp;
  const amp = Math.min(1.4, Math.max(0.2, 0.75 + 0.9 * gnoise(x * 0.03 + 1.3, z * 0.03 + 7.7))) * 1.9 * field;
  const dune = duneProfile(t - Math.floor(t)) * amp;
  return swell + hummock + dune;
}

const _n = new Vector3();
export function terrainNormal(x: number, z: number, out = _n): Vector3 {
  const e = 0.08;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

export const TERRAIN_GLSL = /* glsl */ `
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
  return smoothstep(-0.06, 0.16, fbm(p * 0.0065 + vec2(-7.1, 3.3), 2));
}
float terrainHeight(vec2 p) {
  float swell = fbm(p * 0.011 + vec2(31.7, -12.3), 3) * 7.0;
  float hummock = fbm(p * 0.09 + vec2(3.1, -8.4), 2) * 0.22;
  float field = duneField(p);
  float warp = fbm(p * 0.016 + vec2(5.2, 9.1), 2) * 1.3;
  float t = dot(p, DUNE_DIR) / ${DUNE_WAVELENGTH.toFixed(4)} + warp;
  float amp = clamp(0.75 + 0.9 * gnoise(p * 0.03 + vec2(1.3, 7.7)), 0.2, 1.4) * 1.9 * field;
  float dune = duneProfile(fract(t)) * amp;
  return swell + hummock + dune;
}
`;

const TERRAIN_VERT = /* glsl */ `
precision highp float;
precision highp int;
${NOISE_GLSL}
${TERRAIN_GLSL}
uniform vec2 uGridOffset;
out vec3 vWorldPos;
void main() {
  vec2 p = position.xz + uGridOffset;
  vec3 wp = vec3(p.x, terrainHeight(p), p.y);
  vWorldPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

/** Shared sand shading used by the ground and by footprints. */
export const SAND_GLSL = /* glsl */ `
${TERRAIN_GLSL}

const vec3 SAND_HI = ${glslRgb(PALETTE.sandHi)};
const vec3 SAND_LIT = ${glslRgb(PALETTE.sandLit)};
const vec3 SAND_MID = ${glslRgb(PALETTE.sandMid)};
const vec3 SAND_SHADE = ${glslRgb(PALETTE.sandShade)};
const vec3 SAND_DEEP = ${glslRgb(PALETTE.sandDeep)};

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

float detailHeight(vec2 p) {
  return terrainHeight(p) + rippleHeight(p);
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

void main() {
  vec2 p = vWorldPos.xz;
  vec3 n = sandNormal(p);
  float d = worldDither();
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

  outColor = vec4(sandBand(band), 1.0);
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
