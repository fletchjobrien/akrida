/**
 * Deterministic noise shared by the CPU (gameplay: foot placement, rock
 * placement, collisions) and the GPU (terrain rendering). Both sides use the
 * same 32-bit integer hash so the ground the creature stands on is the ground
 * that is drawn.
 */

const OFF = 1 << 20;

export function hashU(x: number, y: number): number {
  let h = (Math.imul((x + OFF) | 0, 0x5f356495) ^ Math.imul((y + OFF) | 0, 0x2c1b3c6d)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash01(x: number, y: number): number {
  return (hashU(x, y) >>> 8) / 16777216;
}

function grad(ix: number, iy: number, fx: number, fy: number): number {
  const h = hashU(ix, iy);
  const gx = (h & 0xffff) / 65535 - 0.5;
  const gy = (h >>> 16) / 65535 - 0.5;
  return gx * fx + gy * fy;
}

/** Gradient noise, roughly in [-0.5, 0.5]. */
export function gnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = grad(ix, iy, fx, fy);
  const b = grad(ix + 1, iy, fx - 1, fy);
  const c = grad(ix, iy + 1, fx, fy - 1);
  const d = grad(ix + 1, iy + 1, fx - 1, fy - 1);
  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 2.0;
}

export function fbm(x: number, y: number, octaves: number): number {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < octaves; i++) {
    s += a * gnoise(x, y);
    const nx = 0.8 * x + 0.6 * y;
    const ny = -0.6 * x + 0.8 * y;
    x = nx * 2.03 + 11.7;
    y = ny * 2.03 - 4.3;
    a *= 0.5;
  }
  return s;
}

export const NOISE_GLSL = /* glsl */ `
uint hashU(ivec2 p) {
  uvec2 q = uvec2(p + 1048576);
  uint h = (q.x * 0x5f356495u) ^ (q.y * 0x2c1b3c6du);
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}
float hash01(ivec2 p) { return float(hashU(p) >> 8u) / 16777216.0; }
float hash01(vec2 p) { return hash01(ivec2(floor(p))); }

float gradDot(ivec2 i, vec2 f) {
  uint h = hashU(i);
  vec2 g = vec2(float(h & 0xffffu), float(h >> 16u)) / 65535.0 - 0.5;
  return dot(g, f);
}

float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 ii = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = gradDot(ii, f);
  float b = gradDot(ii + ivec2(1, 0), f - vec2(1.0, 0.0));
  float c = gradDot(ii + ivec2(0, 1), f - vec2(0.0, 1.0));
  float d = gradDot(ii + ivec2(1, 1), f - vec2(1.0, 1.0));
  float ab = a + (b - a) * u.x;
  float cd = c + (d - c) * u.x;
  return (ab + (cd - ab) * u.y) * 2.0;
}

float fbm(vec2 p, int octaves) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < octaves; i++) {
    s += a * gnoise(p);
    p = vec2(0.8 * p.x + 0.6 * p.y, -0.6 * p.x + 0.8 * p.y) * 2.03 + vec2(11.7, -4.3);
    a *= 0.5;
  }
  return s;
}
`;
