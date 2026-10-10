import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Material,
  type ShaderMaterial,
} from 'three';
import { noise1 } from '../core/math';
import { shared, toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { convexHull, type RockInfo } from './rocks';
import type { Dust } from './particles';
import type { AudioEngine } from '../audio/AudioEngine';

/** The deck's height over the station's ground, in the habitat's frame. */
const DECK = 0.85;
/** The lab's middle, in the habitat's frame. */
const LAB_X = 8.4;
const LAB_Z = 0.4;
const LAB_R = 2.45;
/** The doorway: across the front wall, and how far out the way out begins. */
const DOOR_X0 = 0.35;
const DOOR_X1 = 1.45;
const DOOR_OUT = 1.42;

const C = (hex: number) => rgb(hex).toArray();
const BUBBLE = C(0x9af0e8);
const BUBBLE_FADE = C(0x4ab0a8);
const MOTE = C(0xf0e2c0);
const SPARK_HOT = C(0xfff4c8);
const SPARK_COOL = C(0xd9824a);

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/** Turn a geometry inside out, so it is seen from within (the inside of a curved wall). */
function inward(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  const p = f.getAttribute('position');
  for (let i = 0; i + 2 < p.count; i += 3) {
    const x = p.getX(i + 1);
    const y = p.getY(i + 1);
    const z = p.getZ(i + 1);
    p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    p.setXYZ(i + 2, x, y, z);
  }
  f.computeVertexNormals();
  return f;
}

type StationMats = Record<'hull' | 'panel' | 'accent' | 'metal' | 'glass' | 'hole' | 'charred' | 'soot' | 'solar' | 'pad', Material>;

/**
 * Inside the research station: the habitat's one long room, and the domed lab
 * through the short tube at its end.
 *
 * - The crew's quarters at the far end: a bunk bed, its blanket dragged half
 *   off, lockers (one hanging open), a fold-down table with cups still on it,
 *   a knocked-over stool, a rug and a picture of somewhere green.
 * - By the airlock: a rack with one pressure suit left on it and an empty
 *   hook, a bench with a helmet, and grey-blue smears on the deck where the
 *   three were dragged out.
 * - The work bay: a desk under three screens (one cracked and flickering), a
 *   wall display showing a scan of one of the creature's own kind, a chair
 *   spun away from the desk, papers on the deck, a humming rack of blinking
 *   lights, and a torn cable that sparks.
 * - The lab: a specimen tank glowing in the middle with one of the creature's
 *   kind curled up in it, bubbles rising past it; a second tank smashed, its
 *   fluid spilled; a bench with a microscope and racks of vials, a cold
 *   cabinet, a console, cables over the floor, and sunlight falling through
 *   the broken dome with dust drifting in it.
 *
 * Laser fire has scorched the walls inside too, and a red emergency strip
 * pulses along the foot of the back wall. Lamps light the rooms (see
 * `roomLight` in render/shared.ts); one in the work bay flickers.
 */
export class StationInterior {
  /** Everything inside, in the habitat's frame. */
  readonly root = new Group();
  /** Parts that move or change, kept out of the station's merged meshes. */
  readonly keep: Object3D[] = [];
  /** The walls and furniture, for the creature to bump into (world space). */
  readonly colliders: RockInfo[] = [];
  readonly glows: Glow[] = [];
  /** The deck's height in the world. */
  floorY = 0;
  /** Just inside the airlock (world space), and the way into the room from it. */
  readonly spawn = new Vector3();
  readonly inward = new Vector3();

  private readonly mats: Record<string, Material> = {};
  private readonly screens: { mat: ShaderMaterial; on: number[]; glow: Glow; kind: 'steady' | 'cracked' }[] = [];
  private readonly leds: { mat: ShaderMaterial; phase: number; rate: number; color: number[] }[] = [];
  private emergency!: ShaderMaterial;
  private readonly lamps: { pos: Vector3; base: number; flicker: boolean }[] = [];
  private specimen!: Group;
  private readonly tankAt = new Vector3();
  private readonly sunAt = new Vector3();
  private readonly cableAt = new Vector3();
  private bubbleTimer = 0;
  private moteTimer = 0;
  private sparkTimer = 3;
  private crackleTimer = 2;
  private flick = 1;
  private readonly tmp = new Vector3();
  private readonly inv = new Matrix4();

  constructor(
    station: Group,
    private readonly m: StationMats,
    private readonly audio: AudioEngine,
    private readonly dust: Dust,
  ) {
    this.root.position.set(0, 0, -1.6);
    station.add(this.root);
    const t = (dark: number, mid: number, light: number, outline = 0.6, highlight = 0.6) =>
      toonMaterial({ dark, mid, light, litAt: 0.55, outline, highlight });
    const u = (c: number) => toonMaterial({ dark: c, mid: c, light: c, unlit: true, outline: 0 });
    Object.assign(this.mats, {
      deck: t(0x24242a, 0x38383f, 0x52525a),
      grate: t(0x18181c, 0x26262c, 0x3a3a44, 0.5, 0.3),
      lining: t(0x55514b, 0x847e72, 0xb0aa9b),
      trim: t(0x3a3836, 0x56524e, 0x76706a),
      cut: t(0x1a1716, 0x221e1d, 0x2e2927, 0.8, 0),
      blanket: t(0x232c3a, 0x36465a, 0x506479),
      mattress: t(0x58524a, 0x7e776a, 0xa29a8a),
      rug: t(0x3a2220, 0x58332e, 0x76473e),
      paper: t(0x8a867c, 0xc4beb0, 0xe6e0d2, 0.4, 0.2),
      suit: t(0x6a6a64, 0x9c9a90, 0xcac8bc),
      fur: t(0x5e574e, 0x857d70, 0xa8a090),
      puddle: t(0x163232, 0x204846, 0x2a5e5a, 0, 0),
      blood: t(0x1e2630, 0x28323e, 0x34414f, 0, 0),
      wood: t(0x3e2c20, 0x5a4230, 0x765a42),
      picture: u(0x4a8a5a),
      sky: u(0x8ab8d0),
      display: u(0x16283a),
      scan: u(0x6ad0e0),
      dead: u(0x0c1014),
      cold: u(0x9ad0e8),
    });
  }

  private add(parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, shadow = true) {
    const m = new Mesh(faceted(geo), mat);
    m.position.set(x, y, z);
    if (shadow) m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  }

  /** A box from (x0, y0, z0) to (x1, y1, z1). */
  private box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: Material, parent: Object3D = this.root, shadow = true) {
    return this.add(parent, new BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, shadow);
  }

  /** A flat mark lying on the deck. */
  private mark(x: number, z: number, w: number, d: number, spin: number, mat: Material, lift = 0.004) {
    const k = this.add(this.root, new BoxGeometry(w, 0.006, d), mat, x, DECK + lift, z, false);
    k.rotation.y = spin;
    return k;
  }

  /** Something in the way, its outline given in the habitat's frame. */
  private block(pts: [number, number][]) {
    const w: number[] = [];
    const v = new Vector3();
    let cx = 0;
    let cz = 0;
    for (const [x, z] of pts) {
      this.root.localToWorld(v.set(x, 0, z));
      w.push(v.x, v.z);
      cx += v.x;
      cz += v.z;
    }
    cx /= pts.length;
    cz /= pts.length;
    const hull = convexHull(w);
    let radius = 0;
    for (let i = 0; i < hull.length; i += 2) radius = Math.max(radius, Math.hypot(hull[i] - cx, hull[i + 1] - cz));
    this.colliders.push({ x: cx, z: cz, radius, height: 2, hull });
  }

  private rect(x0: number, z0: number, x1: number, z1: number) {
    this.block([
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ]);
  }

  /** A rectangle centred at (x, z), w by d, turned by `yaw`. */
  private turned(x: number, z: number, w: number, d: number, yaw: number) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const pts: [number, number][] = [];
    for (const [a, b] of [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ]) pts.push([x + a * c + b * s, z - a * s + b * c]);
    this.block(pts);
  }

  private round(x: number, z: number, r: number) {
    const pts: [number, number][] = [];
    for (let k = 0; k < 8; k++) pts.push([x + Math.cos((k / 8) * Math.PI * 2) * r, z + Math.sin((k / 8) * Math.PI * 2) * r]);
    this.block(pts);
  }

  private glow(color: number, size: number, x: number, y: number, z: number, core = 0.5) {
    const g = new Glow(rgb(color), size, { core });
    this.root.localToWorld(g.position.set(x, y, z));
    g.strength = 0;
    this.glows.push(g);
    return g;
  }

  private screen(x: number, y: number, z: number, w: number, h: number, yaw: number, color: number, kind: 'steady' | 'cracked') {
    const mat = toonMaterial({ dark: color, mid: color, light: color, unlit: true, outline: 0 });
    const frame = this.add(this.root, new BoxGeometry(w + 0.06, h + 0.06, 0.05), this.m.metal, x, y, z);
    frame.rotation.y = yaw;
    const face = this.add(this.root, new BoxGeometry(w, h, 0.02), mat, 0, 0, 0.03, false);
    frame.add(face);
    const glow = this.glow(color, 0.35, x + Math.sin(yaw) * 0.15, y, z + Math.cos(yaw) * 0.15, 0.4);
    this.screens.push({ mat, on: rgb(color).toArray(), glow, kind });
    return frame;
  }

  // ------------------------------------------------------------------ build

  *build(): Generator<unknown, void, unknown> {
    this.root.updateMatrixWorld(true);
    this.buildShell();
    yield;
    this.buildQuarters();
    yield;
    this.buildAirlock();
    this.buildWorkBay();
    yield;
    this.buildLab();
    yield;
    this.root.updateMatrixWorld(true);
    this.floorY = this.root.localToWorld(this.tmp.set(0, DECK, 0)).y;
    this.root.localToWorld(this.spawn.set((DOOR_X0 + DOOR_X1) / 2, DECK, 0.95));
    this.inward.set(0, 0, -1).transformDirection(this.root.matrixWorld);
    this.inv.copy(this.root.matrixWorld).invert();
  }

  /** The deck, the walls seen from inside (cut off where the cutaway takes them), the tube's floor. */
  private buildShell() {
    const M = this.mats;
    const m = this.m;
    // the deck: plates, a grating down the middle, seams across
    this.box(-5.35, DECK - 0.12, -1.65, 5.35, DECK, 1.62, M.deck);
    this.box(-5.2, DECK, -0.32, 5.2, DECK + 0.004, 0.32, M.grate, this.root, false);
    for (let x = -4.6; x < 5.2; x += 1.15) this.box(x - 0.01, DECK, -1.62, x + 0.01, DECK + 0.006, 1.6, M.grate, this.root, false);
    // the back wall: panels, a kick strip, an orange stripe, the red emergency strip low down
    this.box(-5.35, DECK, -1.78, 5.35, 2.6, -1.62, M.lining);
    for (let x = -4.5; x < 5.2; x += 1.8) this.box(x - 0.015, DECK + 0.15, -1.62, x + 0.015, 2.55, -1.6, M.trim, this.root, false);
    this.box(-5.35, DECK, -1.62, 5.35, DECK + 0.14, -1.58, M.trim, this.root, false);
    this.box(-5.35, 1.95, -1.62, 5.35, 2.02, -1.6, m.accent, this.root, false);
    this.emergency = toonMaterial({ dark: 0x5a1010, mid: 0x5a1010, light: 0x5a1010, unlit: true, outline: 0 });
    this.box(-5.2, DECK + 0.05, -1.585, 5.2, DECK + 0.09, -1.57, this.emergency, this.root, false);
    // the wall's cut top, where the roof came away
    this.box(-5.5, 2.6, -2.34, 5.5, 2.68, -1.6, M.cut);
    // the front: a low sill on the inside, its cut top, broken by the doorway
    for (const [x0, x1] of [
      [-5.35, DOOR_X0],
      [DOOR_X1, 5.35],
    ]) {
      this.box(x0, DECK, 1.5, x1, 1.33, 1.62, M.lining);
      this.box(x0, 1.33, 1.5, x1, 1.39, 2.34, M.cut);
    }
    // the doorway: a threshold plate and the frame's cut ends
    this.box(DOOR_X0, DECK - 0.04, 1.5, DOOR_X1, DECK + 0.01, 2.36, m.metal);
    for (const x of [DOOR_X0 - 0.06, DOOR_X1 + 0.06]) this.box(x - 0.06, DECK, 1.5, x + 0.06, 1.42, 2.36, m.metal);
    // the far end, whole; the near end cut down to a sill with the way through to the lab
    this.box(-5.42, DECK, -1.65, -5.3, 2.6, 1.6, M.lining);
    for (const [z0, z1] of [
      [-1.65, -0.35],
      [0.75, 1.6],
    ]) {
      this.box(5.3, DECK, z0, 5.42, 1.33, z1, M.lining);
      this.box(5.3, 1.33, z0, 5.65, 1.39, z1, M.cut);
    }
    // the tube's floor and its cut sides
    this.box(5.3, DECK - 0.12, -0.35, 6.3, DECK, 0.75, M.deck);
    for (const z of [-0.42, 0.82]) this.box(5.4, DECK, z - 0.07, 6.2, 1.25, z + 0.07, M.cut);
    // the walls: the back, the sill either side of the door, the ends, the tube
    this.rect(-5.35, -1.85, 5.35, -1.6);
    this.rect(-5.35, 1.5, DOOR_X0, 1.75);
    this.rect(DOOR_X1, 1.5, 5.35, 1.75);
    // the doorway leads out; nothing beyond it lets the creature fall through
    this.rect(DOOR_X0 - 0.2, 2.2, DOOR_X1 + 0.2, 2.45);
    this.rect(-5.6, -1.8, -5.3, 1.8);
    this.rect(5.3, -1.8, 5.45, -0.35);
    this.rect(5.3, 0.75, 5.45, 1.8);
    this.rect(5.3, -0.5, 6.25, -0.35);
    this.rect(5.3, 0.75, 6.25, 0.9);
    this.block([
      [DOOR_X0 - 0.15, 1.5],
      [DOOR_X0, 1.5],
      [DOOR_X0, 2.4],
      [DOOR_X0 - 0.15, 2.4],
    ]);
    this.block([
      [DOOR_X1, 1.5],
      [DOOR_X1 + 0.15, 1.5],
      [DOOR_X1 + 0.15, 2.4],
      [DOOR_X1, 2.4],
    ]);
  }

  /** The crew's quarters, at the far end. */
  private buildQuarters() {
    const M = this.mats;
    const m = this.m;
    const R = this.root;
    // the bunk bed against the back wall
    const x0 = -5.25;
    const x1 = -3.35;
    for (const x of [x0 + 0.04, x1 - 0.04]) for (const z of [-1.58, -0.82]) this.box(x - 0.04, DECK, z - 0.04, x + 0.04, 2.4, z + 0.04, m.metal);
    for (const y of [1.05, 1.95]) {
      this.box(x0, y - 0.06, -1.6, x1, y + 0.02, -0.8, m.metal);
      this.box(x0 + 0.06, y + 0.02, -1.56, x1 - 0.06, y + 0.15, -0.84, M.mattress);
    }
    // the lower blanket dragged half onto the deck, the pillow thrown down
    this.box(x0 + 0.5, 1.17, -1.5, x1 - 0.1, 1.21, -0.86, M.blanket);
    const hang = this.box(-4.6, DECK + 0.05, -0.85, -3.7, DECK + 0.35, -0.6, M.blanket);
    hang.rotation.x = -0.9;
    this.box(-4.7, DECK, -0.6, -3.6, DECK + 0.05, -0.15, M.blanket).rotation.y = 0.15;
    this.add(R, new BoxGeometry(0.45, 0.1, 0.32), M.mattress, -3.0, DECK + 0.05, 0.55).rotation.y = 0.6;
    // the upper one still made, a cloth folded on it
    this.box(x0 + 0.08, 2.1, -1.55, x1 - 0.08, 2.14, -0.85, M.blanket);
    this.box(x0 + 0.1, 2.1, -1.5, x0 + 0.45, 2.2, -0.9, M.mattress);
    this.box(-3.9, 2.14, -1.3, -3.55, 2.18, -1.0, M.rug);
    // a ladder up to it
    for (const z of [-0.84, -0.62]) this.box(x1 + 0.02, DECK, z - 0.02, x1 + 0.06, 2.0, z + 0.02, m.metal);
    for (let y = DECK + 0.3; y < 2.0; y += 0.3) this.box(x1 + 0.02, y, -0.84, x1 + 0.06, y + 0.03, -0.62, m.metal);
    this.rect(x0 - 0.05, -1.65, x1 + 0.08, -0.76);
    // lockers in the corner by the door end, one hanging open, a jacket inside
    for (const z of [0.78, 1.24]) this.box(-5.3, DECK, z - 0.22, -4.86, 2.45, z + 0.22, M.trim);
    this.box(-4.86, DECK + 0.1, 0.58, -4.84, 2.4, 0.98, M.dead, R, false);
    const door = this.box(-4.86, DECK + 0.08, 0.56, -4.82, 2.42, 1.0, M.lining);
    door.geometry.translate(0, 0, 0.22);
    door.position.z -= 0.22;
    door.rotation.y = -1.1;
    this.keep.push(door);
    this.box(-5.1, 1.35, 0.68, -4.95, 2.15, 0.9, m.accent);
    this.box(-5.2, 2.2, 0.6, -4.9, 2.24, 0.98, m.metal);
    this.rect(-5.35, 0.52, -4.84, 1.5);
    // the rug, rucked up, and a fold-down table with the crew's last meal on it
    this.box(-4.6, DECK, -0.5, -3.3, DECK + 0.012, 0.6, M.rug, R, false).rotation.y = 0.12;
    this.box(-3.25, 1.5, -1.6, -2.3, 1.55, -1.05, M.wood);
    this.box(-2.85, DECK, -1.58, -2.75, 1.5, -1.5, m.metal);
    const cup = (x: number, z: number, mat: Material) => this.add(R, new CylinderGeometry(0.05, 0.045, 0.1, 6), mat, x, 1.6, z);
    cup(-3.05, -1.25, M.lining);
    cup(-2.6, -1.4, m.accent);
    this.add(R, new CylinderGeometry(0.13, 0.11, 0.02, 8), M.lining, -2.8, 1.56, -1.2);
    this.box(-2.55, 1.55, -1.3, -2.38, 1.565, -1.1, M.dead, R, false);
    this.rect(-3.3, -1.65, -2.25, -1.0);
    // stools: one still at the table, one knocked flat
    const stool = (x: number, z: number, lying: boolean) => {
      const S = new Group();
      S.position.set(x, DECK, z);
      R.add(S);
      this.add(S, new CylinderGeometry(0.2, 0.2, 0.05, 8), M.trim, 0, 0.62, 0);
      this.add(S, new CylinderGeometry(0.03, 0.03, 0.6, 4), m.metal, 0, 0.3, 0);
      this.add(S, new CylinderGeometry(0.17, 0.17, 0.03, 6), m.metal, 0, 0.015, 0);
      if (lying) {
        S.rotation.z = Math.PI / 2;
        S.position.y += 0.2;
        S.rotation.y = 0.7;
      }
    };
    stool(-2.75, -0.7, false);
    stool(-2.1, 0.25, true);
    this.round(-2.75, -0.7, 0.24);
    // a picture of somewhere green, over the table
    this.box(-3.15, 1.85, -1.62, -2.35, 2.42, -1.58, m.metal, R, false);
    this.box(-3.08, 1.92, -1.585, -2.42, 2.35, -1.575, M.sky, R, false);
    this.box(-3.08, 1.92, -1.575, -2.42, 2.1, -1.565, M.picture, R, false);
    // things knocked down in the struggle
    this.box(-1.95, DECK, 0.8, -1.7, DECK + 0.06, 1.0, M.paper, R, false).rotation.y = 0.4;
    this.mark(-3.6, 0.9, 0.5, 0.35, 0.3, M.blanket);
  }

  /** By the airlock: the suit rack, a bench, and the smears where the three were dragged out. */
  private buildAirlock() {
    const M = this.mats;
    const m = this.m;
    const R = this.root;
    // the rack across from the door: one suit left on it, one hook empty
    this.box(0.05, 1.0, -1.62, 1.85, 2.45, -1.55, M.trim);
    for (const x of [0.5, 1.4]) this.box(x - 0.04, 2.15, -1.58, x + 0.04, 2.3, -1.4, m.metal);
    const suit = new Group();
    suit.position.set(0.5, 0, -1.38);
    R.add(suit);
    this.add(suit, new BoxGeometry(0.46, 0.6, 0.26), M.suit, 0, 1.75, 0);
    this.add(suit, new BoxGeometry(0.4, 0.5, 0.24), M.suit, 0, 1.2, 0);
    this.add(suit, new BoxGeometry(0.06, 0.4, 0.2), m.accent, 0.2, 1.75, 0.02);
    for (const sx of [-1, 1]) {
      this.add(suit, new BoxGeometry(0.13, 0.62, 0.14), M.suit, sx * 0.31, 1.65, 0.02).rotation.z = sx * 0.08;
      this.add(suit, new BoxGeometry(0.15, 0.62, 0.15), M.suit, sx * 0.11, 0.65 + DECK * 0.2, 0.02);
    }
    this.add(suit, new BoxGeometry(0.34, 0.3, 0.3), M.suit, 0, 2.22, 0.02);
    this.add(suit, new BoxGeometry(0.26, 0.15, 0.04), m.glass, 0, 2.24, 0.17);
    this.rect(0.0, -1.65, 1.9, -1.2);
    // a bench, a helmet left on it
    this.box(-1.55, DECK + 0.4, -1.58, -0.15, DECK + 0.47, -1.15, M.trim);
    for (const x of [-1.45, -0.25]) this.box(x - 0.04, DECK, -1.5, x + 0.04, DECK + 0.4, -1.2, m.metal);
    this.add(R, new SphereGeometry(0.17, 6, 4), M.suit, -0.6, DECK + 0.62, -1.38);
    this.add(R, new BoxGeometry(0.2, 0.1, 0.05), m.glass, -0.6, DECK + 0.63, -1.22);
    this.rect(-1.6, -1.65, -0.1, -1.1);
    // a laser burn on the wall inside, by the rack
    for (const [x, y, s] of [
      [-0.3, 1.9, 1],
      [2.1, 1.4, 0.7],
    ]) {
      this.box(x - 0.14 * s, y - 0.1 * s, -1.6, x + 0.14 * s, y + 0.1 * s, -1.592, m.charred, R, false);
      this.box(x - 0.05 * s, y - 0.05 * s, -1.592, x + 0.05 * s, y + 0.05 * s, -1.586, m.hole, R, false);
      this.box(x - 0.04 * s, y + 0.08 * s, -1.6, x + 0.06 * s, y + 0.3 * s, -1.594, m.soot, R, false);
    }
    // smears on the deck, from deep in the room out through the door
    const M2 = M.blood;
    const path: [number, number][] = [
      [-1.2, -0.6],
      [-0.6, -0.2],
      [0.0, 0.25],
      [0.5, 0.75],
      [0.85, 1.2],
      [0.95, 1.7],
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      for (const off of [-0.08, 0.09]) {
        this.mark((ax + bx) / 2 + off, (az + bz) / 2 - off * 0.5, 0.05 + (i % 2) * 0.03, len * 0.95, Math.atan2(bx - ax, bz - az), M2, 0.004 + i * 0.0003);
      }
    }
    this.mark(-1.3, -0.65, 0.32, 0.25, 0.4, M2);
  }

  /** The work bay: desk and screens, the wall display, the rack, a sparking cable. */
  private buildWorkBay() {
    const M = this.mats;
    const m = this.m;
    const R = this.root;
    // the long desk along the back wall
    this.box(2.45, 1.48, -1.62, 5.15, 1.55, -1.0, M.trim);
    this.box(4.5, DECK, -1.6, 5.1, 1.48, -1.05, m.metal);
    this.box(2.5, DECK, -1.55, 2.58, 1.48, -1.1, m.metal);
    this.box(4.52, DECK + 0.2, -1.04, 5.08, DECK + 0.25, -1.02, m.accent, R, false);
    this.rect(2.4, -1.65, 5.2, -0.95);
    // three screens, the middle one cracked and flickering
    this.screen(3.0, 1.85, -1.42, 0.5, 0.34, 0.15, 0x58d8c8, 'steady');
    this.screen(3.72, 1.86, -1.47, 0.55, 0.36, 0, 0x8ab0c0, 'cracked');
    this.screen(4.45, 1.85, -1.42, 0.5, 0.34, -0.15, 0xe8a848, 'steady');
    // the crack across it
    for (const [x, y, r] of [
      [3.66, 1.9, 0.6],
      [3.8, 1.82, -0.4],
    ]) this.box(x - 0.14, y - 0.006, -1.43, x + 0.14, y + 0.006, -1.42, M.dead, R, false).rotation.z = r;
    // a keyboard, a mug, papers
    this.box(3.45, 1.55, -1.3, 3.95, 1.57, -1.12, m.metal);
    this.add(R, new CylinderGeometry(0.05, 0.05, 0.1, 6), m.accent, 2.75, 1.6, -1.2);
    for (let k = 0; k < 4; k++) this.box(4.0 + k * 0.12, 1.55, -1.35 + (k % 2) * 0.1, 4.25 + k * 0.12, 1.556 + k * 0.002, -1.1 + (k % 2) * 0.1, M.paper, R, false).rotation.y = k * 0.3;
    // the wall display over it: a scan of one of the creature's own kind
    this.box(2.85, 2.08, -1.62, 4.65, 2.56, -1.57, m.metal, R, false);
    this.box(2.9, 2.12, -1.57, 4.6, 2.52, -1.565, M.display, R, false);
    const scan = (x0: number, y0: number, x1: number, y1: number) => this.box(x0, y0, -1.565, x1, y1, -1.56, M.scan, R, false);
    // body, head, ears, legs, tail, as a wireframe outline would show them
    scan(3.25, 2.27, 3.75, 2.33);
    scan(3.25, 2.36, 3.75, 2.37);
    scan(3.75, 2.3, 3.9, 2.44);
    scan(3.78, 2.44, 3.81, 2.49);
    scan(3.86, 2.44, 3.89, 2.49);
    for (const x of [3.3, 3.45, 3.6, 3.7]) scan(x, 2.17, x + 0.025, 2.27);
    scan(3.15, 2.32, 3.25, 2.34);
    // readings beside it
    for (let k = 0; k < 5; k++) scan(4.05, 2.42 - k * 0.055, 4.05 + 0.12 + ((k * 37) % 5) * 0.06, 2.43 - k * 0.055);
    this.glow(0x6ad0e0, 0.6, 3.75, 2.32, -1.3, 0.3);
    // the chair, spun away from the desk and rolled out
    const chair = new Group();
    chair.position.set(3.3, DECK, -0.35);
    chair.rotation.y = 2.4;
    R.add(chair);
    this.add(chair, new BoxGeometry(0.42, 0.07, 0.42), M.trim, 0, 0.5, 0);
    this.add(chair, new BoxGeometry(0.42, 0.5, 0.06), M.trim, 0, 0.8, -0.2);
    this.add(chair, new CylinderGeometry(0.03, 0.03, 0.42, 4), m.metal, 0, 0.26, 0);
    for (let k = 0; k < 5; k++) {
      const leg = this.add(chair, new BoxGeometry(0.03, 0.03, 0.26), m.metal, 0, 0.04, 0);
      leg.geometry.translate(0, 0, 0.13);
      leg.rotation.y = (k / 5) * Math.PI * 2;
    }
    this.round(3.3, -0.35, 0.27);
    // papers blown across the deck
    for (let k = 0; k < 9; k++) {
      const a = k * 2.39;
      this.mark(3.4 + Math.cos(a) * (0.4 + (k % 3) * 0.35), 0.2 + Math.sin(a) * 0.5, 0.2, 0.28, a * 1.7, M.paper, 0.004 + k * 0.0005);
    }
    // the rack in the corner, humming, its lights blinking
    this.box(4.75, DECK, 0.75, 5.32, 2.5, 1.5, m.metal);
    this.box(4.73, DECK + 0.1, 0.8, 4.75, 2.4, 1.45, M.grate, R, false);
    const ledMat = (c: number) => toonMaterial({ dark: c, mid: c, light: c, unlit: true, outline: 0 });
    for (let row = 0; row < 6; row++) {
      for (let k = 0; k < 3; k++) {
        const color = k === 2 && row % 3 === 0 ? 0xff5a3a : 0x6aff8a;
        const mat = ledMat(color);
        this.box(4.715, 1.2 + row * 0.18, 0.88 + k * 0.08, 4.73, 1.23 + row * 0.18, 0.92 + k * 0.08, mat, R, false);
        this.leds.push({ mat, phase: Math.random() * 10, rate: 0.6 + Math.random() * 3, color: rgb(color).toArray() });
      }
    }
    this.glow(0x6aff8a, 0.4, 4.6, 1.6, 1.1, 0.2);
    this.rect(4.7, 0.7, 5.35, 1.55);
    // a cable torn from the wall, hanging and sparking
    for (let k = 0; k < 4; k++) {
      const seg = this.box(5.12, 2.3 - k * 0.22, -1.52 + k * 0.05, 5.15, 2.52 - k * 0.22, -1.49 + k * 0.05, m.metal, R, false);
      seg.rotation.x = 0.25 * k;
    }
    this.root.localToWorld(this.cableAt.set(5.13, 1.65, -1.32));
  }

  /** The lab: the specimen tank, the smashed one, a bench, a cold cabinet, a console. */
  private buildLab() {
    const M = this.mats;
    const m = this.m;
    const R = this.root;
    // the deck, the far wall seen from inside, the near sill, their cut tops
    this.add(R, new CylinderGeometry(LAB_R + 0.05, LAB_R + 0.05, 0.12, 16), M.deck, LAB_X, DECK - 0.06, LAB_Z);
    for (let k = 0; k < 4; k++) this.box(LAB_X - 0.01, DECK, LAB_Z - LAB_R, LAB_X + 0.01, DECK + 0.005, LAB_Z + LAB_R, M.grate, R, false).rotation.y = (k / 4) * Math.PI;
    const far = (3 * Math.PI) / 4;
    const near = -Math.PI / 4;
    const arc = (r: number, h: number, y: number, start: number, len: number, seg: number, mat: Material) =>
      this.add(R, inward(new CylinderGeometry(r, r, h, seg, 1, true, start, len)), mat, LAB_X, y, LAB_Z);
    // the far wall, broken by the way through from the tube (toward -x)
    const gap = (3 * Math.PI) / 2;
    arc(LAB_R, 1.75, DECK + 0.875, far, gap - 0.42 - far, 8, M.lining);
    arc(LAB_R, 1.75, DECK + 0.875, gap + 0.42, far + Math.PI - gap - 0.42, 4, M.lining);
    arc(LAB_R, 0.45, DECK + 0.225, near, Math.PI, 8, M.lining);
    const ring = (r0: number, r1: number, y: number, start: number, len: number) => {
      const g = new RingGeometry(r0, r1, 8, 1, start - Math.PI / 2, len).rotateX(-Math.PI / 2);
      return this.add(R, g, M.cut, LAB_X, y, LAB_Z);
    };
    ring(LAB_R, 2.66, 2.62, far, Math.PI);
    ring(LAB_R, 2.66, 1.32, near, Math.PI);
    // its wall: a ring of panels, open toward the tube
    for (let k = 0; k < 16; k++) {
      const a0 = (k / 16) * Math.PI * 2;
      const a1 = ((k + 1) / 16) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      if (Math.abs(mid - gap) < 0.42) continue;
      const pts: [number, number][] = [];
      for (const [a, r] of [
        [a0, LAB_R - 0.05],
        [a1, LAB_R - 0.05],
        [a1, LAB_R + 0.3],
        [a0, LAB_R + 0.3],
      ]) pts.push([LAB_X + Math.sin(a) * r, LAB_Z + Math.cos(a) * r]);
      this.block(pts);
    }
    // the specimen tank in the middle: a base, a lid, struts, a glowing column, and one of
    // the creature's own kind curled up in it
    const tx = LAB_X + 0.35;
    const tz = LAB_Z - 0.3;
    this.add(R, new CylinderGeometry(0.55, 0.62, 0.3, 8), m.metal, tx, DECK + 0.15, tz);
    this.add(R, new CylinderGeometry(0.5, 0.5, 0.06, 8), M.cold, tx, DECK + 0.32, tz);
    this.add(R, new CylinderGeometry(0.55, 0.5, 0.22, 8), m.metal, tx, DECK + 2.0, tz);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      this.box(tx + Math.cos(a) * 0.47 - 0.025, DECK + 0.3, tz + Math.sin(a) * 0.47 - 0.025, tx + Math.cos(a) * 0.47 + 0.025, DECK + 1.9, tz + Math.sin(a) * 0.47 + 0.025, m.metal);
    }
    this.add(R, new CylinderGeometry(0.46, 0.46, 0.04, 8, 1, true), m.glass, tx, DECK + 1.1, tz, false);
    const sp = new Group();
    sp.position.set(tx, DECK + 1.1, tz);
    R.add(sp);
    this.add(sp, new BoxGeometry(0.26, 0.22, 0.38), M.fur, 0, 0, 0).rotation.x = 0.5;
    this.add(sp, new BoxGeometry(0.2, 0.18, 0.18), M.fur, 0, 0.12, 0.2).rotation.x = 0.9;
    for (const sx of [-1, 1]) {
      this.add(sp, new BoxGeometry(0.04, 0.1, 0.06), M.fur, sx * 0.07, 0.24, 0.16);
      this.add(sp, new BoxGeometry(0.06, 0.18, 0.06), M.fur, sx * 0.1, -0.1, 0.14).rotation.x = -1.1;
      this.add(sp, new BoxGeometry(0.06, 0.18, 0.06), M.fur, sx * 0.1, -0.12, -0.12).rotation.x = 1.2;
    }
    this.add(sp, new BoxGeometry(0.04, 0.04, 0.3), M.fur, 0, -0.05, -0.28).rotation.x = -0.6;
    this.add(sp, new BoxGeometry(0.02, 0.4, 0.02), m.metal, 0, 0.35, 0);
    this.specimen = sp;
    this.keep.push(sp);
    this.root.localToWorld(this.tankAt.set(tx, DECK + 0.4, tz));
    this.glow(0x5ae8d8, 0.75, tx, DECK + 1.1, tz + 0.1, 0.5);
    this.round(tx, tz, 0.68);
    // the second tank, smashed: its frame bent, its fluid spilled across the deck
    const bx = LAB_X - 0.9;
    const bz = LAB_Z + 1.2;
    this.add(R, new CylinderGeometry(0.45, 0.52, 0.3, 8), m.metal, bx, DECK + 0.15, bz);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const s = this.box(bx + Math.cos(a) * 0.4 - 0.025, DECK + 0.3, bz + Math.sin(a) * 0.4 - 0.025, bx + Math.cos(a) * 0.4 + 0.025, DECK + 1.2 - k * 0.3, bz + Math.sin(a) * 0.4 + 0.025, m.metal);
      s.rotation.z = (k - 1) * 0.3;
    }
    this.add(R, new CylinderGeometry(1.0, 1.0, 0.008, 9), M.puddle, bx + 0.5, DECK + 0.004, bz + 0.2, false).scale.set(1.2, 1, 0.7);
    for (let k = 0; k < 10; k++) {
      const a = k * 2.3;
      const d = 0.5 + (k % 4) * 0.25;
      this.mark(bx + Math.cos(a) * d, bz + Math.sin(a) * d * 0.6, 0.14 + (k % 3) * 0.05, 0.08, a, m.glass, 0.012);
    }
    this.round(bx, bz, 0.55);
    // the bench along the far wall: microscope, racks of vials, jars
    const ba = Math.PI;
    const cx = LAB_X + Math.sin(ba) * 1.95;
    const cz = LAB_Z + Math.cos(ba) * 1.95;
    this.box(cx - 0.85, 1.45, cz - 0.3, cx + 0.85, 1.52, cz + 0.3, M.trim);
    this.box(cx - 0.8, DECK, cz - 0.25, cx - 0.2, 1.45, cz + 0.25, m.metal);
    this.box(cx + 0.7, DECK, cz - 0.2, cx + 0.78, 1.45, cz + 0.2, m.metal);
    this.box(cx - 0.6, 1.52, cz - 0.12, cx - 0.4, 1.56, cz + 0.12, m.metal);
    this.box(cx - 0.53, 1.56, cz - 0.04, cx - 0.47, 1.85, cz + 0.02, m.metal);
    this.box(cx - 0.58, 1.78, cz - 0.08, cx - 0.42, 1.86, cz + 0.12, M.lining);
    const vial = [0x5ae8d8, 0xe8a848, 0x8ad86a, 0xd86a6a];
    for (let k = 0; k < 8; k++) {
      const c = toonMaterial({ dark: vial[k % 4], mid: vial[k % 4], light: vial[k % 4], unlit: true, outline: 0.4 });
      this.add(R, new CylinderGeometry(0.025, 0.025, 0.14, 4), c, cx - 0.1 + (k % 4) * 0.07, 1.59 + 0.0, cz - 0.05 + Math.floor(k / 4) * 0.08, false);
    }
    this.box(cx - 0.15, 1.52, cz - 0.1, cx + 0.2, 1.56, cz + 0.1, m.metal);
    this.add(R, new CylinderGeometry(0.08, 0.08, 0.16, 6), M.cold, cx + 0.45, 1.6, cz);
    this.add(R, new CylinderGeometry(0.06, 0.06, 0.12, 6), M.lining, cx + 0.6, 1.58, cz - 0.1);
    this.rect(cx - 0.9, cz - 0.35, cx + 0.9, cz + 0.35);
    // a cold cabinet, its glass door lit from within
    const ka = (3 * Math.PI) / 4 + 0.15;
    const kx = LAB_X + Math.sin(ka) * 1.95;
    const kz = LAB_Z + Math.cos(ka) * 1.95;
    const cab = new Group();
    cab.position.set(kx, DECK, kz);
    cab.rotation.y = ka + Math.PI;
    R.add(cab);
    this.add(cab, new BoxGeometry(0.75, 1.8, 0.5), M.lining, 0, 0.9, 0);
    this.add(cab, new BoxGeometry(0.6, 1.5, 0.02), M.cold, 0, 0.95, 0.26, false);
    for (let k = 0; k < 4; k++) this.add(cab, new BoxGeometry(0.58, 0.02, 0.4), m.metal, 0, 0.35 + k * 0.38, 0.05, false);
    this.glow(0x9ad0e8, 0.4, kx + Math.sin(ka + Math.PI) * 0.4, DECK + 1.0, kz + Math.cos(ka + Math.PI) * 0.4, 0.2);
    this.turned(kx, kz, 0.8, 0.55, ka + Math.PI);
    // a console by the way in, its screen still on
    const ca = (3 * Math.PI) / 2 + 0.75;
    const ox = LAB_X + Math.sin(ca) * 1.9;
    const oz = LAB_Z + Math.cos(ca) * 1.9;
    const con = new Group();
    con.position.set(ox, DECK, oz);
    con.rotation.y = ca + Math.PI;
    R.add(con);
    this.add(con, new BoxGeometry(0.8, 1.0, 0.45), m.metal, 0, 0.5, 0);
    const sl = this.add(con, new BoxGeometry(0.8, 0.06, 0.5), M.trim, 0, 1.05, 0.05);
    sl.rotation.x = 0.35;
    this.root.updateMatrixWorld(true);
    con.updateMatrixWorld(true);
    const sc = con.localToWorld(new Vector3(0, 1.35, -0.1));
    this.root.worldToLocal(sc);
    this.screen(sc.x, sc.y, sc.z, 0.55, 0.32, ca + Math.PI, 0x7ae070, 'steady');
    this.turned(ox, oz, 0.85, 0.5, ca + Math.PI);
    // cables snaking over the deck from the tank to the bench and the console
    const cable = (pts: [number, number][]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i];
        const [qx, qz] = pts[i + 1];
        const len = Math.hypot(qx - ax, qz - az);
        const c = this.add(R, new BoxGeometry(0.05, 0.04, len), m.metal, (ax + qx) / 2, DECK + 0.02, (az + qz) / 2, false);
        c.rotation.y = Math.atan2(qx - ax, qz - az);
      }
    };
    cable([
      [tx - 0.5, tz - 0.2],
      [tx - 0.9, tz - 0.6],
      [cx + 0.1, cz + 0.35],
    ]);
    cable([
      [tx - 0.45, tz + 0.3],
      [ox + 0.5, oz - 0.1],
      [ox + 0.2, oz - 0.3],
    ]);
    // glass from the broken dome, where the sun comes in through it
    const sa = 1.8 * Math.PI;
    const sx = LAB_X - Math.cos(sa) * 1.3;
    const sz = LAB_Z + Math.sin(sa) * 1.3;
    for (let k = 0; k < 8; k++) this.mark(sx + Math.cos(k * 1.9) * 0.6, sz + Math.sin(k * 2.7) * 0.5, 0.18, 0.1, k, m.glass, 0.01);
    this.root.localToWorld(this.sunAt.set(sx, DECK + 1.2, sz));

    // the lamps
    for (const [x, y, z, s, f] of [
      [-3.8, 2.45, -0.4, 2.3, 0],
      [0.7, 2.45, 0.1, 1.9, 0],
      [3.7, 2.45, -0.7, 2.5, 1],
      [LAB_X - 0.5, 2.45, LAB_Z + 0.7, 1.7, 0],
      [tx, DECK + 1.1, tz, 1.3, 0],
    ] as const) {
      this.lamps.push({ pos: this.root.localToWorld(new Vector3(x, y, z)), base: s, flicker: f === 1 });
    }
  }

  // ----------------------------------------------------------------- inside

  /** The deck's height, everywhere inside. */
  readonly height = () => this.floorY;

  /** The creature has walked out into the doorway. */
  atDoor(p: Vector3) {
    const l = this.root.worldToLocal(this.tmp.copy(p));
    return l.x > DOOR_X0 - 0.1 && l.x < DOOR_X1 + 0.1 && l.z > DOOR_OUT;
  }

  /**
   * Light the rooms and run what goes on in them. `inside` is how far the
   * creature is in (0..1, eased); `near` is whether the station is close
   * enough to bother.
   */
  update(dt: number, time: number, inside: number, listener: Vector3) {
    shared.uRoomOn.value = inside;
    if (inside <= 0) {
      for (const g of this.glows) g.strength = 0;
      return;
    }
    shared.uRoomInv.value.copy(this.inv);
    // the work bay's lamp stutters; when it dies the cracked screen buzzes
    const n = noise1(time * 5, 17);
    this.flick = n > -0.25 ? 1 : Math.random() < 0.4 ? 0.85 : 0.15;
    this.lamps.forEach((l, i) => {
      const v = shared.uRoomLight.value[i];
      v.set(l.pos.x, l.pos.y, l.pos.z, l.base * (l.flicker ? this.flick : 1) * (i === 4 ? 0.85 + 0.15 * Math.sin(time * 1.3) : 1));
    });
    for (const g of this.glows) g.strength = 0.3 * inside;
    for (const s of this.screens) {
      let k = 1;
      if (s.kind === 'cracked') {
        const c = noise1(time * 9, 5);
        k = c > 0.2 ? 0.9 : c > -0.3 ? 0.35 + Math.random() * 0.3 : 0.05;
      } else k = 0.92 + 0.08 * Math.sin(time * 3 + s.on[0] * 10);
      (s.mat.uniforms.uLight.value as Vector3).set(s.on[0] * k, s.on[1] * k, s.on[2] * k);
      s.glow.strength = 0.3 * k * inside;
    }
    for (const d of this.leds) {
      const on = Math.sin(time * d.rate + d.phase) + noise1(time * d.rate * 2, d.phase) > 0.2;
      (d.mat.uniforms.uLight.value as Vector3).set(d.color[0] * (on ? 1 : 0.15), d.color[1] * (on ? 1 : 0.15), d.color[2] * (on ? 1 : 0.15));
    }
    // the emergency strip breathes red
    const e = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(time * 1.6), 3);
    (this.emergency.uniforms.uLight.value as Vector3).set(0.85 * e + 0.2, 0.08 * e, 0.06 * e);
    // the specimen turns slowly in the fluid
    this.specimen.rotation.y = time * 0.12;
    this.specimen.position.y = DECK + 1.1 + Math.sin(time * 0.7) * 0.05;

    if (inside < 0.5) return;
    // bubbles rise through the tank
    this.bubbleTimer -= dt;
    if (this.bubbleTimer <= 0) {
      this.bubbleTimer = 0.08 + Math.random() * 0.2;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.32;
      this.dust.spawn(this.tankAt.x + Math.cos(a) * r, this.tankAt.y, this.tankAt.z + Math.sin(a) * r, 0, 0.5 + Math.random() * 0.4, 0, 2.6, BUBBLE, 1, { g: -0.1, drag: 0.2, windK: 0, c2: BUBBLE_FADE });
      if (Math.random() < 0.12) this.audio.roomBubble(0.05 + Math.random() * 0.04);
    }
    // dust drifting in the sunlight under the broken dome
    this.moteTimer -= dt;
    if (this.moteTimer <= 0) {
      this.moteTimer = 0.25 + Math.random() * 0.4;
      this.dust.spawn(
        this.sunAt.x + (Math.random() - 0.5) * 1.2,
        this.sunAt.y + (Math.random() - 0.5) * 1.2,
        this.sunAt.z + (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 0.06,
        (Math.random() - 0.5) * 0.04,
        (Math.random() - 0.5) * 0.06,
        4 + Math.random() * 3,
        MOTE,
        1,
        { g: 0.005, drag: 0.1, windK: 0, soft: true },
      );
    }
    // the torn cable sparks
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 2 + Math.random() * 6;
      for (let i = 0; i < 8; i++) {
        this.dust.spawn(this.cableAt.x, this.cableAt.y, this.cableAt.z, (Math.random() - 0.5) * 1.6, Math.random() * 1.2, (Math.random() - 0.5) * 1.6, 0.3 + Math.random() * 0.3, SPARK_HOT, 1, {
          g: 9,
          drag: 1,
          windK: 0,
          c2: SPARK_COOL,
        });
      }
      const d = this.tmp.copy(this.cableAt).distanceTo(listener);
      this.audio.roomZap(0.12 / (1 + d * 0.3));
    }
    // the cracked screen crackles when it stutters
    this.crackleTimer -= dt;
    if (this.crackleTimer <= 0 || this.flick < 0.5) {
      this.crackleTimer = 1 + Math.random() * 3;
      if (Math.random() < 0.5) this.audio.roomCrackle(0.04);
    }
  }
}
