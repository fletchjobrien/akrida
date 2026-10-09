import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import { shared } from '../render/shared';
import { glslRgb } from '../render/palette';
import { gnoise } from './noise';

/** Height range the map can carve or heap, in world units (either way). */
const HEIGHT_RANGE = 0.16;

/** Dried blood of the blue creatures: grey blue, darker where it is fresher. */
export const BLOOD = {
  lit: 0x8a9bab,
  mid: 0x6c7e90,
  shade: 0x546273,
  deep: 0x3d4858,
};

/**
 * Marks painted onto the sand around the second pod: dried blood, the trough
 * a body dragged, gouges where hands clawed and hooves kicked, and sand churned
 * up by struggling. The terrain shader reads it (see STAIN_GLSL):
 *   r = blood, g = how fresh and dark the blood is,
 *   b = a small height offset (shading only), a = churned, lumpy sand.
 */
export class StainMap {
  readonly res: number;
  readonly tex: DataTexture;
  private readonly blood: Float32Array;
  private readonly dark: Float32Array;
  private readonly cut: Float32Array;
  private readonly lip: Float32Array;
  private readonly bump: Float32Array;
  private readonly churned: Float32Array;

  /** Covers the square from (minX, minZ) with sides `size`, at `perUnit` texels per world unit. */
  constructor(
    readonly minX: number,
    readonly minZ: number,
    readonly size: number,
    perUnit = 24,
  ) {
    this.res = Math.min(1024, Math.ceil(size * perUnit));
    const n = this.res * this.res;
    this.blood = new Float32Array(n);
    this.dark = new Float32Array(n);
    this.cut = new Float32Array(n);
    this.lip = new Float32Array(n);
    this.bump = new Float32Array(n);
    this.churned = new Float32Array(n);
    this.tex = new DataTexture(new Uint8Array(n * 4), this.res, this.res, RGBAFormat, UnsignedByteType);
    this.tex.magFilter = LinearFilter;
    this.tex.minFilter = LinearFilter;
    this.tex.generateMipmaps = false;
  }

  /** Call `fn` for every texel within `r` of (x, z) with the texel's world position and distance. */
  private each(x: number, z: number, r: number, fn: (i: number, wx: number, wz: number, d: number) => void) {
    const k = this.res / this.size;
    const i0 = Math.max(0, Math.floor((x - r - this.minX) * k));
    const i1 = Math.min(this.res - 1, Math.ceil((x + r - this.minX) * k));
    const j0 = Math.max(0, Math.floor((z - r - this.minZ) * k));
    const j1 = Math.min(this.res - 1, Math.ceil((z + r - this.minZ) * k));
    for (let j = j0; j <= j1; j++) {
      const wz = this.minZ + (j + 0.5) / k;
      for (let i = i0; i <= i1; i++) {
        const wx = this.minX + (i + 0.5) / k;
        const d = Math.hypot(wx - x, wz - z);
        if (d <= r) fn(j * this.res + i, wx, wz, d);
      }
    }
  }

