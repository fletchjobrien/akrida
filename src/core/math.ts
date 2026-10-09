import { Vector3 } from 'three';

export const TAU = Math.PI * 2;

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const saturate = (x: number) => clamp(x, 0, 1);
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach. `rate` is in 1/s. */
export const damp = (a: number, b: number, rate: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-rate * dt));

/** Wrap an angle to (-PI, PI]. */
export const wrapAngle = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Returns `target` shifted by multiples of TAU so it is closest to `current`. */
export const unwrapNear = (current: number, target: number) => current + wrapAngle(target - current);

/**
 * Second-order dynamics, after t3ssel8r's "Giving Personality to Procedural
 * Animations using Math". f = natural frequency (Hz), z = damping ratio,
 * r = initial response (r < 0 anticipates, r > 1 overshoots).
 */
export class Dyn {
  private k1: number;
  private k2: number;
  private k3: number;
  private xp: number;
  y: number;
  yd = 0;

  constructor(f: number, z: number, r: number, x0 = 0) {
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / ((TAU * f) * (TAU * f));
    this.k3 = (r * z) / (TAU * f);
    this.xp = x0;
    this.y = x0;
  }

  setParams(f: number, z: number, r: number) {
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / ((TAU * f) * (TAU * f));
    this.k3 = (r * z) / (TAU * f);
  }

  reset(x: number) {
    this.xp = x;
    this.y = x;
    this.yd = 0;
  }

  update(dt: number, x: number, xd?: number): number {
    if (dt <= 0) return this.y;
    if (xd === undefined) {
      xd = (x - this.xp) / dt;
      this.xp = x;
    }
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    this.y += dt * this.yd;
    this.yd += (dt * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
}

/** Angle version of Dyn that follows the shortest way around the circle. */
export class DynAngle {
  private d: Dyn;
  private target: number;
  constructor(f: number, z: number, r: number, x0 = 0) {
    this.d = new Dyn(f, z, r, x0);
    this.target = x0;
  }
  get y() {
    return this.d.y;
  }
  get yd() {
    return this.d.yd;
  }
  reset(x: number) {
    this.target = x;
    this.d.reset(x);
  }
  setParams(f: number, z: number, r: number) {
    this.d.setParams(f, z, r);
  }
  update(dt: number, x: number) {
    this.target = unwrapNear(this.d.y, x);
    // keep internal previous-input continuous so the velocity term does not spike on wrap
    return this.d.update(dt, this.target);
  }
}

export class DynVec3 {
  private xp = new Vector3();
  readonly y = new Vector3();
  readonly yd = new Vector3();
  private k1 = 0;
  private k2 = 0;
  private k3 = 0;
  private tmp = new Vector3();

  constructor(f: number, z: number, r: number, x0?: Vector3) {
    this.setParams(f, z, r);
    if (x0) this.reset(x0);
  }

  setParams(f: number, z: number, r: number) {
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / ((TAU * f) * (TAU * f));
    this.k3 = (r * z) / (TAU * f);
  }

  reset(x: Vector3) {
    this.xp.copy(x);
    this.y.copy(x);
    this.yd.set(0, 0, 0);
  }

  update(dt: number, x: Vector3): Vector3 {
    if (dt <= 0) return this.y;
    const xd = this.tmp.copy(x).sub(this.xp).divideScalar(dt);
    this.xp.copy(x);
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    this.y.addScaledVector(this.yd, dt);
    // yd += dt * (x + k3*xd - y - k1*yd) / k2
    xd.multiplyScalar(this.k3).add(x).sub(this.y).addScaledVector(this.yd, -this.k1);
    this.yd.addScaledVector(xd, dt / k2);
    return this.y;
  }
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1D value noise for organic idle motion. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    let t = Math.imul((n + seed * 7919) | 0, 0x27d4eb2d) >>> 0;
    t ^= t >>> 15;
    t = Math.imul(t, 0x85ebca6b) >>> 0;
    t ^= t >>> 13;
    return (t >>> 8) / 16777216;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
}
