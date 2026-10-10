import { DoubleSide, GLSL3, ShaderMaterial, Vector3 } from 'three';
import { LIGHTING_GLSL, shared } from './shared';
import { rgb } from './palette';

const VERT = /* glsl */ `
out vec3 vWorldPos;
out vec3 vWorldNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
${LIGHTING_GLSL}
uniform vec3 uColor;
uniform vec3 uShine;
uniform float uDensity;
in vec3 vWorldPos;
in vec3 vWorldNormal;
void main() {
  // see-through the pixel-art way: only some of the pixels are drawn
  if (worldDither() >= uDensity) discard;
  vec3 n = normalize(vWorldNormal);
  if (!gl_FrontFacing) n = -n;
  float l = max(max(dot(n, uSunDir), 0.0) * shadowAt(vWorldPos, n), roomLight(vWorldPos, n));
  vec3 col = l > 0.55 ? uShine : uColor;
  outColor = vec4(col, 1.0);
  outInfo = vec4(0.5, 1.0, 0.0, 0.0);
}
`;

/**
 * A see-through surface for glass and liquids: a share (`density`) of its
 * pixels drawn in a fixed, world-anchored dither, so what is behind shows
 * through it, as in old pixel-art games.
 */
export function ditherMaterial(color: number, shine: number, density: number) {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      ...shared,
      uColor: { value: rgb(color) },
      uShine: { value: rgb(shine) },
      uDensity: { value: density },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: DoubleSide,
  });
}

export type DitherMaterial = ShaderMaterial & { uniforms: { uColor: { value: Vector3 }; uDensity: { value: number } } };
