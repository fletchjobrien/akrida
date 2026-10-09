import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
  GLSL3,
  Group,
  IcosahedronGeometry,
  Mesh,
  NearestFilter,
  Object3D,
  PlaneGeometry,
  RGBAFormat,
  Raycaster,
  ShaderMaterial,
  TorusGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { clamp, noise1, rng, smoothstep } from '../core/math';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { SHIP_LENGTH, SHIP_TRENCH, SITE3 } from './crater';
import { terrainHeight } from './terrain';
import { footprintOf, type Rocks } from './rocks';
import type { Dust } from './particles';
import type { Wind } from './wind';
import type { AudioEngine } from '../audio/AudioEngine';
import { PAD_TONES, TUNE } from '../story/tune';

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

const C = (hex: number) => rgb(hex).toArray();
const SMOKE_DARK = C(0x2e2826);
const SMOKE_MID = C(0x5a514c);
const SMOKE_LIGHT = C(0xa89f96);
const FIRE_HOT = C(0xfff0a8);
const FIRE_COOL = C(0xc8401c);
const SPARK_HOT = C(0xfff4c8);
const SPARK_COOL = C(0xd9824a);
const FLASH = C(0xfffbe8);
const SAND = [C(0xe4c987), C(0xbca872)];
const ARC_HOT = C(0xf2fbff);
const ARC_COOL = C(0x6aa8ff);

/** Flame colours, hottest last. */
const FLAME = [rgb(0x7a1c10), rgb(0xc8401c), rgb(0xf08a2c), rgb(0xffd060), rgb(0xfff4c0)];

/**
 * The hull is lofted through these stations, aft to bow: half-width w, half-height
 * h and the height y of the section's centre. The section is angular, not round:
 * sloped upper flanks meeting vertical lower flanks at a sharp chine, a flat top,
 * chamfered keel, and a beak of a prow that droops.
 */
interface Station {
  x: number;
  w: number;
  h: number;
  y: number;
}
const STATIONS: Station[] = [
  { x: -10.2, w: 1.75, h: 1.2, y: 0.05 },
  { x: -9.4, w: 2.25, h: 1.5, y: 0 },
  { x: -6, w: 2.45, h: 1.62, y: 0 },
  { x: 1, w: 2.45, h: 1.6, y: 0 },
  { x: 4.5, w: 2.2, h: 1.42, y: -0.05 },
  { x: 7, w: 1.5, h: 0.92, y: -0.22 },
  { x: 9, w: 0.7, h: 0.42, y: -0.45 },
  { x: 10.4, w: 0.06, h: 0.05, y: -0.62 },
];
/** Where its back broke. */
const BREAK = -1.25;
/** How far its centre sits above the trench floor (its keel is buried). */
const RIDE = 1.0;
/** The airlock door, cut into the near flank: stations it spans and heights (ship space). */
const DOOR = { x0: -3.875, x1: -2.925, y0: -0.96, y1: 0.54 };