  /** Same, for texels near the segment (x0, z0)-(x1, z1): `u` is 0..1 along it, `s` the signed distance across. */
  private eachSegment(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    r: number,
    fn: (i: number, u: number, s: number, wx: number, wz: number) => void,
  ) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = Math.max(1e-8, dx * dx + dz * dz);
    const len = Math.sqrt(len2);
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    this.each(mx, mz, len / 2 + r, (i, wx, wz) => {
      const u = Math.min(1, Math.max(0, ((wx - x0) * dx + (wz - z0) * dz) / len2));
      const s = ((wx - x0) * -dz + (wz - z0) * dx) / len;
      const d = Math.hypot(wx - x0 - dx * u, wz - z0 - dz * u);
      if (d <= r) fn(i, u, s, wx, wz);
    });
  }

  /** A blot of blood with a ragged edge. */
  splat(x: number, z: number, r: number, amount: number, fresh: number) {
    // a drop smaller than a texel still marks the one it fell on
    const k = this.res / this.size;
    if (r * k < 0.7) {
      const i = Math.floor((x - this.minX) * k);
      const j = Math.floor((z - this.minZ) * k);
      if (i < 0 || j < 0 || i >= this.res || j >= this.res) return;
      const n = j * this.res + i;
      const a = amount * Math.min(1, 0.55 + r * k);
      this.blood[n] = Math.max(this.blood[n], a);
      this.dark[n] = Math.max(this.dark[n], a * fresh);
      return;
    }
    this.each(x, z, r * 1.6, (i, wx, wz, d) => {
      const edge = 1 - d / (r * (1 + 0.45 * gnoise(wx * 9 + 3.1, wz * 9 - 1.7)));
      if (edge <= 0) return;
      const a = Math.min(1, edge * 2.2) * amount;
      this.blood[i] = Math.max(this.blood[i], a);
      this.dark[i] = Math.max(this.dark[i], a * fresh * Math.min(1, edge * 1.6));
    });
  }

  /** A smear of blood dragged along a segment, streaky along its length. */
  smear(x0: number, z0: number, x1: number, z1: number, w: number, amount: number, fresh: number) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    this.eachSegment(x0, z0, x1, z1, w * 1.5, (i, u, s, wx, wz) => {
      const streak = 0.7 + 0.6 * gnoise((s / w) * 2.6 + 11, u * len * 1.5);
      const across = 1 - Math.abs(s) / (w * (0.8 + 0.4 * gnoise(wx * 7, wz * 7)));
      const ends = Math.min(1, u * 5, (1 - u) * 3);
      const a = Math.max(0, Math.min(1, across * 2) * streak * ends) * amount;
      if (a <= 0) return;
      this.blood[i] = Math.max(this.blood[i], a);
      this.dark[i] = Math.max(this.dark[i], a * fresh * 0.8);
    });
  }

  /** A trough along a segment, with sand heaped on both lips. */
  groove(x0: number, z0: number, x1: number, z1: number, w: number, depth: number) {
    this.eachSegment(x0, z0, x1, z1, w * 2.6, (i, u, s) => {
      const ends = Math.min(1, u * 8 + 0.3, (1 - u) * 8 + 0.3);
      const c = depth * Math.exp(-((s / w) ** 2)) * ends;
      const l = depth * 0.5 * Math.exp(-(((Math.abs(s) - 1.6 * w) / (0.6 * w)) ** 2)) * ends;
      this.cut[i] = Math.max(this.cut[i], c);
      this.lip[i] = Math.max(this.lip[i], l);
    });
  }

  /** A hollow pressed into the sand (negative depth heaps it up instead). */
  dent(x: number, z: number, rx: number, rz: number, yaw: number, depth: number) {
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    this.each(x, z, Math.max(rx, rz) * 1.8, (i, wx, wz) => {
      const ox = wx - x;
      const oz = wz - z;
      const a = (ox * c - oz * sn) / rx;
      const b = (ox * sn + oz * c) / rz;
      const q = a * a + b * b;
      const c0 = depth * Math.exp(-q * 1.6);
      const l0 = Math.abs(depth) * 0.35 * Math.exp(-(((Math.sqrt(q) - 1.25) / 0.3) ** 2));
      if (depth > 0) {
        this.cut[i] = Math.max(this.cut[i], c0);
        this.lip[i] = Math.max(this.lip[i], l0);
      } else this.bump[i] -= c0;
    });
  }

  /** Sand thrown about by struggling: lumpy, with hollows and clods. */
  churn(x: number, z: number, r: number, amount: number, seed: number) {
    this.each(x, z, r, (i, wx, wz, d) => {
      const fall = Math.pow(1 - d / r, 0.7) * (0.75 + 0.5 * gnoise(wx * 2.3 + seed, wz * 2.3 - seed));
      if (fall <= 0) return;
      const lumps = gnoise(wx * 7.5 + seed * 3, wz * 7.5) * 0.7 + gnoise(wx * 17 - seed, wz * 17 + 5) * 0.3;
      this.bump[i] += lumps * 0.065 * fall * amount;
      this.churned[i] = Math.max(this.churned[i], Math.min(1, fall * 1.4) * amount);
    });
  }

  /** Pack everything into the texture and hand it to the shaders. */
  commit() {
    const data = this.tex.image.data as Uint8Array;
    const b = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let i = 0; i < this.blood.length; i++) {
      const h = this.bump[i] + this.lip[i] - this.cut[i];
      data[i * 4] = b(this.blood[i]);
      data[i * 4 + 1] = b(this.dark[i]);
      data[i * 4 + 2] = b(0.5 + h / (2 * HEIGHT_RANGE));
      data[i * 4 + 3] = b(this.churned[i]);
    }
    this.tex.needsUpdate = true;
    shared.uStainTex.value = this.tex;
    shared.uStainRect.value.set(this.minX, this.minZ, 1 / this.size, 1);
  }
}

/** Reading the stain map in the sand shaders. */
export const STAIN_GLSL = /* glsl */ `
uniform sampler2D uStainTex;
uniform vec4 uStainRect;
const vec3 BLOOD_LIT = ${glslRgb(BLOOD.lit)};
const vec3 BLOOD_MID = ${glslRgb(BLOOD.mid)};
const vec3 BLOOD_SHADE = ${glslRgb(BLOOD.shade)};
const vec3 BLOOD_DEEP = ${glslRgb(BLOOD.deep)};
vec4 stainAt(vec2 p) {
  if (uStainRect.w < 0.5) return vec4(0.0, 0.0, 0.5, 0.0);
  vec2 uv = (p - uStainRect.xy) * uStainRect.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.5, 0.0);
  return texture(uStainTex, uv);
}
float stainHeight(vec4 s) {
  return (s.b - 0.5) * ${(2 * HEIGHT_RANGE).toFixed(4)};
}
`;
