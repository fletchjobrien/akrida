import { AddEquation, CustomBlending, GLSL3, Mesh, OneFactor, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { ROOM_GLSL, shared } from './shared';

const GLOW_VERT = /* glsl */ `
uniform float uSize;
uniform float uLift;
uniform float uFlat;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vUv = uv * 2.0 - 1.0;
  vWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  if (uFlat > 0.5) {
    // a pool of light lying on the ground
    vec4 wp = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    wp.xz += position.xy * uSize;
    gl_Position = projectionMatrix * viewMatrix * wp;
  } else {
    // a halo that always faces the camera, nudged toward it so its source does not hide it
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uSize;
    mv.z += uLift;
    gl_Position = projectionMatrix * mv;
  }
}
`;

const GLOW_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
uniform vec3 uColor;
uniform float uStrength;
uniform float uCore;
uniform vec2 uCamTexel;
${ROOM_GLSL}
in vec2 vUv;
in vec3 vWorld;
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                                3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0;
}
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float fall = 1.0 - r;
  float v = uStrength * (fall * fall * 0.75 + uCore * smoothstep(0.32, 0.0, r));
  // a few hard steps, dithered between, so the light reads as pixel art
  float q = floor(v * 4.0 + bayer4(floor(gl_FragCoord.xy) + uCamTexel)) / 4.0;
  if (q <= 0.0) discard;
  outColor = vec4(uColor * q, 1.0);
  outInfo = vec4(0.0);
}
`;

/**
 * Additive light: a soft halo round a lamp, or (flat) a pool of it on the
 * ground. Adds to the colour only; the outline and normal info stay as drawn.
 */
export class Glow extends Mesh<PlaneGeometry, ShaderMaterial> {
  constructor(color: Vector3, size: number, opts: { flat?: boolean; lift?: number; core?: number } = {}) {
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: {
        uColor: { value: color.clone() },
        uSize: { value: size },
        uStrength: { value: 1 },
        uCore: { value: opts.core ?? 0.5 },
        uLift: { value: opts.lift ?? 0.15 },
        uFlat: { value: opts.flat ? 1 : 0 },
        uCamTexel: shared.uCamTexel,
        uRoomInv: shared.uRoomInv,
        uRoomOn: shared.uRoomOn,
      },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    });
    super(new PlaneGeometry(2, 2), mat);
    this.frustumCulled = false;
    this.renderOrder = 5;
  }

  set strength(v: number) {
    this.material.uniforms.uStrength.value = v;
    this.visible = v > 0.01;
  }

  get color(): Vector3 {
    return this.material.uniforms.uColor.value as Vector3;
  }
}
