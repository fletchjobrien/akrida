import {
  Float32BufferAttribute,
  GLSL3,
  Mesh,
  type Object3D,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { fbm, gnoise, NOISE_GLSL } from './noise';
import { STAIN_GLSL } from './stains';
import { CRATER_GLSL, craterHeight, siteMask } from './crater';
import { HIGH, HIGH_MESH, HIGHLAND_GLSL, highlandGeometry, highlandHeight, highlandMask } from './highlands';
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

/** The desert without the highlands (they are added on top, see highlands.ts). */
function baseHeight(x: number, z: number): number {
  const swell = fbm(x * 0.011 + 31.7, z * 0.011 - 12.3, 3) * 7.0;
  const hummock = fbm(x * 0.09 + 3.1, z * 0.09 - 8.4, 2) * 0.22 * (1 - highlandMask(x, z));
  const field = duneField(x, z);
  const warp = fbm(x * 0.016 + 5.2, z * 0.016 + 9.1, 2) * 1.3;
  const t = (x * DUNE_DX + z * DUNE_DZ) / DUNE_WAVELENGTH + warp;
  const amp = Math.min(1.4, Math.max(0.2, 0.75 + 0.9 * gnoise(x * 0.03 + 1.3, z * 0.03 + 7.7))) * 1.9 * field;
  const dune = duneProfile(t - Math.floor(t)) * amp;
  return swell + hummock + dune + craterHeight(x, z);
}

export function terrainHeight(x: number, z: number): number {
  return baseHeight(x, z) + highlandHeight(x, z);
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
// The desert without the highlands. The GPU only ever works this out: the
// highlands are worked out once, on the CPU, and drawn as a mesh of their own.
float baseHeight(vec2 p) {
  float swell = fbm(p * 0.011 + vec2(31.7, -12.3), 3) * 7.0;
  float hummock = fbm(p * 0.09 + vec2(3.1, -8.4), 2) * 0.22 * (1.0 - highlandMask(p));
  float field = duneField(p);
  float warp = fbm(p * 0.016 + vec2(5.2, 9.1), 2) * 1.3;
  float t = dot(p, DUNE_DIR) / ${DUNE_WAVELENGTH.toFixed(4)} + warp;
  float amp = clamp(0.75 + 0.9 * gnoise(p * 0.03 + vec2(1.3, 7.7)), 0.2, 1.4) * 1.9 * field;
  float dune = duneProfile(fract(t)) * amp;
  return swell + hummock + dune + craterHeight(p);
}
`;

const TERRAIN_VERT = /* glsl */ `
precision highp float;
precision highp int;
${NOISE_GLSL}
${TERRAIN_GLSL}
uniform vec2 uGridOffset;
in float aWorn;
out vec3 vWorldPos;
out vec3 vLandN;
out float vWorn;
void main() {
  // the lie of the land the highland mesh brings (straight up for the grid), and its worn path
  vLandN = normal;
  vWorn = aWorn;
  // the grid is flat; the highland mesh brings the height the highlands add
  vec2 p = position.xz + uGridOffset;
  vec3 wp = vec3(p.x, position.y + baseHeight(p), p.y);
  vWorldPos = wp;
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

float detailHeight(vec2 p) {
  // dragged, clawed and churned sand (shading only), which also wipes out the ripples
  vec4 st = stainAt(p);
  return baseHeight(p) + rippleHeight(p) * (1.0 - st.a) + stainHeight(st);
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
in vec3 vLandN;
in float vWorn;
uniform float uCut;

void main() {
  vec2 p = vWorldPos.xz;
  // the grid leaves the highlands to their own mesh
  if (length(p - uHigh.xy) < uCut) discard;
  float d = worldDither();
  vec3 n = sandNormal(p);
  // tilt the sand's own detail by the lie of the highlands under it
  vec3 ln = normalize(vLandN);
  n = normalize(n / n.y + ln / ln.y - vec3(0.0, 1.0, 0.0));
  float hm = highlandMask(p);
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

  vec4 info = vec4(0.5, 1.0, 0.0, 0.0);
  // the footpath: the sand scuffed and kicked about where feet kept to it,
  // thick with little dents and scattered grit, thinning out at its edges
  if (vWorn > 0.05) {
    float scuff = hash01(floor(cell) + vec2(3.0, 61.0));
    float along = 0.75 + 0.25 * gnoise(p * 0.6 + 2.0);
    if (scuff < 0.16 * vWorn * along) col = sandBand(clamp(band + 1, 2, 4));
    else if (scuff > 1.0 - 0.03 * vWorn) col = sandBand(min(band + 2, 4));
  }
  // the highlands are stonier: more grit and chips of rock in the sand
  if (hm > 0.3 && !speck && hash01(floor(cell) + vec2(-41.0, 19.0)) < 0.012 * hm) col = sandBand(min(band + 2, 4));

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
  outInfo = info;
  // indoors no ground is seen: the deck covers all of it inside the walls
  if (uRoomOn > 0.5) {
    outColor = vec4(ROOM_BLACK, 1.0);
    outInfo = vec4(0.5, 1.0, 0.0, 0.0);
  }
}
`;

export class Terrain {
  readonly mesh: Mesh;
  readonly cell: number;
  private offset = new Vector2();
  private readonly mat: ShaderMaterial;

  constructor(size = 128, segments = 224) {
    const geo = new PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    // the grid is never worn by the path (that is on the highland mesh)
    geo.setAttribute('aWorn', new Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1));
    this.cell = size / segments;
    this.mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { ...shared, uGridOffset: { value: this.offset }, uCut: { value: 0 } },
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
    });
    this.mesh = new Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  /**
   * The highlands' ground, drawn with a mesh of its own (the same shading, so
   * the same shader program); the grid stands aside for it.
   */
  addHighlands(scene: Object3D) {
    if (!HIGH.on) return;
    const mat = this.mat.clone();
    mat.uniforms = { ...shared, uGridOffset: { value: new Vector2() }, uCut: { value: 0 } };
    const mesh = new Mesh(highlandGeometry(), mat);
    mesh.renderOrder = -1;
    scene.add(mesh);
    this.mat.uniforms.uCut.value = HIGH_MESH - 1;
  }

  /** Keep the grid centred on the view, snapped so vertices never swim. */
  follow(x: number, z: number) {
    this.offset.set(Math.round(x / this.cell) * this.cell, Math.round(z / this.cell) * this.cell);
  }
}
