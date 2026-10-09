import {
  GLSL3,
  Matrix4,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from 'three';
import { NOISE_GLSL } from '../world/noise';
import { glslRgb, PALETTE, rgb } from './palette';

/** Uniforms shared by every material in the main pass (passed by reference). */
export const shared = {
  uSunDir: { value: new Vector3(0.6, 0.76, 0.24).normalize() },
  uShadowMap: { value: null as Texture | null },
  uShadowMatrix: { value: new Matrix4() },
  uTime: { value: 0 },
  uCloudOffset: { value: new Vector2(0, 0) },
  uCloudCover: { value: 0.16 },
  uCamTexel: { value: new Vector2(0, 0) },
  uWindDir: { value: new Vector2(-0.963, -0.27) },
  uWindStrength: { value: 0.4 },
  uWindTravel: { value: 0 },
  /** The crash site (see world/crater.ts): centre x, z and travel direction x, z. */
  uSite: { value: new Vector4(0, 0, 1, 0) },
  uSiteOn: { value: 0 },
  /** The second pod (see world/crater.ts): position x, z and skid direction x, z. */
  uSite2: { value: new Vector4(0, 0, 1, 0) },
  /** Its survivor's trail: bend x, z and end x, z. */
  uSite2Trail: { value: new Vector4(0, 0, 0, 0) },
  uSite2On: { value: 0 },
  /** The ship (see world/crater.ts): centre x, z and bow direction x, z. */
  uSite3: { value: new Vector4(0, 0, 1, 0) },
  uSite3On: { value: 0 },
  /** Blood, churned sand and drag marks painted on the ground (see world/stains.ts). */
  uStainTex: { value: null as Texture | null },
  /** Area the stain map covers: min x, min z, 1 / size, and 1 when it is in use. */
  uStainRect: { value: new Vector4(0, 0, 1, 0) },
  uPixelWorld: { value: new Vector2(1 / 18, 1 / 18) },
};

export const LIGHTING_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uTime;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform vec2 uCamTexel;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindTravel;
uniform vec2 uPixelWorld;

${NOISE_GLSL}

// 4x4 ordered dither, anchored to the world (camera texel offset) so the
// pattern never crawls when the camera scrolls.
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                                3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0;
}
float worldDither() { return bayer4(floor(gl_FragCoord.xy) + uCamTexel); }

float shadowAt(vec3 wp, vec3 n) {
  vec4 sc = uShadowMatrix * vec4(wp + n * 0.035, 1.0);
  vec3 c = sc.xyz / sc.w;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float d = texture(uShadowMap, c.xy).r;
  return (c.z - 0.0012) > d ? 0.0 : 1.0;
}

// Soft drifting cloud shadows, returns 0..1 coverage before thresholding.
float cloudField(vec2 xz) {
  return fbm(xz * 0.016 + uCloudOffset, 3) + gnoise(xz * 0.05 + uCloudOffset * 2.3) * 0.08;
}
float cloudShadowAt(vec2 xz, float dither) {
  float c = cloudField(xz);
  return step(uCloudCover + (dither - 0.5) * 0.008, c);
}
`;

export const TOON_VERT = /* glsl */ `
out vec3 vWorldPos;
out vec3 vWorldNormal;
out vec3 vViewNormal;
out vec3 vLocalPos;
void main() {
  vLocalPos = position;
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = m * instanceMatrix;
#endif
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  mat3 nm = transpose(inverse(mat3(m)));
  vec3 wn = normalize(nm * normal);
  vWorldNormal = wn;
  vViewNormal = normalize(mat3(viewMatrix) * wn);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const TOON_FRAG = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
${LIGHTING_GLSL}
uniform vec3 uDark;
uniform vec3 uMid;
uniform vec3 uLight;
uniform float uLitAt;
uniform float uMidAt;
uniform float uOutline;
uniform float uHighlight;
uniform float uUnlit;
uniform float uDust;
in vec3 vLocalPos;
in vec3 vWorldPos;
in vec3 vWorldNormal;
in vec3 vViewNormal;
void main() {
  vec3 n = normalize(vWorldNormal);
  if (!gl_FrontFacing) n = -n;
  float ndl = dot(n, uSunDir);
  float sh = shadowAt(vWorldPos, n);
  float d = worldDither();
  float cl = cloudShadowAt(vWorldPos.xz, d);
  float l = ndl * sh * (1.0 - 0.5 * cl);
  vec3 col = l > uLitAt ? uLight : (l > uMidAt ? uMid : uDark);
  col = mix(col, uLight, uUnlit);
  // a coat of sand, thickest on surfaces that face up; it thins out as uDust falls
  if (uDust > 0.0) {
    vec3 c = floor(vLocalPos * 18.0);
    float h = hash01(ivec2(int(c.x) + int(c.y) * 131, int(c.z) * 7 + int(c.y)));
    float cover = uDust * mix(0.05, 0.62, smoothstep(-0.2, 0.9, n.y));
    if (h < cover) {
      col = l > uLitAt ? ${glslRgb(PALETTE.sandLit)} : (l > uMidAt ? ${glslRgb(PALETTE.sandMid)} : ${glslRgb(PALETTE.sandShade)});
    }
  }
  outColor = vec4(col, 1.0);
  vec3 vn = normalize(vViewNormal);
  outInfo = vec4(vn.xy * 0.5 + 0.5, uOutline, uHighlight);
}
`;

export interface ToonOptions {
  dark: number;
  mid: number;
  light: number;
  litAt?: number;
  midAt?: number;
  outline?: number;
  highlight?: number;
  unlit?: boolean;
  /** Shared sand-coat amount (0..1), for the creature waking up half buried. */
  dust?: { value: number };
}

export function toonMaterial(o: ToonOptions): ShaderMaterial {
  const uniforms: Record<string, IUniform> = {
    ...shared,
    uDark: { value: rgb(o.dark) },
    uMid: { value: rgb(o.mid) },
    uLight: { value: rgb(o.light) },
    uLitAt: { value: o.litAt ?? 0.55 },
    uMidAt: { value: o.midAt ?? 0.02 },
    uOutline: { value: o.outline ?? 1 },
    uHighlight: { value: o.highlight ?? 0 },
    uUnlit: { value: o.unlit ? 1 : 0 },
    uDust: o.dust ?? { value: 0 },
  };
  return new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms,
    vertexShader: TOON_VERT,
    fragmentShader: TOON_FRAG,
  });
}
