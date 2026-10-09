import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  GLSL3,
  LineSegments,
  Points,
  ShaderMaterial,
} from 'three';
import { LIGHTING_GLSL, shared } from '../render/shared';
import { PALETTE, rgb } from '../render/palette';
import type { Wind } from './wind';

const PARTICLE_VERT = /* glsl */ `
in vec3 aColor;
in float aFade;
in float aSize;
out vec3 vColor;
out float vFade;
void main() {
  vColor = aColor;
  vFade = aFade;
  gl_PointSize = aSize;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
${LIGHTING_GLSL}
in vec3 vColor;
in float vFade;
void main() {
  if (vFade <= worldDither()) discard;
  outColor = vec4(vColor, 1.0);
  outInfo = vec4(0.5, 1.0, 0.0, 0.0);
}
`;

function particleMaterial() {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: { ...shared },
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
  });
}

const C_HI = rgb(PALETTE.sandHi).toArray();
const C_MID = rgb(PALETTE.sandMid).toArray();
const C_SHADE = rgb(PALETTE.sandShade).toArray();

interface Streak {
  x: number;
  y: number;
  z: number;
  hop: number;
  speed: number;
  life: number;
  max: number;
  dark: boolean;
}

/** Grains of sand skimming over the ground in the wind, drawn as 1px streaks. */
export class SandStreaks {
  readonly mesh: LineSegments;
  private readonly list: Streak[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly fade: Float32Array;
  private readonly geo: BufferGeometry;

  constructor(private readonly capacity = 520) {
    this.geo = new BufferGeometry();
    this.pos = new Float32Array(capacity * 6);
    this.col = new Float32Array(capacity * 6);
    this.fade = new Float32Array(capacity * 2);
    const size = new Float32Array(capacity * 2).fill(1);
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('aColor', new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('aFade', new BufferAttribute(this.fade, 1).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('aSize', new BufferAttribute(size, 1));
    this.mesh = new LineSegments(this.geo, particleMaterial());
    this.mesh.frustumCulled = false;
  }

  update(
    dt: number,
    wind: Wind,
    cx: number,
    cz: number,
    halfW: number,
    halfD: number,
    height: (x: number, z: number) => number,
  ) {
    const s = wind.strength;
    // same density on screen at any zoom: more grains when more ground is in view
    const area = Math.min(2, Math.max(0.5, (halfW * halfD) / 200));
    const want = Math.min(this.capacity, Math.floor(260 * area * Math.max(0, (s - 0.18) / 0.82) ** 1.4));
    const wx = wind.dir.x;
    const wz = wind.dir.y;
    // spawn upwind of the view so streaks enter from the edge, or anywhere at first
    let spawn = Math.min(want - this.list.length, Math.ceil(dt * 120));
    while (spawn-- > 0) {
      const max = 0.8 + Math.random() * 1.8;
      const x = cx + (Math.random() * 2 - 1) * halfW * 1.1;
      const z = cz + (Math.random() * 2 - 1) * halfD * 1.1;
      this.list.push({
        x,
        y: 0,
        z,
        hop: Math.random() < 0.8 ? 0.03 + Math.random() * 0.12 : 0.2 + Math.random() * 0.6,
        speed: 0.7 + Math.random() * 0.6,
        life: 0,
        max,
        dark: Math.random() < 0.55,
      });
    }

    const v = 2.5 + s * 9;
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life += dt;
      if (p.life > p.max || Math.abs(p.x - cx) > halfW * 1.4 || Math.abs(p.z - cz) > halfD * 1.4) {
        this.list[i] = this.list[this.list.length - 1];
        this.list.pop();
        continue;
      }
      const sp = v * p.speed * (0.8 + wind.flutter * 0.25);
      p.x += wx * sp * dt;
      p.z += wz * sp * dt;
      const ground = height(p.x, p.z);
      const bounce = Math.abs(Math.sin(p.life * 7 * p.speed + p.max * 10));
      p.y = ground + p.hop * (0.4 + 0.6 * bounce) + 0.02;
      if (n >= this.capacity) continue;
      const len = 0.035 * sp;
      const k = n * 6;
      this.pos[k] = p.x;
      this.pos[k + 1] = p.y;
      this.pos[k + 2] = p.z;
      this.pos[k + 3] = p.x - wx * len;
      this.pos[k + 4] = p.y - 0.01;
      this.pos[k + 5] = p.z - wz * len;
      const c = p.dark ? C_SHADE : C_HI;
      for (let j = 0; j < 2; j++) {
        this.col[k + j * 3] = c[0];
        this.col[k + j * 3 + 1] = c[1];
        this.col[k + j * 3 + 2] = c[2];
      }
      const lifeFade = Math.min(1, p.life * 3, (p.max - p.life) * 3);
      this.fade[n * 2] = lifeFade;
      this.fade[n * 2 + 1] = lifeFade * 0.45;
      n++;
    }
    this.geo.setDrawRange(0, n * 2);
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aFade') as BufferAttribute).needsUpdate = true;
  }
}

interface Mote {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  c: number[];
  size: number;
}

/** Sand kicked up by hooves. */
export class Dust {
  readonly mesh: Points;
  private readonly list: Mote[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly fade: Float32Array;
  private readonly size: Float32Array;
  private readonly geo: BufferGeometry;

  constructor(private readonly capacity = 400) {
    this.geo = new BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.fade = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('aColor', new BufferAttribute(this.col, 3).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('aFade', new BufferAttribute(this.fade, 1).setUsage(DynamicDrawUsage));
    this.geo.setAttribute('aSize', new BufferAttribute(this.size, 1).setUsage(DynamicDrawUsage));
    this.mesh = new Points(this.geo, particleMaterial());
    this.mesh.frustumCulled = false;
  }

  /** Spray sand at a hoof. `dirX/dirZ` is the direction of travel. */
  kick(x: number, y: number, z: number, dirX: number, dirZ: number, amount: number, power: number) {
    for (let i = 0; i < amount; i++) {
      if (this.list.length >= this.capacity) this.list.shift();
      const spread = (Math.random() - 0.5) * 1.6;
      const back = -(0.4 + Math.random()) * power;
      const side = spread * 0.6 * power;
      this.list.push({
        x: x + (Math.random() - 0.5) * 0.12,
        y: y + 0.02,
        z: z + (Math.random() - 0.5) * 0.12,
        vx: dirX * back - dirZ * side + (Math.random() - 0.5) * 0.4,
        vy: (0.6 + Math.random() * 1.6) * (0.5 + power * 0.5),
        vz: dirZ * back + dirX * side + (Math.random() - 0.5) * 0.4,
        life: 0,
        max: 0.35 + Math.random() * 0.5,
        c: Math.random() < 0.6 ? C_MID : C_SHADE,
        size: Math.random() < 0.2 ? 2 : 1,
      });
    }
  }

  update(dt: number, wind: Wind, height: (x: number, z: number) => number) {
    let n = 0;
    const ws = wind.strength * 2.5;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life += dt;
      if (p.life > p.max) {
        this.list.splice(i, 1);
        continue;
      }
      p.vy -= 9.0 * dt;
      const drag = Math.exp(-2.2 * dt);
      p.vx = p.vx * drag + wind.dir.x * ws * dt;
      p.vz = p.vz * drag + wind.dir.y * ws * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const g = height(p.x, p.z);
      if (p.y < g) {
        p.y = g;
        p.vy *= -0.2;
        p.vx *= 0.5;
        p.vz *= 0.5;
      }
      const k = n * 3;
      this.pos[k] = p.x;
      this.pos[k + 1] = p.y;
      this.pos[k + 2] = p.z;
      this.col[k] = p.c[0];
      this.col[k + 1] = p.c[1];
      this.col[k + 2] = p.c[2];
      this.fade[n] = Math.min(1, (p.max - p.life) * 4);
      this.size[n] = p.size;
      n++;
    }
    this.geo.setDrawRange(0, n);
    for (const name of ['position', 'aColor', 'aFade', 'aSize']) {
      (this.geo.getAttribute(name) as BufferAttribute).needsUpdate = true;
    }
  }
}
