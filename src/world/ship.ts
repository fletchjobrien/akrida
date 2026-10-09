import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  GLSL3,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
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
import { SHIP_LENGTH, SITE3 } from './crater';
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

/** The hull's cross-section radius along its length (x from aft to bow). */
const PROFILE: [number, number][] = [
  [-10, 1.55],
  [-9.6, 1.9],
  [-8, 2.15],
  [-2, 2.3],
  [3, 2.25],
  [6, 1.95],
  [8, 1.45],
  [9.3, 0.85],
  [10, 0.25],
  [10.15, 0],
];
/** The hull is a little flatter than it is wide. */
const FLAT = 0.82;
/** Where its back broke. */
const BREAK = -1.25;
/** How far its centre sits above the trench floor. */
const RIDE = 1.2;

function radiusAt(x: number) {
  if (x <= PROFILE[0][0]) return PROFILE[0][1];
  for (let i = 1; i < PROFILE.length; i++) {
    const [x1, r1] = PROFILE[i];
    if (x <= x1) {
      const [x0, r0] = PROFILE[i - 1];
      return r0 + ((r1 - r0) * (x - x0)) / (x1 - x0);
    }
  }
  return 0;
}

/** 7x7 glyphs for the keypad: an alien script, one per button. */
const GLYPHS = [
  ['..###..', '.#...#.', '...#...', '..###..', '...#...', '.#...#.', '..###..'],
  ['#.....#', '.#...#.', '..#.#..', '...#...', '...#...', '..#.#..', '.#...#.'],
  ['...#...', '..#.#..', '.#...#.', '#######', '.......', '..###..', '.......'],
  ['#######', '#......', '#.###..', '#.#.#..', '#.###..', '#......', '#######'],
  ['..#.#..', '..#.#..', '#######', '..#.#..', '#######', '..#.#..', '..#.#..'],
  ['.#####.', '#.....#', '#..#..#', '#.###.#', '#..#..#', '#.....#', '.#####.'],
  ['#...#..', '.#.#...', '..#....', '.#.#...', '#...#..', '....#..', '...###.'],
  ['...#...', '...#...', '.#####.', '#..#..#', '...#...', '..#.#..', '.#...#.'],
  ['.##.##.', '#..#..#', '#.....#', '.#...#.', '..#.#..', '...#...', '.......'],
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
  private readonly housing = new Group();
  private readonly doorPanel = new Group();
  private readonly doorSparkFrom = new Object3D();
  private readonly statusMat: ShaderMaterial;
  private readonly emergencyMat: ShaderMaterial;
  private readonly padPanel: Mesh;
  private readonly buttons: Button[] = [];
  private readonly glyphs = glyphTexture();
  private readonly ray = new Raycaster();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
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
    this.padPanel = this.buildAirlock(rocks);
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

  /** A point on (or `lift` off) the hull surface at station x, angle phi from the top toward local +z. */
  private surface(x: number, phi: number, lift = 0) {
    const r = radiusAt(x);
    return new Vector3(x, (r * FLAT + lift) * Math.cos(phi), (r + lift) * Math.sin(phi));
  }

  /** Put a mesh on the hull at (x, phi), its local +y pointing out of the surface. */
  private onHull(geo: BufferGeometry, mat: Material, x: number, phi: number, lift = 0, spin = 0) {
    const [parent, hx] = this.host(x);
    const p = this.surface(x, phi, lift);
    const m = this.add(parent, geo, mat, hx, p.y, p.z);
    m.rotation.set(phi, 0, 0);
    m.rotateY(spin);
    return m;
  }

  /** A lathed slice of the hull between stations x0 and x1, optionally only an arc of it. */
  private hullSlice(x0: number, x1: number, mat: Material, inflate = 0, from = 0, arc = Math.PI * 2, segs = 14) {
    const [parent] = this.host((x0 + x1) / 2);
    const offset = parent === this.bow ? BREAK : 0;
    const pts: Vector2[] = [];
    const xs = [x0, ...PROFILE.map((p) => p[0]).filter((x) => x > x0 && x < x1), x1];
    for (const x of xs) pts.push(new Vector2(radiusAt(x) + inflate, x - offset));
    // (lathe angle a puts a vertex at height -r sin a and depth r cos a once turned on its side,
    // so phi from the top toward +z is lathe angle phi - pi/2)
    const g = new LatheGeometry(pts, segs, from - Math.PI / 2, arc);
    g.rotateZ(-Math.PI / 2);
    g.scale(1, FLAT, 1);
    return this.add(parent, g, mat, 0, 0, 0);
  }

  private buildHull() {
    const m = this.hull;
    const cs = this.cs;
    this.bow.position.set(BREAK, 0, 0);
    // the back broke: the bow half is bent down and aside
    this.bow.rotation.set(0, 0.07 * cs, -0.045);
    this.group.add(this.bow);

    const aft = this.hullSlice(-10, BREAK - 0.32, m.hull);
    const fore = this.hullSlice(BREAK + 0.3, 10.15, m.hull);
    this.hullParts.push(aft, fore);
    // seared underside and flanks from coming in hot
    this.hullSlice(-9.8, BREAK - 0.35, m.charred, 0.02, Math.PI * 0.62, Math.PI * 0.76);
    this.hullSlice(BREAK + 0.33, 9.6, m.charred, 0.02, Math.PI * 0.6, Math.PI * 0.8);
    // bands, the same orange as the pods'
    for (const [x0, x1] of [
      [-8.9, -8.5],
      [-3.2, -3.0],
      [4.3, 4.7],
      [7.1, 7.22],
    ]) {
      this.hullSlice(x0, x1, m.accent, 0.025);
    }
    // panel lines: slightly darker plates along the top
    for (const x of [-7, -5.2, 1.4, 5.6]) this.hullSlice(x, x + 0.9, m.panel, 0.012, -0.5, 1.0, 14);

    // the broken ends: frame rings, a dark inside, plates bent into the gap
    for (const [x, sgn] of [
      [BREAK - 0.34, -1],
      [BREAK + 0.32, 1],
    ]) {
      const [parent, hx] = this.host(x + sgn * 0.01);
      const r = radiusAt(x);
      const ring = this.add(parent, new TorusGeometry(r * 0.98, 0.09, 4, 14), m.metal, hx, 0, 0);
      ring.rotation.y = Math.PI / 2;
      ring.scale.set(1, FLAT, 1);
      const cap = this.add(parent, new CylinderGeometry(r * 0.95, r * 0.95, 0.04, 14), m.hole, hx - sgn * 0.12, 0, 0, false);
      cap.rotation.z = Math.PI / 2;
      cap.scale.set(FLAT, 1, 1);
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

    // the bridge: a band of dark windows wrapping the nose
    for (let k = -2; k <= 2; k++) this.onHull(new BoxGeometry(0.5, 0.06, 0.24), m.glass, 7.7, k * 0.32, 0.005, 0.25);
    // portholes along both flanks
    for (let k = 0; k < 7; k++) {
      for (const side of [1, -1]) this.onHull(new BoxGeometry(0.16, 0.05, 0.16), m.glass, 1.2 + k * 0.85, side * 1.05, 0.004);
    }

    // the pod bays: four in a row on the flank. Two stand empty: the two pods were launched.
    for (let k = 0; k < 4; k++) {
      const x = -8.4 + k * 1.15;
      const phi = 0.98 * cs;
      const ring = this.onHull(new TorusGeometry(0.42, 0.07, 4, 10), m.accent, x, phi, 0.02);
      ring.rotateX(Math.PI / 2);
      if (k === 1 || k === 2) {
        this.onHull(new CylinderGeometry(0.36, 0.36, 0.06, 10), m.hole, x, phi, 0.0);
        // the launch rails inside
        this.onHull(new BoxGeometry(0.05, 0.07, 0.6), m.metal, x - 0.15, phi, 0.0);
        this.onHull(new BoxGeometry(0.05, 0.07, 0.6), m.metal, x + 0.15, phi, 0.0);
      } else {
        this.onHull(new CylinderGeometry(0.37, 0.37, 0.05, 10), m.panel, x, phi, 0.02);
        this.onHull(new BoxGeometry(0.62, 0.06, 0.08), m.metal, x, phi, 0.04);
      }
    }

    // engines: three great bells at the stern; the lower one on the near side was torn away
    const block = this.add(this.group, new CylinderGeometry(1.45, 1.55, 0.5, 14), m.metal, -10.15, 0, 0);
    block.rotation.z = Math.PI / 2;
    block.scale.set(FLAT, 1, 1);
    for (const [y, z] of [
      [0.42, 0],
      [-0.42, -0.75 * cs],
    ]) {
      const g = new CylinderGeometry(0.78, 0.5, 1.4, 12, 1, true);
      g.rotateZ(Math.PI / 2);
      this.add(this.group, g, m.charred, -11.05, y, z);
      const inner = new CylinderGeometry(0.72, 0.48, 0.05, 12);
      inner.rotateZ(Math.PI / 2);
      this.add(this.group, inner, m.hole, -11.5, y, z, false);
    }
    // a stump where the third one tore off
    this.add(this.group, new CylinderGeometry(0.42, 0.5, 0.35, 10), m.charred, -10.5, -0.42, 0.75 * cs).rotation.z = Math.PI / 2;

    // wings: the far one intact, the near one sheared off near the root
    const far = this.add(this.group, new BoxGeometry(4.6, 0.16, 2.6), m.hull, -5, -0.45, -cs * 3.2);
    far.rotation.set(0.12 * -cs, 0.18 * cs, 0);
    this.add(this.group, new BoxGeometry(4.4, 0.17, 0.3), m.accent, -5.1, -0.4, -cs * 4.3).rotation.y = 0.18 * cs;
    const stub = this.add(this.group, new BoxGeometry(2.6, 0.18, 0.9), m.hull, -5.3, -0.55, cs * 2.4);
    stub.rotation.y = -0.1 * cs;
    this.add(this.group, new BoxGeometry(2.4, 0.2, 0.18), m.charred, -5.3, -0.55, cs * 2.85);
    // the dorsal fin, bent over
    const fin = this.add(this.group, new BoxGeometry(2.4, 1.5, 0.14), m.hull, -8, 2.3, 0);
    fin.rotation.x = 0.38 * cs;
    this.add(this.group, new BoxGeometry(2.4, 0.22, 0.16), m.accent, -8, 2.95, 0.25 * cs).rotation.x = 0.38 * cs;
    // a sensor mast near the bow, snapped and hanging
    const mast = this.add(this.bow, new CylinderGeometry(0.05, 0.05, 1.4, 4), m.metal, 6.2 - BREAK, 1.75, 0.3);
    mast.rotation.set(0.2, 0, -1.1);

    // nav lights: red at the fin tip, white on the nose, one flickering on the wing
    const nav = (parent: Object3D, x: number, y: number, z: number, on: number, period: number) => {
      const mat = toonMaterial({ dark: on, mid: on, light: on, unlit: true, outline: 0 });
      this.add(parent, new BoxGeometry(0.12, 0.12, 0.12), mat, x, y, z, false);
      this.navLights.push({ mat, on: rgb(on), off: rgb(0x2a1a18), period, phase: Math.random() });
    };
    nav(this.group, -8.9, 3.0, 0.4 * cs, 0xff3c2c, 1.9);
    nav(this.bow, 9.9 - BREAK, 0.35, 0, 0xf4f0e8, 2.6);
    nav(this.group, -5.2, -0.3, -cs * 4.5, 0x50ff80, 3.1);
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
      [-2.8, 1.2, 1],
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
      const x = -half - 50 * (1 - t) - 1;
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
    const wing = lay(new BoxGeometry(4.2, 0.16, 2.2), m.hull, -half - 17, cs * 3.4, 0.05, true);
    wing.rotation.set(0.12, 0.6, -0.08);
    const edge = lay(new BoxGeometry(4, 0.18, 0.28), m.accent, -half - 17.2, cs * 4.3, 0.04);
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
   * The airlock: a boxy housing on the flank facing the viewer, down to the
   * ground, its door buckled and jammed, a keypad beside it.
   */
  private buildAirlock(rocks: Rocks): Mesh {
    const m = this.hull;
    const cs = this.cs;
    const station = -3.4;
    const out = 2.0 + 0.9; // face, out from the hull's axis
    // world frame of the housing: along the hull, out of the face, up
    const outward = new Vector3(this.sinY, 0, this.cosY).multiplyScalar(cs);
    this.localToGround(station, cs * (out + 0.55), this.tmp);
    const g = this.tmp.y;
    this.doorGround = g;
    this.localToGround(station, cs * out, this.tmp2);
    const H = this.housing;
    H.position.set(this.tmp2.x, g, this.tmp2.z);
    // its local x along the hull, z out of the face
    H.rotation.y = Math.atan2(outward.x, outward.z);
    this.debris.push(H);
    const ax = new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), H.rotation.y);

    const box = (w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, shadow = true) =>
      this.add(H, new BoxGeometry(w, h, d), mat, x, y, z, shadow);
    // the housing, sunk into the sand, reaching back into the hull: a block behind, and
    // a face built round the doorway, with a pocket on one side the door slides into
    const dw = this.doorWidth;
    const dh = this.doorHeight;
    const dx = -0.3; // door centre across the face
    const L = -1.0;
    const R = 1.4;
    const top = 2.2;
    const recess = 0.62;
    box(R - L, top + 0.4, 1.6 - recess, m.hull, (L + R) / 2, top / 2 - 0.2, -recess - (1.6 - recess) / 2);
    const leftW = dx - dw / 2 - L;
    const rightW = R - (dx + dw / 2);
    box(leftW, top + 0.4, recess, m.hull, L + leftW / 2, top / 2 - 0.2, -recess / 2);
    box(rightW, top + 0.4, recess, m.hull, R - rightW / 2, top / 2 - 0.2, -recess / 2);
    box(dw, top - dh - 0.12, recess, m.hull, dx, (top + dh + 0.12) / 2, -recess / 2);
    box(dw, 0.4, recess, m.hull, dx, -0.08, -recess / 2);
    box(R - L + 0.04, 0.18, 1.62, m.accent, (L + R) / 2, top - 0.2, -0.8);
    box(R - L + 0.1, 0.12, 1.7, m.metal, (L + R) / 2, top + 0.04, -0.82);
    // hazard chevrons down the far edge
    for (let k = 0; k < 4; k++) box(0.08, 0.16, 0.02, k % 2 ? m.metal : m.accent, R - 0.1, 0.35 + k * 0.32, 0.01);
    // scorch over the top corner
    const sc = this.add(H, new IcosahedronGeometry(0.6, 0), m.soot, L + 0.3, top - 0.3, -0.25);
    sc.scale.set(1.4, 0.8, 0.5);

    // the doorway: frame, a dark recess, a red emergency light deep in it
    box(dw + 0.16, 0.1, 0.12, m.metal, dx, dh + 0.17, 0.02);
    box(0.09, dh + 0.1, 0.12, m.metal, dx - dw / 2 - 0.045, dh / 2 + 0.12, 0.02);
    box(0.09, dh + 0.1, 0.12, m.metal, dx + dw / 2 + 0.045, dh / 2 + 0.12, 0.02);
    box(dw + 0.16, 0.08, 0.14, m.metal, dx, 0.08, 0.02);
    box(dw, dh, 0.02, m.hole, dx, dh / 2 + 0.12, -recess + 0.01, false);
    box(dw, 0.02, recess, m.hole, dx, dh + 0.11, -recess / 2, false);
    box(0.02, dh, recess, m.hole, dx - dw / 2, dh / 2 + 0.12, -recess / 2, false);
    box(0.02, dh, recess, m.hole, dx + dw / 2, dh / 2 + 0.12, -recess / 2, false);
    box(dw, 0.02, recess, m.hole, dx, 0.12, -recess / 2, false);
    box(0.5, 0.06, 0.03, this.emergencyMat, dx, dh - 0.05, -recess + 0.03, false);
    // the door: buckled across the middle, set just inside the face so it slides into the pocket
    const D = this.doorPanel;
    D.position.set(dx, dh / 2 + 0.12, -0.06);
    H.add(D);
    const upper = this.add(D, new BoxGeometry(dw, dh * 0.52, 0.07), m.panel, 0, dh * 0.24, 0);
    upper.rotation.x = -0.05;
    const lower = this.add(D, new BoxGeometry(dw, dh * 0.5, 0.07), m.panel, 0, -dh * 0.25, 0.012);
    lower.rotation.x = 0.06;
    this.add(D, new BoxGeometry(dw * 0.95, 0.07, 0.08), m.accent, 0, dh * 0.38, 0.02);
    this.add(D, new BoxGeometry(0.06, dh * 0.35, 0.09), m.metal, -dw * 0.38, 0, 0.03);
    const dent = this.add(D, new IcosahedronGeometry(0.22, 0), m.charred, dw * 0.12, -0.05, 0.0);
    dent.scale.set(1.2, 0.8, 0.25);
    // it slides toward the pocket side (the housing's +x)
    this.slideDir.copy(ax);
    this.slideSign = 1;
    this.doorSparkFrom.position.set(dx - dw / 2 - 0.05, dh * 0.7, 0.06);
    H.add(this.doorSparkFrom);
    // status light over the door: amber while locked
    box(0.1, 0.07, 0.05, this.statusMat, dx, dh + 0.3, 0.04, false);

    // the keypad, on a tilted panel beside the door
    const pad = new Group();
    pad.position.set(0.72, 0.98, 0.05);
    pad.rotation.x = -0.42;
    H.add(pad);
    const panel = this.add(pad, new BoxGeometry(0.74, 0.74, 0.06), m.metal, 0, 0, 0);
    this.add(pad, new BoxGeometry(0.78, 0.04, 0.08), m.accent, 0, 0.39, 0);
    const mats: ShaderMaterial[] = [];
    for (let i = 0; i < 9; i++) {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const b = new Group();
      b.position.set((col - 1) * 0.22, (1 - row) * 0.22, 0.035);
      pad.add(b);
      this.add(b, new BoxGeometry(0.2, 0.2, 0.04), m.charred, 0, 0, 0, false);
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
      const face = new Mesh(new PlaneGeometry(0.18, 0.18), mat);
      face.position.z = 0.021;
      b.add(face);
      mats.push(mat);
      this.buttons.push({ group: b, face, mat, press: 0 });
    }

    H.updateMatrixWorld(true);
    const local = (x: number, y: number, z: number, o = new Vector3()) => H.localToWorld(o.set(x, y, z));
    local(dx, dh / 2 + 0.12, 0, this.doorCenter);
    pad.getWorldPosition(this.padCenter);
    this.doorNormal.copy(outward);
    this.doorLocal = { x: dx, y: dh / 2 + 0.12 };
    // the housing blocks the way; the door stands in its face
    const blocker = new Mesh(new BoxGeometry(2.4, 1, 1.6));
    blocker.position.set(0.2, 0.5, -0.8);
    H.add(blocker);
    blocker.updateMatrixWorld(true);
    rocks.addStatic(footprintOf(blocker, 2));
    H.remove(blocker);
    return panel;
  }

  private slideSign = 1;
  private doorLocal = { x: 0, y: 0 };

  /** Where a hand grips the door's open edge, at height `y` above the ground. */
  doorEdge(y: number, out: Vector3) {
    const x = this.doorLocal.x + this.slideSign * (this.doorOpen * this.doorWidth * 0.98) - this.slideSign * this.doorWidth / 2;
    return this.housing.localToWorld(out.set(x, y, 0.02));
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
    const tone = PAD_TONES[i];
    this.audio.padTone(tone, 0.22);
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
    const powered = this.state === 'locked' ? 0.85 + 0.15 * noise1(time * 13, 9) : 1;
    this.buttons.forEach((b, i) => {
      b.press = Math.max(0, b.press - dt * 4);
      let ink = INK_IDLE;
      if (this.state !== 'locked' || this.verdict === 'good') ink = INK_GOOD;
      else if (this.verdict === 'bad' && this.verdictT > 0.45) ink = Math.floor((this.verdictT - 0.45) * 6) % 2 === 0 ? INK_BAD : INK_IDLE;
      else if (b.press > 0) ink = INK_PRESS;
      else if (i === this.hovered) ink = INK_HOVER;
      const u = b.mat.uniforms;
      (u.uInk.value as Vector3).copy(ink).multiplyScalar(ink === INK_IDLE ? powered : 1);
      (u.uBase.value as Vector3).copy(b.press > 0 ? BUTTON_BASE_LIT : BUTTON_BASE);
      b.group.position.z = 0.035 - b.press * 0.018;
    });
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
    this.doorPanel.position.x = this.doorLocal.x + this.slideSign * this.doorOpen * this.doorWidth * 0.98;
  }
}

type Mats = Record<'hull' | 'panel' | 'charred' | 'soot' | 'accent' | 'glass' | 'metal' | 'hole', Material>;