function stationAt(x: number): Station {
  if (x <= STATIONS[0].x) return STATIONS[0];
  for (let i = 1; i < STATIONS.length; i++) {
    const b = STATIONS[i];
    if (x <= b.x) {
      const a = STATIONS[i - 1];
      const t = (x - a.x) / (b.x - a.x);
      return { x, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return STATIONS[STATIONS.length - 1];
}

/**
 * The hull's cross-section at station x, as (z, y) points round the outside.
 * `cs` is the side the door is on; its two corners are part of every section so
 * the loft can leave a hole there. Returns the points and the door edge's index.
 */
function hullSection(x: number, cs: number, inflate = 0): { pts: [number, number][]; door: number } {
  const st = stationAt(x);
  const w = st.w + inflate;
  const h = st.h + inflate;
  const y = st.y;
  const shoulder = 0.5 * h;
  const keel = -0.65 * h;
  const clampY = (v: number) => Math.min(shoulder, Math.max(keel, v - y)) + y;
  const near: [number, number][] = [
    [0.58 * w, h + y],
    [w, shoulder + y],
    [w, clampY(DOOR.y1)],
    [w, clampY(DOOR.y0)],
    [w, keel + y],
    [0.7 * w, -h + y],
  ];
  const far: [number, number][] = [
    [-0.7 * w, -h + y],
    [-w, keel + y],
    [-w, shoulder + y],
    [-0.58 * w, h + y],
  ];
  // on the -z side, mirrored (the loft turns every face outward whatever the winding)
  return { pts: [...near, ...far].map(([z, yy]) => [cs * z, yy] as [number, number]), door: 2 };
}

/**
 * Loft a closed section along stations xs: quads between neighbouring sections,
 * faces turned outward, ends optionally capped. `skip(i, k)` leaves out the face
 * between stations i, i+1 on edge k.
 */
function loft(
  xs: number[],
  section: (x: number) => [number, number][],
  centre: (x: number) => [number, number],
  offsetX = 0,
  skip?: (i: number, k: number) => boolean,
  caps: [boolean, boolean] = [false, false],
) {
  const pos: number[] = [];
  const tri = (a: number[], b: number[], c: number[], out: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) pos.push(...a, ...c, ...b);
    else pos.push(...a, ...b, ...c);
  };
  const secs = xs.map((x) => section(x));
  for (let i = 0; i < xs.length - 1; i++) {
    const A = secs[i];
    const B = secs[i + 1];
    const n = A.length;
    for (let k = 0; k < n; k++) {
      if (skip?.(i, k)) continue;
      const k2 = (k + 1) % n;
      const p00 = [xs[i] - offsetX, A[k][1], A[k][0]];
      const p01 = [xs[i] - offsetX, A[k2][1], A[k2][0]];
      const p10 = [xs[i + 1] - offsetX, B[k][1], B[k][0]];
      const p11 = [xs[i + 1] - offsetX, B[k2][1], B[k2][0]];
      // outward: from the section's centre toward the middle of this edge
      const [cy, cz] = centre((xs[i] + xs[i + 1]) / 2);
      const out = [0, (A[k][1] + A[k2][1]) / 2 - cy, (A[k][0] + A[k2][0]) / 2 - cz];
      tri(p00, p01, p11, out);
      tri(p00, p11, p10, out);
    }
  }
  caps.forEach((on, e) => {
    if (!on) return;
    const i = e === 0 ? 0 : xs.length - 1;
    const S = secs[i];
    const x = xs[i] - offsetX;
    const [cy, cz] = centre(xs[i]);
    for (let k = 0; k < S.length; k++) {
      const k2 = (k + 1) % S.length;
      tri([x, cy, cz], [x, S[k][1], S[k][0]], [x, S[k2][1], S[k2][0]], [e === 0 ? -1 : 1, 0, 0]);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Stations from x0 to x1: the hull's own, plus any extras, in order. */
function stationsBetween(x0: number, x1: number, extra: number[] = []) {
  const xs = [x0, ...STATIONS.map((s) => s.x), ...extra].filter((x) => x >= x0 && x <= x1);
  xs.push(x1);
  return [...new Set(xs.map((x) => +x.toFixed(4)))].sort((a, b) => a - b);
}

/** 7x7 glyphs for the keypad: an alien script, one per button. */
const GLYPHS = [
  ['...#...', '..#.#..', '.#...#.', '.#.#.#.', '..#.#..', '...#...', '.#####.'],
  ['#..#...', '#.#.#..', '##...#.', '#....#.', '#...#..', '#..#...', '####..#'],
  ['..##...', '.#..#..', '....#..', '..##.#.', '.#....#', '.#.#..#', '..#.##.'],
  ['...##..', '..#..#.', '..#....', '###..##', '..#...#', '..#..#.', '...##..'],
  ['#.....#', '#.###.#', '#.#.#.#', '#.#...#', '#.####.', '#......', '.##.##.'],
  ['..#....', '.#.#...', '#...#..', '.#...#.', '..#...#', '...#.#.', '....#..'],
  ['.#...#.', '#.#.#.#', '...#...', '...#...', '..###..', '.#...#.', '..#.#..'],
  ['###....', '#..#...', '#...#..', '.#...##', '..#....', '...#.#.', '....#..'],
  ['..#.#..', '..#.#..', '.#...#.', '#..#..#', '.#...#.', '..###..', '...#...'],
];

function glyphTexture() {
  const w = 7 * GLYPHS.length;
  const data = new Uint8Array(w * 7 * 4);
  GLYPHS.forEach((g, k) => {
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        // texture rows run bottom up
        const i = ((6 - row) * w + k * 7 + col) * 4;
        const on = g[row][col] === '#' ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = on;
        data[i + 3] = 255;
      }
    }
  });
  const tex = new DataTexture(data, w, 7, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const GLYPH_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLYPH_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outInfo;
uniform sampler2D uGlyphs;
uniform float uIndex;
uniform float uCount;
uniform vec3 uInk;
uniform vec3 uBase;
in vec2 vUv;
void main() {
  // a 9x9 cell: the 7x7 glyph with a one-pixel margin
  vec2 px = floor(clamp(vUv, 0.0, 0.999) * 9.0);
  float on = 0.0;
  if (px.x >= 1.0 && px.x <= 7.0 && px.y >= 1.0 && px.y <= 7.0) {
    vec2 tc = vec2((uIndex * 7.0 + px.x - 1.0 + 0.5) / (7.0 * uCount), (px.y - 1.0 + 0.5) / 7.0);
    on = texture(uGlyphs, tc).r;
  }
  outColor = vec4(on > 0.5 ? uInk : uBase, 1.0);
  outInfo = vec4(0.5, 0.5, 0.0, 0.0);
}
`;

const INK_IDLE = rgb(0x8a5a22);
const INK_HOVER = rgb(0xd9944a);
const INK_PRESS = rgb(0xffe6b0);
const INK_GOOD = rgb(0xa8dcff);
const INK_BAD = rgb(0xff5040);
const BUTTON_BASE = rgb(0x1d1a1a);
const BUTTON_BASE_LIT = rgb(0x2a2420);
/** The order the broken keypad lights its buttons in as it tries to boot. */
const BOOT_ORDER = [4, 0, 8, 2, 6, 1, 7, 3, 5];

interface Button {
  group: Object3D;
  face: Mesh;
  mat: ShaderMaterial;
  press: number;
}

interface Flame {
  mesh: Mesh;
  mat: ShaderMaterial;
  base: Vector3;
  size: number;
  seed: number;
}

/**
 * The ship they escaped from: it came in low and long, ploughed a trench
 * across the desert, broke its back and burned. Same make as the pods (the
 * same off-white hull, orange bands and charred heat shielding), many times
 * their size, with the empty bays the two pods launched from.
 *
 * On its flank, an airlock with its door jammed shut and a 3x3 keypad of
 * glyphs. Each button plays one tone; the stranger's three, in order, crack the
 * door open. Pulling it the rest of the way is a scripted moment (see
 * story/DoorScene.ts), driven through `doorOpen`.
 */
export class Ship {
  readonly group = new Group();
  readonly center = new Vector3();
  justDiscovered = false;
  discovered = false;
  /** Distance from the listener to the nearest point of the hull's axis. */
  distance = Infinity;
  /** 0..1 shake of the ground after a blast, for the camera. */
  shake = 0;

  // the door and its keypad, in world space
  readonly padCenter = new Vector3();
  /** Where to stand to use the keypad: in front of it, a step toward the door, so the view of it is clear. */
  readonly padStand = new Vector3();
  readonly doorCenter = new Vector3();
  /** Out of the door's face, on the ground (unit). */
  readonly doorNormal = new Vector3();
  /** The way the door slides open (unit, along the hull). */
  readonly slideDir = new Vector3();
  /** Where the ground is in front of the door. */
  doorGround = 0;
  /** 0 shut .. 1 fully open (fraction of its width). */
  doorOpen = 0;
  state: 'locked' | 'cracking' | 'cracked' | 'open' = 'locked';
  readonly doorWidth = 0.95;
  readonly doorHeight = 1.5;

  private readonly sound: number;
  private readonly bow = new Group();
  private readonly hull: Mats;
  private readonly flames: Flame[] = [];
  private readonly flameMats: ShaderMaterial[] = [];
  private readonly smokeFrom: { o: Object3D; rate: number; big: boolean; debt: number }[] = [];
  private readonly fireFrom: Object3D[] = [];
  private readonly sparkFrom: Object3D[] = [];
  private readonly navLights: { mat: ShaderMaterial; on: Vector3; off: Vector3; period: number; phase: number }[] = [];
  private readonly doorPanel = new Group();
  private readonly doorSparkFrom = new Object3D();
  private readonly statusMat: ShaderMaterial;
  private readonly emergencyMat: ShaderMaterial;
  private readonly padPanel: Mesh;
  private readonly buttons: Button[] = [];
  private readonly glyphs = glyphTexture();
  private readonly ray = new Raycaster();
  private readonly tmp = new Vector3();
  private readonly cs: number;
  private readonly cosY: number;
  private readonly sinY: number;

  private boomTimer = 9;
  private groanTimer = 4;
  private alarmTimer = 6;
  private sparkTimer = 2;
  private doorSparkTimer = 3;
  private tickTimer = 1;
  private trickleTimer = 1;
  private flare = 0;
  private fireDebt = 0;
  private dripTimer = 1;

  // the keypad
  private seq: number[] = [];
  private seqTimer = 0;
  private verdict: 'none' | 'good' | 'bad' = 'none';
  private verdictT = 0;
  private hovered = -1;
  private crackT = -1;
  private sincePress = 99;
  private wasDark = false;
  private flashT = 0;
  private padSparkTimer = 3;
  private readonly padSparkFrom = new Object3D();

  constructor(
    rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    this.sound = audio.addSite('fire');
    this.hull = {
      hull: toonMaterial({ dark: 0x6f6a62, mid: 0xa8a294, light: 0xdcd6c8, litAt: 0.55, outline: 0.6, highlight: 1 }),
      panel: toonMaterial({ dark: 0x625d56, mid: 0x958f83, light: 0xc9c3b5, litAt: 0.55, outline: 0.6, highlight: 1 }),
      charred: toonMaterial({ dark: 0x2b2424, mid: 0x463c38, light: 0x6a5d55, litAt: 0.55, outline: 0.6, highlight: 0.6 }),
      soot: toonMaterial({ dark: 0x1c1817, mid: 0x2e2826, light: 0x433a36, litAt: 0.55, outline: 0.3, highlight: 0.3 }),
      accent: toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0.6, highlight: 0.8 }),
      glass: toonMaterial({ dark: 0x10141c, mid: 0x1e2a38, light: 0x47677c, litAt: 0.5, outline: 0.6, highlight: 1 }),
      metal: toonMaterial({ dark: 0x2e2a2a, mid: 0x4a4542, light: 0x6e6862, litAt: 0.55, outline: 0.6, highlight: 0.8 }),
      hole: toonMaterial({ dark: 0x0e0b0c, mid: 0x0e0b0c, light: 0x0e0b0c, unlit: true, outline: 0.6 }),
    };
    for (let i = 0; i < 4; i++) {
      this.flameMats.push(toonMaterial({ dark: 0xf08a2c, mid: 0xf08a2c, light: 0xf08a2c, unlit: true, outline: 0 }));
    }
    this.statusMat = toonMaterial({ dark: 0xffb347, mid: 0xffb347, light: 0xffb347, unlit: true, outline: 0 });
    this.emergencyMat = toonMaterial({ dark: 0x7a1010, mid: 0x7a1010, light: 0x7a1010, unlit: true, outline: 0 });

    // ---- place it: centred in its trench, bow along SITE3's direction. The flank
    // facing the viewer (world +z) is local +z when cs = 1, local -z when cs = -1.
    const yaw = Math.atan2(-SITE3.dz, SITE3.dx);
    this.cosY = Math.cos(yaw);
    this.sinY = Math.sin(yaw);
    this.cs = this.cosY >= 0 ? 1 : -1;
    const ground = terrainHeight(SITE3.x, SITE3.z);
    this.group.position.set(SITE3.x, ground + RIDE, SITE3.z);
    this.group.rotation.set(0, yaw, 0.012 * this.cs);
    this.center.set(SITE3.x, ground + RIDE, SITE3.z);

    this.buildHull();
    this.buildDamage();
    this.group.updateMatrixWorld(true);
    // the hull blocks the way: aft and bow halves as two outlines, so the break is not a wall
    for (const part of this.hullParts) rocks.addStatic(footprintOf(part, 3));

    this.buildDebris(rocks);
    this.padPanel = this.buildDoor();
  }

  // ------------------------------------------------------------------ build

  private readonly hullParts: Object3D[] = [];

  private add(parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, shadow = true) {
    const m = new Mesh(faceted(geo), mat);
    m.position.set(x, y, z);
    if (shadow) m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  }

  /** The group a point at hull station x belongs to, and x relative to it. */
  private host(x: number): [Object3D, number] {
    return x > BREAK ? [this.bow, x - BREAK] : [this.group, x];
  }

  /**
   * Where a ray from the hull's centre line at station x, angle phi from the top
   * toward local +z, meets the hull (plus `lift` out of it), and the angle of the
   * surface's normal there (from up, toward +z).
   */
  private hullPoint(x: number, phi: number, lift = 0) {
    const st = stationAt(x);
    const { pts } = hullSection(x, this.cs);
    const dy = Math.cos(phi);
    const dz = Math.sin(phi);
    let best = Infinity;
    let ny = dy;
    let nz = dz;
    for (let k = 0; k < pts.length; k++) {
      const [z1, y1] = pts[k];
      const [z2, y2] = pts[(k + 1) % pts.length];
      const ez = z2 - z1;
      const ey = y2 - y1;
      const den = dz * ey - dy * ez;
      if (Math.abs(den) < 1e-9) continue;
      // centre + t*d = p1 + u*e
      const oz = z1;
      const oy = y1 - st.y;
      const t = (oz * ey - oy * ez) / den;
      const u = (oz * dy - oy * dz) / den;
      if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) {
        best = t;
        const l = Math.hypot(ez, ey) || 1;
        // the edge's normal, turned to face the way the ray came out
        ny = -ez / l;
        nz = ey / l;
        if (ny * dy + nz * dz < 0) {
          ny = -ny;
          nz = -nz;
        }
      }
    }
    if (!Number.isFinite(best)) best = st.w;
    const p = new Vector3(x, st.y + dy * best + ny * lift, dz * best + nz * lift);
    return { p, angle: Math.atan2(nz, ny) };
  }

  /** A point on (or `lift` off) the hull surface at station x, angle phi from the top toward local +z. */
  private surface(x: number, phi: number, lift = 0) {
    return this.hullPoint(x, phi, lift).p;
  }

  /** Put a mesh on the hull at (x, phi), its local +y pointing out of the surface. */
  private onHull(geo: BufferGeometry, mat: Material, x: number, phi: number, lift = 0, spin = 0) {
    const [parent, hx] = this.host(x);
    const { p, angle } = this.hullPoint(x, phi, lift);
    const m = this.add(parent, geo, mat, hx, p.y, p.z);
    m.rotation.set(angle, 0, 0);
    m.rotateY(spin);
    return m;
  }

  /**
   * A skin of hull between stations x0 and x1, `inflate` proud of it; `faces`
   * picks which facets by their normal (y up, z toward local +z).
   */
  private hullBand(x0: number, x1: number, mat: Material, inflate = 0, faces?: (ny: number, nz: number) => boolean, shadow = true) {
    const [parent] = this.host((x0 + x1) / 2);
    const offset = parent === this.bow ? BREAK : 0;
    const mid = hullSection((x0 + x1) / 2, this.cs, inflate).pts;
    const cy = stationAt((x0 + x1) / 2).y;
    const keep = mid.map((p, k) => {
      if (!faces) return true;
      const q = mid[(k + 1) % mid.length];
      const ez = q[0] - p[0];
      const ey = q[1] - p[1];
      const l = Math.hypot(ez, ey) || 1;
      let ny = -ez / l;
      let nz = ey / l;
      if (ny * ((p[1] + q[1]) / 2 - cy) + nz * ((p[0] + q[0]) / 2) < 0) {
        ny = -ny;
        nz = -nz;
      }
      return faces(ny, nz);
    });
    const g = loft(
      stationsBetween(x0, x1),
      (x) => hullSection(x, this.cs, inflate).pts,
      (x) => [stationAt(x).y, 0],
      offset,
      (_i, k) => !keep[k],
    );
    return this.add(parent, g, mat, 0, 0, 0, shadow);
  }

  /** A solid loft of any section along x0..x1 (spine, tower, chines), capped. */
  private prism(x0: number, x1: number, section: (x: number) => [number, number][], mat: Material, steps = 6) {
    const [parent] = this.host((x0 + x1) / 2);
    const offset = parent === this.bow ? BREAK : 0;
    const xs = Array.from({ length: steps + 1 }, (_, i) => x0 + ((x1 - x0) * i) / steps);
    const centre = (x: number): [number, number] => {
      const p = section(x);
      return [p.reduce((a, q) => a + q[1], 0) / p.length, p.reduce((a, q) => a + q[0], 0) / p.length];
    };
    const g = loft(xs, section, centre, offset, undefined, [true, true]);
    return this.add(parent, g, mat, 0, 0, 0);
  }

  private buildHull() {
    const m = this.hull;
    const cs = this.cs;
    this.bow.position.set(BREAK, 0, 0);
    // the back broke: the bow half is bent down and aside
    this.bow.rotation.set(0, 0.07 * cs, -0.045);
    this.group.add(this.bow);

    // ---- the hull: two lofted halves, a hole left in the near flank for the airlock
    const aftEnd = BREAK - 0.32;
    const aftXs = stationsBetween(-10.2, aftEnd, [DOOR.x0, DOOR.x1, -8, -5, -3]);
    const d0 = aftXs.indexOf(DOOR.x0);
    const aft = this.add(
      this.group,
      loft(aftXs, (x) => hullSection(x, cs).pts, (x) => [stationAt(x).y, 0], 0, (i, k) => i === d0 && k === 2, [true, false]),
      m.hull,
      0,
      0,
      0,
    );
    const foreXs = stationsBetween(BREAK + 0.3, 10.4, [3, 6, 8, 9.7]);
    const fore = this.add(
      this.bow,
      loft(foreXs, (x) => hullSection(x, cs).pts, (x) => [stationAt(x).y, 0], BREAK, undefined, [false, true]),
      m.hull,
      0,
      0,
      0,
    );
    this.hullParts.push(aft, fore);

    // seared keel from coming in hot, and the pods' orange in bands
    const down = (ny: number) => ny < -0.3;
    this.hullBand(-10.1, aftEnd - 0.03, m.charred, 0.02, down);
    this.hullBand(BREAK + 0.33, 10.2, m.charred, 0.02, down);
    for (const [x0, x1] of [
      [-9.1, -8.8],
      [4.6, 4.95],
      [7.4, 7.52],
    ]) {
      this.hullBand(x0, x1, m.accent, 0.03);
    }
    // darker plates set into the top and the upper flanks
    const up = (ny: number) => ny > 0.95;
    for (const x of [-7.6, -5.4, 1.2, 3.4]) this.hullBand(x, x + 1.1, m.panel, 0.012, up);
    const flank = (ny: number, nz: number) => ny > 0.3 && ny < 0.95 && nz * cs < 0;
    for (const x of [-8.2, -2.6, 2.2]) this.hullBand(x, x + 1.4, m.panel, 0.012, flank);

    // ---- chines: blade-like strakes running along both flanks at the shoulder
    for (const side of [1, -1]) {
      const strake = (x0: number, x1: number) =>
        this.prism(
          x0,
          x1,
          (x) => {
            const st = stationAt(x);
            const u = (x - x0) / (x1 - x0);
            const out = 0.34 * Math.min(1, u * 4, (1 - u) * 3);
            const yy = st.y + 0.5 * st.h;
            return [
              [side * (st.w - 0.06), yy + 0.07],
              [side * (st.w + out), yy - 0.01],
              [side * (st.w - 0.06), yy - 0.11],
            ];
          },
          m.panel,
          8,
        );
      strake(-9.3, aftEnd - 0.1);
      strake(BREAK + 0.4, 6.8);
    }

    // ---- the dorsal spine along the top of the stern half, ending in a raised fin
    this.prism(
      -8.8,
      aftEnd - 0.2,
      (x) => {
        const st = stationAt(x);
        const u = (x + 8.8) / (aftEnd - 0.2 + 8.8);
        const hgt = 0.42 * Math.min(1, u * 5, (1 - u) * 6);
        const top = st.y + st.h;
        return [
          [0.62, top - 0.05],
          [0.38, top + hgt],
          [-0.38, top + hgt],
          [-0.62, top - 0.05],
        ];
      },
      m.hull,
      8,
    );
    // vents along the spine
    for (let k = 0; k < 6; k++) this.add(this.group, new BoxGeometry(0.32, 0.05, 0.5), m.metal, -7.4 + k * 0.85, 2.04, 0);
    // radiator vanes stacked over the stern
    for (let k = 0; k < 6; k++) {
      const vane = this.add(this.group, new BoxGeometry(0.05, 0.7, 1.9), k % 2 ? m.panel : m.metal, -9.45 + k * 0.33, 1.95, 0);
      vane.rotation.x = 0.06 * (k % 3 - 1);
    }

    // ---- the bridge: a raised, wedge-fronted tower on the bow half, its canopy dark
    const towerX0 = 2.6;
    const towerX1 = 6.6;
    const tower = (x: number, inflate = 0): [number, number][] => {
      const st = stationAt(x);
      const u = (x - towerX0) / (towerX1 - towerX0);
      const hgt = 0.72 * Math.min(1, u * 4) * (u > 0.6 ? 1 - (u - 0.6) / 0.4 * 0.75 : 1) + inflate;
      const wide = 0.9 * (1 - 0.35 * u) + inflate;
      const top = st.y + st.h;
      return [
        [wide, top - 0.06],
        [wide * 0.72, top + hgt],
        [-wide * 0.72, top + hgt],
        [-wide, top - 0.06],
      ];
    };
    this.prism(towerX0, towerX1, (x) => tower(x), m.hull, 10);
    this.prism(5.0, towerX1 - 0.05, (x) => tower(x, 0.025), m.glass, 6);
    // a sensor mast on the bridge, snapped and hanging, and a dish
    const mast = this.add(this.bow, new CylinderGeometry(0.05, 0.05, 1.4, 4), m.metal, 3.6 - BREAK, 2.35, 0.3);
    mast.rotation.set(0.2, 0, -1.1);
    const dish = this.add(this.bow, new CylinderGeometry(0.4, 0.12, 0.12, 8), m.panel, 3.2 - BREAK, 2.4, -0.4 * cs);
    dish.rotation.set(-0.5 * cs, 0, 0.3);

    // portholes along the upper flanks of the bow half
    for (let k = 0; k < 6; k++) {
      for (const side of [1, -1]) this.onHull(new BoxGeometry(0.2, 0.05, 0.14), m.glass, 0.4 + k * 0.62, side * 1.0, 0.004);
    }
    // greebles: hatches, vents and conduits scattered over the top
    const rand = rng(4242);
    for (let k = 0; k < 26; k++) {
      const x = -9 + rand() * 18;
      if (Math.abs(x - BREAK) < 0.9 || (x > towerX0 - 0.3 && x < towerX1)) continue;
      const g = new BoxGeometry(0.15 + rand() * 0.5, 0.04 + rand() * 0.08, 0.12 + rand() * 0.35);
      this.onHull(g, rand() < 0.5 ? m.metal : m.panel, x, (rand() - 0.5) * 1.3, 0.02, rand() < 0.5 ? 0 : Math.PI / 2);
    }

    // the broken ends: a frame band, a dark inside, plates bent into the gap
    for (const [x, sgn] of [
      [aftEnd, -1],
      [BREAK + 0.3, 1],
    ]) {
      this.hullBand(x + sgn * 0.02, x + sgn * 0.16, m.metal, 0.04);
      const [parent] = this.host(x + sgn * 0.05);
      const offset = parent === this.bow ? BREAK : 0;
      const inner = loft(
        [x + sgn * 0.14, x + sgn * 0.16].sort((p, q) => p - q),
        (xx) => hullSection(xx, cs, -0.06).pts,
        (xx) => [stationAt(xx).y, 0],
        offset,
        undefined,
        [true, true],
      );
      this.add(parent, inner, m.hole, 0, 0, 0, false);
      for (let k = 0; k < 6; k++) {
        const phi = (k / 6) * Math.PI * 2 + 0.3 * sgn;
        const plate = this.onHull(new BoxGeometry(0.5, 0.05, 0.4), m.hull, x - sgn * 0.12, phi, -0.03);
        plate.rotateZ(sgn * (0.5 + 0.4 * Math.sin(k * 2.1)));
      }
    }
    // cables hanging across the break
    for (let k = 0; k < 4; k++) {
      const c = this.add(this.group, new CylinderGeometry(0.035, 0.035, 0.9, 4), m.charred, BREAK, 1.2 - k * 0.5, (k - 1.5) * 0.6 * cs);
      c.rotation.set(0.4 * k, 0, 1.2 + 0.3 * k);
    }

    // the pod bays: four in a row on the upper flank. Two stand empty: the two pods were launched.
    for (let k = 0; k < 4; k++) {
      const x = -8.6 + k * 1.15;
      const phi = 0.95 * cs;
      const ring = this.onHull(new TorusGeometry(0.42, 0.07, 4, 10), m.accent, x, phi, 0.02);
      ring.rotateX(Math.PI / 2);
      if (k === 1 || k === 2) {
        this.onHull(new CylinderGeometry(0.36, 0.36, 0.06, 10), m.hole, x, phi, 0.0);
        this.onHull(new BoxGeometry(0.05, 0.07, 0.6), m.metal, x - 0.15, phi, 0.0);
        this.onHull(new BoxGeometry(0.05, 0.07, 0.6), m.metal, x + 0.15, phi, 0.0);
      } else {
        this.onHull(new CylinderGeometry(0.37, 0.37, 0.05, 10), m.panel, x, phi, 0.02);
        this.onHull(new BoxGeometry(0.62, 0.06, 0.08), m.metal, x, phi, 0.04);
      }
    }

    // ---- engines: a squared-off drive block and three hexagonal bells; the lower near one tore away
    this.add(this.group, new BoxGeometry(0.6, 2.0, 3.3), m.metal, -10.45, 0, 0);
    this.add(this.group, new BoxGeometry(0.64, 0.14, 3.34), m.accent, -10.45, 0.82, 0);
    for (const [y, z] of [
      [0.42, 0],
      [-0.5, -0.92 * cs],
    ]) {
      const g = new CylinderGeometry(0.66, 0.44, 1.2, 6, 1, true);
      g.rotateZ(Math.PI / 2);
      this.add(this.group, g, m.charred, -11.3, y, z);
      const inner = new CylinderGeometry(0.6, 0.42, 0.05, 6);
      inner.rotateZ(Math.PI / 2);
      this.add(this.group, inner, m.hole, -11.85, y, z, false);
    }
    this.add(this.group, new CylinderGeometry(0.4, 0.46, 0.35, 6), m.charred, -10.85, -0.5, 0.92 * cs).rotation.z = Math.PI / 2;

    // ---- wings: swept deltas low on the flanks; the far one whole, the near one sheared off
    const delta = (pts: [number, number][], thick: number) => {
      const shape = new Shape(pts.map(([x, z]) => new Vector2(x, z)));
      const g = new ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
      g.rotateX(Math.PI / 2);
      return g;
    };
    const farWing = this.add(
      this.group,
      delta(
        [
          [-8.8, 0],
          [-3.0, 0],
          [-7.6, 3.4],
          [-9.3, 3.6],
        ],
        0.16,
      ),
      m.hull,
      0,
      -0.35,
      -cs * 2.3,
    );
    farWing.scale.z = -cs;
    farWing.rotation.x = 0.1 * cs;
    const farEdge = this.add(
      this.group,
      delta(
        [
          [-9.3, 3.35],
          [-7.6, 3.15],
          [-7.6, 3.42],
          [-9.3, 3.62],
        ],
        0.18,
      ),
      m.accent,
      0,
      -0.34,
      -cs * 2.3,
    );
    farEdge.scale.z = -cs;
    farEdge.rotation.x = 0.1 * cs;
    const stub = this.add(
      this.group,
      delta(
        [
          [-8.6, 0],
          [-4.6, 0],
          [-6.3, 0.9],
          [-7.4, 0.6],
          [-8.3, 1.1],
        ],
        0.17,
      ),
      m.hull,
      0,
      -0.42,
      cs * 2.3,
    );
    stub.scale.z = cs;
    this.add(this.group, new BoxGeometry(2.2, 0.2, 0.14), m.charred, -7.2, -0.42, cs * 3.25).rotation.y = 0.25 * cs;

    // the dorsal fin rising off the spine, swept and bent over
    const fin = this.add(
      this.group,
      delta(
        [
          [-9.6, 0],
          [-7.0, 0],
          [-8.6, 1.5],
          [-9.5, 1.55],
        ],
        0.14,
      ),
      m.hull,
      0,
      2.02,
      0.07,
    );
    fin.rotation.x = -Math.PI / 2 + 0.38 * cs;
    const finTip = this.add(this.group, new BoxGeometry(1.0, 0.18, 0.16), m.accent, -9.05, 3.35, 0.55 * cs);
    finTip.rotation.x = 0.38 * cs;

    // nav lights: red at the fin tip, white on the prow, green on the far wingtip
    const nav = (parent: Object3D, x: number, y: number, z: number, on: number, period: number) => {
      const mat = toonMaterial({ dark: on, mid: on, light: on, unlit: true, outline: 0 });
      this.add(parent, new BoxGeometry(0.12, 0.12, 0.12), mat, x, y, z, false);
      this.navLights.push({ mat, on: rgb(on), off: rgb(0x2a1a18), period, phase: Math.random() });
    };
    nav(this.group, -9.4, 3.45, 0.6 * cs, 0xff3c2c, 1.9);
    nav(this.bow, 10.3 - BREAK, -0.58, 0, 0xf4f0e8, 2.6);
    nav(this.group, -8.4, -0.3, -cs * 5.8, 0x50ff80, 3.1);
  }

  /** Breaches, fires, blast scars. */
  private buildDamage() {
    const m = this.hull;
    const cs = this.cs;
    /** A ragged hole blown out of the hull at (x, phi), with plates peeled back and soot round it. */
    const breach = (x: number, phi: number, size: number, flames: number) => {
      for (let k = 0; k < 5; k++) {
        const dx = (Math.sin(k * 2.4) * 0.5) * size;
        const dp = (Math.cos(k * 1.7) * 0.18) * size;
        this.onHull(new BoxGeometry(0.75 * size, 0.08, 0.55 * size), m.hole, x + dx, phi + dp, -0.02, k * 0.7);
      }
      // plates peeled outward round the rim
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const plate = this.onHull(new BoxGeometry(0.55 * size, 0.05, 0.3 * size), k % 3 === 0 ? m.charred : m.hull, x + Math.cos(a) * 0.75 * size, phi + Math.sin(a) * 0.32 * size, 0.06);
        plate.rotateZ(Math.cos(a) * 0.9);
        plate.rotateX(Math.sin(a) * 0.9);
      }
      // soot blown back over the hull
      for (let k = 0; k < 4; k++) {
        const sc = this.onHull(new IcosahedronGeometry(0.9 * size, 0), m.soot, x + (k - 1.5) * 0.7 * size, phi + (k % 2 ? 0.2 : -0.15) * size, -0.62 * size, k);
        sc.scale.set(1.5, 0.7, 1);
      }
      for (let k = 0; k < flames; k++) {
        const [parent, hx] = this.host(x);
        const p = this.surface(x + (k - (flames - 1) / 2) * 0.35 * size, phi + (k % 2 ? 0.08 : -0.08), 0.05 + 0.1 * k);
        this.flame(parent, new Vector3(p.x - (x - hx), p.y, p.z), 0.35 * size + 0.1 * (k % 2));
      }
      const [parent, hx] = this.host(x);
      const p = this.surface(x, phi, 0.15);
      const smoke = new Object3D();
      smoke.position.set(hx, p.y, p.z);
      parent.add(smoke);
      this.smokeFrom.push({ o: smoke, rate: 14 * size, big: size > 0.9, debt: 0 });
      this.fireFrom.push(smoke);
    };
    breach(2.6, 0.7 * cs, 1.25, 4);
    breach(-5.6, -0.15 * cs, 0.8, 2);
    breach(5.4, -0.9 * cs, 0.7, 2);

    // fire and smoke boiling out of the break
    for (let k = 0; k < 5; k++) {
      this.flame(this.group, new Vector3(BREAK + (k % 2 ? 0.15 : -0.15), 0.9 + (k % 3) * 0.45 - 0.4, (k - 2) * 0.55 * cs), 0.45 + 0.15 * (k % 2));
    }
    const brk = new Object3D();
    brk.position.set(BREAK, 1.9, 0);
    this.group.add(brk);
    this.smokeFrom.push({ o: brk, rate: 18, big: true, debt: 0 });
    this.fireFrom.push(brk);
    const sp = new Object3D();
    sp.position.set(BREAK, 0.6, 1.8 * cs);
    this.group.add(sp);
    this.sparkFrom.push(sp);

    // blast scars where it scraped and burned
    for (const [x, phi, s] of [
      [-6.6, 1.25, 1],
      [0.4, 0.2, 0.8],
      [4.2, 1.35, 0.9],
      [-7.5, 0.55, 0.7],
      [8.6, 0.6, 0.6],
      [-3.8, -1.0, 0.9],
    ]) {
      const sc = this.onHull(new IcosahedronGeometry(0.85 * s, 0), m.soot, x, phi * cs, -0.6 * s, x);
      sc.scale.set(1.8, 0.6, 1.1);
    }
  }

  private flame(parent: Object3D, at: Vector3, size: number) {
    const mat = this.flameMats[this.flames.length % this.flameMats.length];
    const mesh = new Mesh(new BoxGeometry(size * 0.7, size, size * 0.7), mat);
    mesh.position.copy(at);
    mesh.rotation.y = Math.random() * Math.PI;
    parent.add(mesh);
    this.flames.push({ mesh, mat, base: at.clone(), size, seed: this.flames.length * 7.3 });
  }

  /** Ship-local station (x along, z across) to world, on the ground. */
  private localToGround(x: number, z: number, out: Vector3) {
    out.set(SITE3.x + x * this.cosY + z * this.sinY, 0, SITE3.z - x * this.sinY + z * this.cosY);
    out.y = terrainHeight(out.x, out.z);
    return out;
  }

  private buildDebris(rocks: Rocks) {
    const m = this.hull;
    const rand = rng(777);
    const cs = this.cs;
    const half = SHIP_LENGTH / 2;
    const lay = (geo: BufferGeometry, mat: Material, x: number, z: number, sink: number, block = false) => {
      this.localToGround(x, z, this.tmp);
      const mesh = new Mesh(faceted(geo), mat);
      mesh.position.set(this.tmp.x, this.tmp.y - sink, this.tmp.z);
      mesh.rotation.set((rand() - 0.5) * 0.8, rand() * Math.PI * 2, (rand() - 0.5) * 0.8);
      mesh.layers.enable(SHADOW_LAYER);
      this.debris.push(mesh);
      if (block) {
        mesh.updateMatrixWorld(true);
        rocks.addStatic(footprintOf(mesh, 0.8));
      }
      return mesh;
    };
    // along the trench: plates, beams, frame, glass, burnt lumps; heavier and denser toward the wreck
    for (let i = 0; i < 70; i++) {
      const t = Math.pow(rand(), 0.7);
      const x = -half - SHIP_TRENCH * (1 - t) - 1;
      const z = (rand() - 0.5) * 2 * (2 + 4 * t) * (rand() < 0.2 ? 1.6 : 1);
      const k = rand();
      const sc = 0.8 + rand() * 1.4;
      if (k < 0.35) lay(new BoxGeometry(0.6 * sc, 0.06, 0.4 * sc), [m.hull, m.hull, m.charred, m.accent, m.panel][Math.floor(rand() * 5)], x, z, 0.02);
      else if (k < 0.55) lay(new CylinderGeometry(0.05, 0.05, 1.2 * sc, 5).rotateZ(Math.PI / 2), m.metal, x, z, 0.0);
      else if (k < 0.7) lay(new TorusGeometry(0.6 * sc, 0.06, 3, 8, Math.PI * (0.4 + rand() * 0.5)).rotateX(Math.PI / 2), m.metal, x, z, 0.0);
      else if (k < 0.85) lay(new IcosahedronGeometry(0.2 * sc, 0).scale(1.3, 0.6, 1), m.charred, x, z, 0.03);
      else lay(new BoxGeometry(0.14 * sc, 0.03, 0.1 * sc), m.glass, x, z, 0.0);
    }
    // the sheared wing, lying in the trench where it tore off
    const wing = lay(new BoxGeometry(4.2, 0.16, 2.2), m.hull, -half - 12, cs * 3.4, 0.05, true);
    wing.rotation.set(0.12, 0.6, -0.08);
    const edge = lay(new BoxGeometry(4, 0.18, 0.28), m.accent, -half - 12.2, cs * 4.3, 0.04);
    edge.rotation.set(0.12, 0.6, -0.08);
    // the lost engine bell, on its side
    const bell = lay(new CylinderGeometry(0.78, 0.5, 1.4, 12, 1, true), m.charred, -half - 6.5, cs * 2.6, 0.25, true);
    bell.rotation.set(Math.PI / 2, 0.4, 0.2);
    // a pod-bay cover blown off
    lay(new CylinderGeometry(0.37, 0.37, 0.05, 10), m.panel, -4, cs * 6.1, 0.0);
    // big hull plates flung out by the break
    for (let i = 0; i < 6; i++) {
      const a = (rand() - 0.5) * 2;
      lay(new BoxGeometry(1.4 + rand(), 0.07, 0.9 + rand() * 0.6), rand() < 0.4 ? m.charred : m.hull, BREAK + a * 5, cs * (4 + rand() * 3) * (rand() < 0.3 ? -1 : 1), 0.03);
    }
    // small fires still burning in the wreckage
    for (const [x, z] of [
      [BREAK + 1.5, cs * 4.6],
      [-half - 4, -cs * 2.5],
      [3.5, -cs * 4.2],
    ]) {
      this.localToGround(x, z, this.tmp);
      lay(new IcosahedronGeometry(0.35, 0).scale(1.4, 0.6, 1), m.charred, x, z, 0.05);
      const o = new Object3D();
      o.position.set(this.tmp.x, this.tmp.y + 0.15, this.tmp.z);
      this.debris.push(o);
      this.groundFires.push(o);
      this.flame(o, new Vector3(0, 0.1, 0), 0.32);
      this.flame(o, new Vector3(0.12, 0.05, 0.08), 0.22);
      this.smokeFrom.push({ o, rate: 3, big: false, debt: 0 });
    }
  }

  /** Things laid in world space (debris, ground fires); added to the scene with the ship. */
  readonly debris: Object3D[] = [];
  private readonly groundFires: Object3D[] = [];

  /**
   * The airlock, cut into the near flank: a doorway in the hull itself with a
   * dark recess behind, a trim and hazard chevrons round it, a door that slides
   * back into the hull, and the keypad set flush into the plating beside it.
   */
  private buildDoor(): Mesh {
    const m = this.hull;
    const cs = this.cs;
    const G = this.group;
    const xc = (DOOR.x0 + DOOR.x1) / 2;
    const yc = (DOOR.y0 + DOOR.y1) / 2;
    const dw = DOOR.x1 - DOOR.x0;
    const dh = DOOR.y1 - DOOR.y0;
    const w = stationAt(xc).w;
    const face = (d: number) => cs * (w + d);
    const box = (sx: number, sy: number, sz: number, mat: Material, x: number, y: number, z: number, shadow = true) =>
      this.add(G, new BoxGeometry(sx, sy, sz), mat, x, y, z, shadow);
    // the recess: walls, floor and ceiling in shadow, a red emergency light at the back
    const depth = 0.7;
    box(dw, dh, 0.02, m.hole, xc, yc, face(-depth), false);
    box(0.02, dh, depth, m.hole, DOOR.x0, yc, face(-depth / 2), false);
    box(0.02, dh, depth, m.hole, DOOR.x1, yc, face(-depth / 2), false);
    box(dw, 0.02, depth, m.hole, xc, DOOR.y1, face(-depth / 2), false);
    box(dw, 0.02, depth, m.hole, xc, DOOR.y0, face(-depth / 2), false);
    box(0.5, 0.06, 0.03, this.emergencyMat, xc, DOOR.y1 - 0.12, face(-depth + 0.03), false);
    // a trim round the opening, flush with the hull, and chevrons down both sides
    box(dw + 0.2, 0.08, 0.06, m.metal, xc, DOOR.y1 + 0.04, face(0.0));
    box(dw + 0.2, 0.06, 0.06, m.metal, xc, DOOR.y0 - 0.02, face(0.0));
    box(0.08, dh + 0.1, 0.06, m.metal, DOOR.x0 - 0.04, yc, face(0.0));
    box(0.08, dh + 0.1, 0.06, m.metal, DOOR.x1 + 0.04, yc, face(0.0));
    for (const x of [DOOR.x0 - 0.14, DOOR.x1 + 0.14]) {
      for (let k = 0; k < 5; k++) box(0.1, 0.12, 0.03, k % 2 ? m.metal : m.accent, x, DOOR.y0 + 0.15 + k * 0.28, face(0.0));
    }
    // a hull band picks up the trim over the door and runs on along the flank
    box(dw + 2.2, 0.06, 0.04, m.accent, xc + 0.6, DOOR.y1 + 0.16, face(0.005));
    // status light set into the trim over the door: amber while locked
    box(0.12, 0.05, 0.05, this.statusMat, xc, DOOR.y1 + 0.04, face(0.025), false);

    // the door: buckled across the middle, just inside the hull so it slides back into it
    const D = this.doorPanel;
    D.position.set(xc, yc, face(-0.05));
    D.rotation.y = cs > 0 ? 0 : Math.PI;
    G.add(D);
    const upper = this.add(D, new BoxGeometry(dw, dh * 0.52, 0.07), m.panel, 0, dh * 0.24, 0);
    upper.rotation.x = -0.05;
    const lower = this.add(D, new BoxGeometry(dw, dh * 0.5, 0.07), m.panel, 0, -dh * 0.25, 0.012);
    lower.rotation.x = 0.06;
    this.add(D, new BoxGeometry(dw * 0.95, 0.07, 0.08), m.accent, 0, dh * 0.38, 0.02);
    // the handle, on the edge that opens (the door's local x is mirrored on the -z side)
    this.add(D, new BoxGeometry(0.06, dh * 0.35, 0.09), m.metal, dw * 0.38 * cs, 0, 0.03);
    const dent = this.add(D, new IcosahedronGeometry(0.22, 0), m.charred, -dw * 0.12 * cs, -0.05, 0.0);
    dent.scale.set(1.2, 0.8, 0.25);
    this.doorLocal = { x: xc, y: yc };
    this.slideSign = -1; // back toward the stern, into the hull
    this.doorSparkFrom.position.set(DOOR.x1 + 0.02, yc + 0.3, face(0.05));
    G.add(this.doorSparkFrom);
    // scorch over the doorway where something burned through the seals
    const sc = this.onHull(new IcosahedronGeometry(0.55, 0), m.soot, DOOR.x0 - 0.3, 1.22 * cs, -0.42);
    sc.scale.set(1.4, 0.6, 1);

    // the keypad, set into the plating beside the door: a recessed metal plate of buttons
    const pad = new Group();
    pad.position.set(DOOR.x1 + 0.62, -0.18, face(0.0));
    pad.rotation.y = cs > 0 ? 0 : Math.PI;
    G.add(pad);
    const panel = this.add(pad, new BoxGeometry(0.74, 0.74, 0.04), m.metal, 0, 0, -0.005);
    this.padSparkFrom.position.set(0.38, 0.36, 0.05);
    pad.add(this.padSparkFrom);
    this.add(pad, new BoxGeometry(0.82, 0.05, 0.05), m.accent, 0, 0.42, 0);
    this.add(pad, new BoxGeometry(0.82, 0.04, 0.05), m.metal, 0, -0.41, 0);
    this.add(pad, new BoxGeometry(0.04, 0.82, 0.05), m.metal, -0.41, 0, 0);
    this.add(pad, new BoxGeometry(0.04, 0.82, 0.05), m.metal, 0.41, 0, 0);
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const b = new Group();
      b.position.set((col - 1) * 0.22, (1 - row) * 0.22, 0.02);
      pad.add(b);
      this.add(b, new BoxGeometry(0.2, 0.2, 0.03), m.charred, 0, 0, 0, false);
      const mat = new ShaderMaterial({
        glslVersion: GLSL3,
        uniforms: {
          uGlyphs: { value: this.glyphs },
          uIndex: { value: i },
          uCount: { value: GLYPHS.length },
          uInk: { value: INK_IDLE.clone() },
          uBase: { value: BUTTON_BASE.clone() },
        },
        vertexShader: GLYPH_VERT,
        fragmentShader: GLYPH_FRAG,
      });
      const faceMesh = new Mesh(new PlaneGeometry(0.18, 0.18), mat);
      faceMesh.position.z = 0.016;
      b.add(faceMesh);
      this.buttons.push({ group: b, face: faceMesh, mat, press: 0 });
    }

    G.updateMatrixWorld(true);
    G.localToWorld(this.doorCenter.set(xc, yc, face(0)));
    pad.getWorldPosition(this.padCenter);
    this.doorNormal.set(0, 0, cs).transformDirection(G.matrixWorld).setY(0).normalize();
    this.slideDir.set(this.slideSign, 0, 0).transformDirection(G.matrixWorld).setY(0).normalize();
    this.tmp.copy(this.doorCenter).addScaledVector(this.doorNormal, 0.6);
    this.doorGround = terrainHeight(this.tmp.x, this.tmp.z);
    const toDoor = this.tmp.copy(this.doorCenter).sub(this.padCenter).setY(0).normalize();
    this.padStand.copy(this.padCenter).addScaledVector(this.doorNormal, 0.75).addScaledVector(toDoor, 0.95);
    this.padStand.y = terrainHeight(this.padStand.x, this.padStand.z);
    return panel;
  }

  private slideSign = -1;
  private doorLocal = { x: 0, y: 0 };

  /** Where a hand grips the door's open edge, at height `y` above the ground. */
  doorEdge(y: number, out: Vector3) {
    const dw = DOOR.x1 - DOOR.x0;
    const x = this.doorLocal.x + this.slideSign * (this.doorOpen * dw * 0.98) - (this.slideSign * dw) / 2;
    const w = stationAt(this.doorLocal.x).w;
    return this.group.localToWorld(out.set(x, DOOR.y0 + y - 0.04, this.cs * (w + 0.02)));
  }

  /** Add everything to the scene. */
  addTo(scene: Object3D) {
    scene.add(this.group);
    for (const d of this.debris) scene.add(d);
  }

  /** Where the creature looks when it notices the ship. */
  get lookPoint() {
    return this.tmp.copy(this.center).add(new Vector3(0, 1, 0));
  }

  // ----------------------------------------------------------------- keypad

  private ndc = new Vector2();
  private aim(mouse: Vector2, camera: import('three').Camera) {
    this.ndc.set((mouse.x / window.innerWidth) * 2 - 1, -(mouse.y / window.innerHeight) * 2 + 1);
    this.ray.setFromCamera(this.ndc, camera);
  }

  /** Which button is under the mouse, or -1. */
  buttonAt(mouse: Vector2, camera: import('three').Camera) {
    this.aim(mouse, camera);
    const hits = this.ray.intersectObjects(this.buttons.map((b) => b.face), false);
    return hits.length ? this.buttons.findIndex((b) => b.face === hits[0].object) : -1;
  }

  /** Whether the mouse is over the keypad. */
  padAt(mouse: Vector2, camera: import('three').Camera) {
    this.aim(mouse, camera);
    return this.ray.intersectObjects([this.padPanel, ...this.buttons.map((b) => b.face)], false).length > 0;
  }

  /** Whether the mouse is over the doorway. */
  doorAt(mouse: Vector2, camera: import('three').Camera) {
    this.aim(mouse, camera);
    return this.ray.intersectObject(this.doorPanel, true).length > 0;
  }

  set hover(i: number) {
    this.hovered = i;
  }

  get hoveredButton() {
    return this.hovered;
  }

  /** Press button `i`: its tone plays; the third press is judged against the tune. */
  press(i: number) {
    if (this.state !== 'locked' || this.verdict !== 'none') return;
    const b = this.buttons[i];
    b.press = 1;
    this.sincePress = 0;
    const tone = PAD_TONES[i];
    this.audio.padTone(tone, 0.5);
    this.seq.push(tone);
    this.seqTimer = 5;
    if (this.seq.length === 3) {
      const ok = this.seq.every((t, k) => t === TUNE[k]);
      this.verdict = ok ? 'good' : 'bad';
      this.verdictT = 0;
      this.seq = [];
    }
  }

  get solved() {
    return this.state !== 'locked';
  }

  // ----------------------------------------------------------------- update

  update(dt: number, time: number, _wind: Wind, listener: Vector3) {
    this.justDiscovered = false;
    // distance to the nearest point on the hull's axis
    const ox = listener.x - SITE3.x;
    const oz = listener.z - SITE3.z;
    const a = clamp(ox * SITE3.dx + oz * SITE3.dz, -SHIP_LENGTH / 2, SHIP_LENGTH / 2);
    const d = Math.hypot(ox - SITE3.dx * a, oz - SITE3.dz * a);
    this.distance = d;
    if (!this.discovered && d < 20) {
      this.discovered = true;
      this.justDiscovered = true;
    }
    const near = d < 70;
    const level = near ? 1.5 / (1 + (d / 10) * (d / 10)) : 0;
    const pan = clamp((SITE3.x + SITE3.dx * a - listener.x) / 12, -0.85, 0.85);
    this.audio.setSite(this.sound, level, pan, 1 - smoothstep(4, 45, d), 0.75 + 0.25 * noise1(time * 0.7, 3) + this.flare * 0.5);
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.updateKeypad(dt, time);
    this.updateDoor(dt, time);

    // ---- nav lights
    for (const n of this.navLights) {
      const ph = ((time / n.period + n.phase) % 1 + 1) % 1;
      const on = ph < 0.08 && noise1(time * 0.3, n.period) > -0.6;
      (n.mat.uniforms.uLight.value as Vector3).copy(on ? n.on : n.off);
    }

    // ---- flames lick and gutter; they flare with every blast
    this.flare = Math.max(0, this.flare - dt * 1.2);
    for (const f of this.flames) {
      const n = noise1(time * 7 + f.seed, f.seed) * 0.5 + 0.5;
      const s = f.size * (0.7 + 0.6 * n) * (1 + this.flare * 1.4);
      f.mesh.scale.set(0.8 + 0.3 * n, 0.6 + 0.8 * n + this.flare, 0.8 + 0.3 * n);
      f.mesh.position.set(f.base.x, f.base.y + s * 0.3, f.base.z);
      f.mesh.rotation.y += dt * (1 + n);
    }
    this.flameMats.forEach((mat, k) => {
      const n = noise1(time * 11 + k * 5, 70 + k) * 0.5 + 0.5 + this.flare;
      (mat.uniforms.uLight.value as Vector3).copy(FLAME[Math.min(4, Math.floor(n * 3.2) + (k % 2))]);
    });

    if (!near) return;

    // ---- smoke: dark columns rising high and leaning away on the wind, seen from far off
    for (const s of this.smokeFrom) {
      s.debt += dt * s.rate * 1.7 * (1 + this.flare * 2);
      if (s.debt < 1) continue;
      s.o.getWorldPosition(this.tmp);
      while (s.debt >= 1) {
        s.debt -= 1;
        // a thick column: dense and dark at its root, spreading and greying as it climbs
        const big = s.big && Math.random() < 0.7;
        const spread = s.big ? 0.9 : 0.4;
        this.dust.spawn(
          this.tmp.x + (Math.random() - 0.5) * spread,
          this.tmp.y + Math.random() * 0.3,
          this.tmp.z + (Math.random() - 0.5) * spread,
          (Math.random() - 0.5) * 0.5,
          0.9 + Math.random() * 0.9,
          (Math.random() - 0.5) * 0.5,
          s.big ? 9 + Math.random() * 7 : 3 + Math.random() * 2,
          big ? (Math.random() < 0.6 ? SMOKE_DARK : SMOKE_MID) : SMOKE_MID,
          big ? 3 : 2,
          { g: -0.32, drag: 0.35, windK: 1.25, c2: SMOKE_LIGHT },
        );
      }
    }

    // ---- embers and tongues of fire
    this.fireDebt += dt * 30;
    while (this.fireDebt >= 1) {
      this.fireDebt -= 1;
      const src = Math.random() < 0.8 ? this.fireFrom[Math.floor(Math.random() * this.fireFrom.length)] : this.groundFires[Math.floor(Math.random() * this.groundFires.length)];
      if (!src) continue;
      src.getWorldPosition(this.tmp);
      this.dust.spawn(
        this.tmp.x + (Math.random() - 0.5) * 0.6,
        this.tmp.y - 0.1,
        this.tmp.z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.4,
        1 + Math.random() * 1.6,
        (Math.random() - 0.5) * 0.4,
        0.4 + Math.random() * 0.7,
        FIRE_HOT,
        Math.random() < 0.3 ? 2 : 1,
        { g: -1.2, drag: 0.9, windK: 0.8, c2: FIRE_COOL },
      );
    }

    // ---- molten drips from the big breach
    this.dripTimer -= dt;
    if (this.dripTimer <= 0) {
      this.dripTimer = 0.3 + Math.random() * 1.2;
      this.fireFrom[0].getWorldPosition(this.tmp);
      this.dust.spawn(this.tmp.x + (Math.random() - 0.5), this.tmp.y - 0.3, this.tmp.z + 0.3 * this.cs, 0, -0.5, 0.4 * this.cs, 1.4, SPARK_HOT, 1, {
        g: 9,
        drag: 0.3,
        windK: 0,
        c2: FIRE_COOL,
      });
    }

    // ---- showers of sparks from the break
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 1.5 + Math.random() * 4;
      this.sparkFrom[0].getWorldPosition(this.tmp);
      this.burst(this.tmp, 20, 3.5, SPARK_HOT, SPARK_COOL, 1);
      this.audio.siteSpark(this.sound, 0.5);
    }

    // ---- the jammed door's frame shorts out now and then
    if (this.state === 'locked') {
      this.doorSparkTimer -= dt;
      if (this.doorSparkTimer <= 0) {
        this.doorSparkTimer = 3 + Math.random() * 6;
        this.doorSparkFrom.getWorldPosition(this.tmp);
        this.burst(this.tmp, 8, 1.8, ARC_HOT, ARC_COOL, 1);
        this.audio.siteZap(this.sound, 0.35);
      }
    }

    // ---- something inside goes up: a flash, a fireball, debris, a boom that shakes the ground
    this.boomTimer -= dt;
    if (this.boomTimer <= 0) {
      this.boomTimer = 14 + Math.random() * 20;
      const src = this.fireFrom[Math.floor(Math.random() * this.fireFrom.length)];
      src.getWorldPosition(this.tmp);
      this.burst(this.tmp, 26, 5, FLASH, FIRE_COOL, 3, -0.4);
      this.burst(this.tmp, 30, 6, SPARK_HOT, SPARK_COOL, 1);
      for (let i = 0; i < 18; i++) {
        this.dust.spawn(
          this.tmp.x + (Math.random() - 0.5),
          this.tmp.y + Math.random(),
          this.tmp.z + (Math.random() - 0.5),
          (Math.random() - 0.5) * 2,
          1.5 + Math.random() * 2,
          (Math.random() - 0.5) * 2,
          5 + Math.random() * 4,
          SMOKE_DARK,
          3,
          { g: -0.4, drag: 0.6, windK: 1, c2: SMOKE_LIGHT },
        );
      }
      this.flare = 1;
      this.shake = 1 / (1 + (d / 14) * (d / 14));
      this.audio.shipBoom(this.sound, 0.9);
    }

    // ---- the hull groans as it settles; the alarm still sounds somewhere inside
    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = 6 + Math.random() * 9;
      this.audio.shipGroan(this.sound, 0.35);
    }
    this.alarmTimer -= dt;
    if (this.alarmTimer <= 0) {
      this.alarmTimer = 14 + Math.random() * 12;
      this.audio.shipAlarm(this.sound, 0.12);
    }
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) {
      this.tickTimer = 0.2 + Math.random() * 0.8;
      this.audio.siteTick(this.sound, 0.2 + Math.random() * 0.3);
    }

    // ---- sand slides down the bank it shoved up
    this.trickleTimer -= dt;
    if (this.trickleTimer <= 0) {
      this.trickleTimer = 0.8 + Math.random() * 2;
      const s = (Math.random() - 0.5) * 5;
      this.localToGround(SHIP_LENGTH / 2 + 1.2, s, this.tmp);
      for (let i = 0; i < 10; i++) {
        this.dust.spawn(this.tmp.x + (Math.random() - 0.5) * 0.4, this.tmp.y + 0.05, this.tmp.z + (Math.random() - 0.5) * 0.4, -SITE3.dx * 0.8, 0.1, -SITE3.dz * 0.8, 1.2, SAND[i % 2], 1, {
          g: 3,
          drag: 0.6,
          windK: 0.2,
        });
      }
    }
  }

  private burst(at: Vector3, n: number, speed: number, c: number[], c2: number[], size: number, g = 9) {
    for (let i = 0; i < n; i++) {
      this.dust.spawn(
        at.x,
        at.y,
        at.z,
        (Math.random() - 0.5) * speed,
        Math.random() * speed * 0.7,
        (Math.random() - 0.5) * speed,
        0.25 + Math.random() * 0.5,
        c,
        size,
        { g, drag: 1.4, windK: 0.1, c2 },
      );
    }
  }

  private updateKeypad(dt: number, time: number) {
    if (this.seq.length) {
      this.seqTimer -= dt;
      if (this.seqTimer <= 0) this.seq = [];
    }
    if (this.verdict !== 'none') {
      this.verdictT += dt;
      if (this.verdict === 'bad' && this.verdictT > 0.45 && this.verdictT - dt <= 0.45) this.audio.padError(0.25);
      if (this.verdict === 'good' && this.verdictT > 0.5 && this.verdictT - dt <= 0.5) {
        this.audio.padAccept(TUNE, 0.18);
        this.state = 'cracking';
        this.crackT = 0;
      }
      if (this.verdictT > (this.verdict === 'bad' ? 1.3 : 99)) this.verdict = 'none';
    }
    // a damaged keypad: it keeps trying to boot, scrambling through its buttons; now and
    // then it blacks out and comes back with a flash; two of its buttons stutter. It
    // calms down while someone is pressing it.
    this.sincePress += dt;
    const glitchy = this.state === 'locked' && this.verdict === 'none' && this.sincePress > 2.5;
    const powered = this.state === 'locked' ? 0.85 + 0.15 * noise1(time * 13, 9) : 1;
    const cycle = Math.floor(time / 2.4);
    const ph = time - cycle * 2.4;
    const boot = glitchy && ph < 0.5 ? BOOT_ORDER[(Math.floor(ph / 0.055) + cycle) % 9] : -1;
    // ...then the whole pad flashes twice, like a display that keeps failing its self-test
    const allFlash = glitchy && ((ph > 0.62 && ph < 0.74) || (ph > 0.86 && ph < 0.98));
    const dark = glitchy && noise1(time * 1.7, 61) > 0.62 && noise1(time * 23, 62) > -0.2;
    const comeback = glitchy && !dark && this.wasDark;
    if (comeback) this.flashT = 0.12;
    this.wasDark = dark;
    this.flashT = Math.max(0, this.flashT - dt);
    this.buttons.forEach((b, i) => {
      b.press = Math.max(0, b.press - dt * 4);
      let ink = INK_IDLE;
      let scale = powered;
      if (this.state !== 'locked' || this.verdict === 'good') ink = INK_GOOD;
      else if (this.verdict === 'bad' && this.verdictT > 0.45) ink = Math.floor((this.verdictT - 0.45) * 6) % 2 === 0 ? INK_BAD : INK_IDLE;
      else if (b.press > 0) ink = INK_PRESS;
      else if (i === this.hovered) ink = INK_HOVER;
      else if (dark) scale = 0.15;
      else if (this.flashT > 0 || i === boot || allFlash) ink = INK_PRESS;
      else if (glitchy && (i === 2 || i === 6) && Math.sin(time * (29 + i * 3)) > 0.2) ink = INK_HOVER;
      const u = b.mat.uniforms;
      (u.uInk.value as Vector3).copy(ink).multiplyScalar(ink === INK_IDLE ? scale : 1);
      (u.uBase.value as Vector3).copy(b.press > 0 || i === boot || allFlash ? BUTTON_BASE_LIT : BUTTON_BASE);
      b.group.position.z = 0.02 - b.press * 0.012;
    });
    // it spits a spark now and then while it is broken
    if (glitchy) {
      this.padSparkTimer -= dt;
      if (this.padSparkTimer <= 0) {
        this.padSparkTimer = 2.5 + Math.random() * 4;
        this.padSparkFrom.getWorldPosition(this.tmp);
        this.burst(this.tmp, 6, 1.4, SPARK_HOT, SPARK_COOL, 1);
        this.audio.siteZap(this.sound, 0.22);
      }
    }
  }

  private updateDoor(dt: number, time: number) {
    const status = this.state === 'locked' ? (Math.floor(time * 1.6) % 2 ? rgb(0xffb347) : rgb(0x4a3418)) : rgb(0x8cf0a8);
    (this.statusMat.uniforms.uLight.value as Vector3).copy(status);
    if (this.state !== 'locked') {
      const e = 0.35 + 0.65 * Math.max(0, noise1(time * 5, 4));
      (this.emergencyMat.uniforms.uLight.value as Vector3).copy(rgb(e > 0.6 ? 0xe02828 : 0x7a1010));
    }
    if (this.state === 'cracking') {
      // the lock lets go: a servo strains, bolts clunk, it jerks open a hand's width
      if (this.crackT === 0) this.audio.doorCrack(0.4);
      this.crackT += dt;
      const t = this.crackT;
      this.doorOpen = t < 1.0 ? 0.01 * Math.sin(t * 40) * smoothstep(0.2, 0.9, t) : 0.13 * smoothstep(1.0, 1.25, t) + (t < 1.6 ? 0.006 * Math.sin(t * 60) : 0);
      if (t > 1.3 && t - dt <= 1.3) {
        // the seal breaks: stale air puffs out of the gap
        this.doorEdge(0.8, this.tmp);
        for (let i = 0; i < 30; i++) {
          this.dust.spawn(
            this.tmp.x,
            this.doorGround + 0.2 + Math.random() * 1.3,
            this.tmp.z,
            this.doorNormal.x * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.4,
            (Math.random() - 0.3) * 0.3,
            this.doorNormal.z * (0.6 + Math.random()) + (Math.random() - 0.5) * 0.4,
            1.5 + Math.random(),
            [0.92, 0.94, 0.95],
            2,
            { g: 0.5, drag: 1.4, windK: 0.6, c2: [0.75, 0.73, 0.7], soft: true },
          );
        }
      }
      if (t > 2) this.state = 'cracked';
    }
    this.doorPanel.position.x = this.doorLocal.x + this.slideSign * this.doorOpen * (DOOR.x1 - DOOR.x0) * 0.98;
  }
}

type Mats = Record<'hull' | 'panel' | 'charred' | 'soot' | 'accent' | 'glass' | 'metal' | 'hole', Material>;
