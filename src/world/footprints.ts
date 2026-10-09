import {
  DynamicDrawUsage,
  GLSL3,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { LIGHTING_GLSL, shared } from '../render/shared';
import { SAND_GLSL, terrainNormal } from './terrain';

const VERT = /* glsl */ `
in float aBirth;
out vec3 vWorldPos;
out float vBirth;
out vec2 vUv;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vBirth = aBirth;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
${LIGHTING_GLSL}
${SAND_GLSL}
uniform float uLife;
in vec3 vWorldPos;
in float vBirth;
in vec2 vUv;
void main() {
  float age = uTime - vBirth;
  float d = worldDither();
  float alive = 1.0 - smoothstep(uLife * 0.45, uLife, age);
  // cloven hoof: two lobes
  vec2 q = vUv * 2.0 - 1.0;
  if (abs(q.x) < 0.12 && q.y > -0.3) discard;
  if (alive <= d) discard;
  vec3 n = sandNormal(vWorldPos.xz);
  // fresh prints are deep and dark, then soften as sand drifts back in
  float fresh = 1.0 - smoothstep(uLife * 0.1, uLife * 0.3, age);
  int band = sandBandIndex(vWorldPos, n, d, fresh > d ? 2.0 : 1.0);
  outColor = vec4(sandBand(max(band, 2)), 1.0);
  outInfo = vec4(0.5, 1.0, 0.0, 0.0);
}
`;

/** Hoof prints pressed into the sand, slowly filled in again by the wind. */
export class Footprints {
  readonly mesh: InstancedMesh;
  private readonly birth: InstancedBufferAttribute;
  private next = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly qy = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly n = new Vector3();
  private readonly up = new Vector3(0, 1, 0);

  constructor(private readonly capacity = 500, life = 50) {
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { ...shared, uLife: { value: life } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.birth = new InstancedBufferAttribute(new Float32Array(capacity).fill(-1e6), 1);
    this.birth.setUsage(DynamicDrawUsage);
    geo.setAttribute('aBirth', this.birth);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  add(x: number, y: number, z: number, yaw: number, time: number, size = 1) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    terrainNormal(x, z, this.n);
    this.q.setFromUnitVectors(this.up, this.n);
    this.qy.setFromAxisAngle(this.up, yaw);
    this.q.multiply(this.qy);
    this.p.set(x, y + 0.003, z);
    this.s.set(0.11 * size, 1, 0.14 * size);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.birth.setX(i, time);
    this.birth.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
  }
}
