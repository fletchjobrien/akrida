import {
  BoxGeometry,
  BufferGeometry,
  Color,
  SphereGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  Object3D,
  TorusGeometry,
  Vector3,
  type Material,
  type ShaderMaterial,
} from 'three';
import { clamp, noise1 } from '../core/math';
import { shared, toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { ditherMaterial } from '../render/dither';
import { Creature, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import type { FootPose, HandPose, ScriptPose } from '../character/scriptPose';
import { PIPE_TONES, TONE_COLORS, TONES, WALL_SONG } from '../story/tune';
import { convexHull, footprintOf, type RockInfo } from './rocks';
import type { Dust } from './particles';
import type { AudioEngine } from '../audio/AudioEngine';

/** The hall's floor, in the facility's frame. */
const F = 0.18;
/** The inside faces of the hall's outer walls. */
const X0 = -16.9;
const X1 = 16.9;
const Z0 = -6.9;
const Z1 = 6.9;
/** Half the width of the way in through the front wall. */
const DOOR = 2.4;
/** How high the walls between the rooms stand before the cutaway takes them. */
const WALL = 2.8;
/** The vault: where the survivor hides, a closed room with a roof of its own. */
const VAULT = { x0: 10.4, x1: X1, z0: Z0, z1: -0.6, h: 3.0, door0: 13.0, door1: 14.4 };
/** Where the pipes come down the vault's front wall, and how they are spaced. */
const PIPE_X = 10.95;
const PIPE_STEP = 0.36;
/** The hole in the roof: its middle, and its half size (in the facility's frame). */
const BREACH = { x: 5.5, z: 1.0, hx: 1.7, hz: 1.25 };

const C = (hex: number) => rgb(hex).toArray();
const SAND = C(0xe4c987);
const SAND_FADE = C(0xbca872);
const MOTE = C(0xfff0c8);
const MOTE_FADE = C(0xc8b48a);
const SPARK_HOT = C(0xfff4c8);
const SPARK_COOL = C(0xd9824a);

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/** A colour made darker or lighter by `k`. */
const shade = (hex: number, k: number) => new Color(hex).multiplyScalar(k).getHex();

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({ x, z, lift, tilt, pitch, poleDown });

// The dead, each its own colour; to the Akridians colour is as much who they are as voice.
const TEAL: Skin = { fur: [0x22423e, 0x386660, 0x4e8a82], belly: [0x6a9a92, 0x8cbab2, 0xa6ccc4], hoof: [0x16282a, 0x22423e], eye: 0x8c949a };
const OCHRE: Skin = { fur: [0x5a4418, 0x86682a, 0xa8863c], belly: [0xb09a6a, 0xcab88a, 0xdaca9e], hoof: [0x3a2c10, 0x5a4418], eye: 0x8c949a };
const VIOLET: Skin = { fur: [0x3a2a4e, 0x5a4476, 0x745c94], belly: [0x9282aa, 0xb0a2c4, 0xc4b8d4], hoof: [0x241a32, 0x3a2a4e], eye: 0x8c949a };
const BLUE: Skin = { fur: [0x2f4258, 0x4b6684, 0x62809e], belly: [0x7891aa, 0x9ab2c8, 0xb2c6d8], hoof: [0x1e2836, 0x2f4258], eye: 0x8c949a };
const GREEN: Skin = { fur: [0x3c4a33, 0x5a6e4a, 0x748a60], belly: [0x7c8e68, 0xa0b48a, 0xb8c8a0], hoof: [0x232c1e, 0x3c4a33], eye: 0x8c949a };

const STILL = { tremble: 0, exertion: 0, eyeOpen: 0.3 };

/** Sat where it was hit, its back to the barricade, slid down, head fallen to one side. */
const SITTING: ScriptPose = {
  ...STILL,
  pelvisX: 0,
  pelvisY: 0.2,
  pelvisZ: 0,
  pelvisPitch: -0.75,
  pelvisYaw: 0.1,
  pelvisRoll: 0,
  spinePitch: 0.3,
  chestPitch: 0.2,
  chestRoll: 0.12,
  neckPitch: 0.55,
  headPitch: 0.5,
  headYaw: 0.5,
  headRoll: 0.55,
  handL: hand(0.3, 0.03, 0.2),
  handR: hand(-0.16, 0.18, 0.18),
  armPitch: 0,
  elbow: -0.4,
  armOut: 0.15,
  footL: foot(0.24, 0.62, 0, 0.3, 0, -1),
  footR: foot(-0.12, 0.45, 0.06, 0.4, 0.4, -0.3),
};

/** Thrown onto its back, arms flung wide, head rolled aside. */
const ON_BACK: ScriptPose = {
  ...STILL,
  eyeOpen: 0.5,
  pelvisX: 0,
  pelvisY: 0.13,
  pelvisZ: 0,
  pelvisPitch: -1.42,
  pelvisYaw: -0.2,
  pelvisRoll: 0,
  spinePitch: 0.04,
  chestPitch: 0.04,
  chestRoll: -0.05,
  neckPitch: -0.1,
  headPitch: -0.1,
  headYaw: -1.1,
  headRoll: 0.1,
  handL: hand(0.62, 0.03, 0.12),
  handR: hand(-0.55, 0.03, 0.32),
  armPitch: 0,
  elbow: -0.2,
  armOut: 0.6,
  footL: foot(0.3, 0.66, 0, 0.3, 0, -1),
  footR: foot(-0.22, 0.6, 0.02, 0.25, 0.3, -0.6),
};

/** Face down, one arm stretched out ahead where it was still dragging itself on. */
const CRAWLING: ScriptPose = {
  ...STILL,
  eyeOpen: 0.4,
  pelvisX: 0,
  pelvisY: 0.13,
  pelvisZ: 0,
  pelvisPitch: 1.46,
  pelvisYaw: 0.1,
  pelvisRoll: 0,
  spinePitch: 0.05,
  chestPitch: 0.05,
  chestRoll: -0.08,
  neckPitch: -0.2,
  headPitch: -0.2,
  headYaw: 0.9,
  headRoll: 0,
  handL: hand(0.2, 0.02, 0.72),
  handR: hand(-0.32, 0.02, 0.12),
  armPitch: 0,
  elbow: -0.2,
  armOut: 0.1,
  footL: foot(0.18, -0.64, 0, -1.4, -1.5, 1),
  footR: foot(-0.14, -0.5, 0.02, -1.2, -1.3, 1),
};

/** Fallen forward over the crate it was firing from, arms hanging down its far side. */
const DRAPED: ScriptPose = {
  ...STILL,
  eyeOpen: 0.2,
  pelvisX: 0,
  pelvisY: 0.72,
  pelvisZ: -0.1,
  pelvisPitch: 1.25,
  pelvisYaw: 0,
  pelvisRoll: 0.08,
  spinePitch: 0.3,
  chestPitch: 0.25,
  chestRoll: 0,
  neckPitch: 0.5,
  headPitch: 0.4,
  headYaw: 0.4,
  headRoll: 0.2,
  handL: hand(0.22, 0.25, 0.55),
  handR: hand(-0.2, 0.15, 0.5),
  armPitch: -0.6,
  elbow: -0.1,
  armOut: 0.15,
  footL: foot(0.15, -0.45, 0, 0.5, 0.2, 0.4),
  footR: foot(-0.15, -0.35, 0, 0.6, 0.3, 0.5),
};

/** Slid down beside the door it beat on, one hand still raised against it. */
const AT_DOOR: ScriptPose = {
  ...SITTING,
  pelvisYaw: -0.3,
  headYaw: -0.7,
  headRoll: -0.5,
  handL: hand(0.32, 0.03, 0.28),
  handR: hand(-0.32, 0.62, -0.06),
};

/** One camera in the facility: where it hangs and what it looks at (the facility's frame). */
export interface Feed {
  at: Vector3;
  look: Vector3;
  fov: number;
}

/**
 * Inside the buried facility in the east: a great hall under a broken roof,
 * where humans came in through the front door and killed the Akridians who
 * held it.
 *
 * - The hall: tall plated walls ribbed in orange, the far wall painted with a
 *   long band of coloured tones (the Akridians' way of writing a song), its
 *   high windows packed with sand. In the middle stands the cradle: a gantry
 *   over a round dais, robot arms frozen at work, and hanging in it on cables
 *   the frame of an Akridian not yet built, its heart still glowing a cold
 *   blue. Part of the roof has fallen in; sunlight comes down through the hole
 *   in a slanting shaft full of drifting motes, and sand pours down into a
 *   heap on the floor.
 * - The fight: a barricade of overturned tables and crates thrown up across
 *   the hall in front of the cradle, scorched and holed. Five Akridians lie
 *   dead behind it and around it, each its own colour; one dragged itself
 *   toward the plant room before it died. A human in black armour lies where
 *   their fire caught him. Spent casings are strewn by the door, and a
 *   grenade has blackened the floor.
 * - West: the security office behind a window, its desk under a bank of
 *   monitors still showing the cameras' feeds; the plant room behind it, with
 *   tanks and pumps where a run of six coloured pipes begins.
 * - East: the lab, its capsules empty and one smashed, shelves of half-made
 *   heads; and the vault, a closed room with a heavy door that opens only from
 *   inside. The six pipes run the length of the hall's far wall, over the
 *   vault's roof and down its front, and into it. One more Akridian died
 *   against its door. Inside, one is still alive.
 *
 * Local frame: the facility's own (see world/facility.ts): +z out of its
 * front, the door at z 7. Lamps light it (see `roomLight`, kind 1).
 */
export class FacilityInterior {
  /** Everything inside, in the facility's frame (it shares the facility's place in the world). */
  readonly root = new Group();
  /** The dead, in the world. */
  readonly bodies = new Group();
  /** Shadows only: the roof (with its hole) and the outer walls, which keep the hall dark. */
  readonly casters = new Group();
  readonly keep: Object3D[] = [];
  readonly colliders: RockInfo[] = [];
  readonly glows: Glow[] = [];
  floorY = 0;
  /** Just inside the door, and the way into the hall from it (world space). */
  readonly spawn = new Vector3();
  readonly inward = new Vector3();
  readonly height = () => this.floorY;
  /** An unseen box over the doorway from inside, for the mouse. */
  readonly doorProxy = new Mesh(new BoxGeometry(4.6, 3, 0.8));
  /** The bank of monitors in the security office. */
  readonly monitors = { proxy: new Mesh(new BoxGeometry(3.6, 1.2, 0.8)), stand: new Vector3(), look: new Vector3() };
  /** The six pipes down the vault's front: the point to knock on, the tone, the mouse's box. */
  readonly pipes: { at: Vector3; inner: Vector3; tone: number; f: number; size: number; proxy: Mesh; color: number }[] = [];
  /** Where to stand to knock on them, and where to look. */
  readonly pipeStand = new Vector3();
  readonly pipeLook = new Vector3();
  /** The vault's door: shut and locked until it is opened from inside. */
  readonly vault = {
    proxy: new Mesh(new BoxGeometry(1.6, 2.4, 0.6)),
    stand: new Vector3(),
    look: new Vector3(),
    /** Inside it, just behind the door, and out in front of it (world space). */
    inside: new Vector3(),
    outside: new Vector3(),
    state: 'locked' as 'locked' | 'unlocking' | 'opening' | 'open',
    t: 0,
    door: new Group(),
    lock: null as unknown as ShaderMaterial,
    lockGlow: null as unknown as Glow,
    /** Its lock tried from outside: the light flashes red for a while. */
    refused: 0,
  };
  /** Where the survivor crouches, and the way it faces (world space, yaw). */
  readonly hide = new Vector3();
  hideYaw = 0;
  /** The cameras whose feeds the monitors show, in order (world space). */
  readonly feeds: Feed[] = [];

  private readonly M: Record<string, Material>;
  private readonly world: World;
  private readonly lamps: { pos: Vector3; base: number; flicker: number; warm?: boolean }[] = [];
  private readonly screens: { mat: ShaderMaterial; feed: number; seed: number }[] = [];
  private readonly coreMat: ShaderMaterial;
  private readonly stripMat: ShaderMaterial;
  private readonly coreGlow: Glow;
  private readonly coreAt = new Vector3();
  /** The middle of the song painted on the far wall (world space). */
  readonly muralAt = new Vector3();
  private dayGlow: Glow | null = null;
  /** Pools of light on the floor, and how bright each is. */
  private readonly pools: { g: Glow; k: number }[] = [];
  private readonly breachAt = new Vector3();
  private readonly sandAt = new Vector3();
  private readonly officeAt = new Vector3();
  private readonly sparkAt = new Vector3();
  /** The sun's shaft: where it comes in under the hole, and where it falls on the floor (world). */
  private readonly shaftTop = new Vector3();
  private readonly shaftFoot = new Vector3();
  private readonly inv = new Matrix4();
  private readonly tmp = new Vector3();
  private sandTimer = 0;
  private moteTimer = 0;
  private sparkTimer = 2;
  private groanTimer = 6;
  private dripTimer = 2;
  private flick = 1;
  /** The feed on the monitors now (brighter than the rest), or -1. */
  feedOn = -1;

  constructor(
    facilityGroup: Group,
    private readonly audio: AudioEngine,
    private readonly dust: Dust,
  ) {
    this.root.position.copy(facilityGroup.position);
    this.root.quaternion.copy(facilityGroup.quaternion);
    this.root.updateMatrixWorld(true);
    this.root.add(this.casters);
    const t = (dark: number, mid: number, light: number, outline = 0.6, highlight = 0.6) => toonMaterial({ dark, mid, light, litAt: 0.55, outline, highlight });
    const u = (c: number) => toonMaterial({ dark: c, mid: c, light: c, unlit: true, outline: 0 });
    this.M = {
      deck: t(0x29292f, 0x3f3f47, 0x8a8274),
      deck2: t(0x25252a, 0x393940, 0x7c7468),
      grate: t(0x16161a, 0x24242a, 0x383842, 0.5, 0.3),
      lining: t(0x55514b, 0x847e72, 0xb0aa9b),
      liningDark: t(0x45413c, 0x6a655c, 0x8e887c),
      hull: t(0x6f6a62, 0xa8a294, 0xdcd6c8, 0.6, 1),
      panel: t(0x625d56, 0x958f83, 0xc9c3b5, 0.6, 1),
      accent: t(0x7a3a24, 0xb85a34, 0xd9824a, 0.6, 0.8),
      metal: t(0x2e2a2a, 0x4a4542, 0x6e6862, 0.6, 0.8),
      dark: t(0x1c1a1a, 0x2a2626, 0x3e3836),
      trim: t(0x3a3836, 0x56524e, 0x76706a),
      cut: t(0x1a1716, 0x221e1d, 0x2e2927, 0.8, 0),
      hazard: t(0x1a1816, 0x24201e, 0x34302c, 0.4, 0.4),
      yellow: t(0x6a5410, 0xa8861c, 0xd8b030, 0.5, 0.4),
      charred: t(0x141010, 0x221a18, 0x2e2420, 0, 0),
      soot: t(0x1c1817, 0x2e2826, 0x433a36, 0.3, 0.3),
      blood: t(0x1e2630, 0x28323e, 0x34414f, 0, 0),
      redBlood: t(0x2a0606, 0x420a0a, 0x5a1010, 0, 0.3),
      sand: toonMaterial({ dark: 0xbca872, mid: 0xd7bf86, light: 0xe8d39a, litAt: 0.5, outline: 0, highlight: 0 }),
      paper: t(0x8a867c, 0xc4beb0, 0xe6e0d2, 0.4, 0.2),
      brass: t(0x5a4418, 0x8a6a2a, 0xc09a48, 0.3, 1),
      black: t(0x15171a, 0x24272c, 0x3c4148, 0.8, 0.7),
      blacker: t(0x0e0f11, 0x1a1c1f, 0x2e3136, 0.8, 0.8),
      visor: t(0x050608, 0x0c0e12, 0x2a3240, 0.6, 1),
      cloth: t(0x2a2e3a, 0x3c4252, 0x56607a),
      wood: t(0x3e2c20, 0x5a4230, 0x765a42),
      fur: t(0x4c2a24, 0x7a4a40, 0x8e5e52),
      ember: u(0x7a2a0e),
      redLine: u(0x6a0a08),
      dead: u(0x0c1014),
      sandGlass: t(0x8a7a50, 0xb09a68, 0xc8b480, 0.4, 0.2),
    };
    this.world = { height: () => this.floorY, rocks: [] };
    this.coreMat = u(0x5ad8ff);
    this.stripMat = u(0xd8c49a);
    this.coreGlow = new Glow(rgb(0x5ad8ff), 0.9, { core: 0.6 });
    this.coreGlow.strength = 0;
    this.glows.push(this.coreGlow);
    this.vault.lock = u(0xff3a2a);
    this.vault.lockGlow = new Glow(rgb(0xff3a2a), 0.35, { core: 0.7 });
    this.vault.lockGlow.strength = 0;
    this.glows.push(this.vault.lockGlow);
  }

  // ------------------------------------------------------------------ helpers

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

  /** A box w by h by d centred at (x, y, z). */
  private cube(w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, parent: Object3D = this.root, shadow = true) {
    return this.add(parent, new BoxGeometry(w, h, d), mat, x, y, z, shadow);
  }

  /** A flat mark lying on the floor. */
  private mark(x: number, z: number, w: number, d: number, spin: number, mat: Material, lift = 0.004) {
    const k = this.add(this.root, new BoxGeometry(w, 0.006, d), mat, x, F + lift, z, false);
    k.rotation.y = spin;
    return k;
  }

  /** A round pool on the floor. */
  private pool(x: number, z: number, r: number, mat: Material, k: number, sx = 1.3, sz = 0.85) {
    const p = this.add(this.root, new CylinderGeometry(r, r * 1.08, 0.008, 8), mat, x, F + 0.005 + k * 0.0012, z, false);
    p.scale.set(sx, 1, sz);
    p.rotation.y = k * 1.7 + x;
    return p;
  }

  /** Something in the way, its outline given in the facility's frame. */
  private block(pts: [number, number][], height = 2) {
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
    this.colliders.push({ x: cx, z: cz, radius, height, hull });
  }

  private rect(x0: number, z0: number, x1: number, z1: number) {
    this.block([
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ]);
  }

  private round(x: number, z: number, r: number) {
    const pts: [number, number][] = [];
    for (let k = 0; k < 8; k++) pts.push([x + Math.cos((k / 8) * Math.PI * 2) * r, z + Math.sin((k / 8) * Math.PI * 2) * r]);
    this.block(pts);
  }

  /** A wall between rooms, cut off at `h` with a dark cap where the cutaway takes it, and a collider. */
  private wall(x0: number, z0: number, x1: number, z1: number, h = WALL, mat = this.M.lining, solid = true) {
    this.box(x0, F, z0, x1, F + h, z1, mat);
    this.box(x0 - 0.01, F + h, z0 - 0.01, x1 + 0.01, F + h + 0.03, z1 + 0.01, this.M.cut, this.root, false);
    // a kick strip along its foot
    this.box(x0 - 0.012, F, z0 - 0.012, x1 + 0.012, F + 0.16, z1 + 0.012, this.M.trim, this.root, false);
    if (solid) this.rect(x0, z0, x1, z1);
  }

  private glow(color: number, size: number, x: number, y: number, z: number, core = 0.5) {
    const g = new Glow(rgb(color), size, { core });
    this.root.localToWorld(g.position.set(x, y, z));
    g.strength = 0;
    this.glows.push(g);
    return g;
  }

  private lamp(x: number, y: number, z: number, base: number, flicker = 0, warm = false) {
    this.lamps.push({ pos: this.root.localToWorld(new Vector3(x, y, z)), base, flicker, warm });
  }

  /** A point of the facility's frame in the world. */
  private w(x: number, y: number, z: number, out = new Vector3()) {
    return this.root.localToWorld(out.set(x, y, z));
  }

  /** The heart of the frame hanging in the cradle (world space): what the eye goes to first. */
  get heart() {
    return this.coreAt;
  }

  /** Inside the hall (a point in the world). */
  contains(p: Vector3) {
    const l = this.root.worldToLocal(this.tmp.copy(p));
    return (Math.abs(l.x) < X1 && l.z > Z0 && l.z < Z1) || (Math.abs(l.x) < DOOR && l.z < 7.8 && l.z > 0);
  }

  /** In the doorway, on the way out. */
  atDoor(p: Vector3) {
    const l = this.root.worldToLocal(this.tmp.copy(p));
    return Math.abs(l.x) < DOOR - 0.3 && l.z > Z1 - 0.15;
  }

  // ------------------------------------------------------------------ build

  *build(): Generator<unknown, void, unknown> {
    this.root.updateMatrixWorld(true);
    this.floorY = this.w(0, F, 0).y;
    this.buildShell();
    yield;
    this.buildCasters();
    this.buildBackWall();
    yield;
    this.buildCradle();
    yield;
    this.buildBreach();
    yield;
    this.buildFight();
    yield;
    yield* this.buildDead();
    this.buildOffice();
    yield;
    this.buildPlant();
    this.buildPipes();
    yield;
    this.buildVault();
    this.buildLab();
    yield;
    this.root.updateMatrixWorld(true);
    this.w(0, F, Z1 - 1.2, this.spawn);
    this.inward.set(0, 0, -1).transformDirection(this.root.matrixWorld);
    this.inv.copy(this.root.matrixWorld).invert();
    this.doorProxy.position.set(0, F + 1.5, Z1 - 0.2);
    this.doorProxy.visible = false;
    this.root.add(this.doorProxy);
    this.keep.push(this.doorProxy);
  }

  /** The floor, the outer walls seen from inside (cut down toward the front), the way in. */
  private buildShell() {
    const M = this.M;
    // the floor: big plates in two tones, a little apart, their seams dark
    this.box(X0 - 0.3, F - 0.3, Z0 - 0.3, X1 + 0.3, F - 0.004, Z1 + 0.3, M.grate);
    for (let x = X0; x < X1 - 0.1; x += 2.1) {
      for (let z = Z0; z < Z1 - 0.1; z += 2.1) {
        const k = (Math.round((x - X0) / 2.1) + Math.round((z - Z0) / 2.1)) % 2;
        this.box(x + 0.03, F - 0.02, z + 0.03, Math.min(X1, x + 2.07), F, Math.min(Z1, z + 2.07), k ? M.deck : M.deck2, this.root, false);
      }
    }
    // round the cradle: a ring set in the floor, orange, then black and yellow
    this.add(this.root, new TorusGeometry(3.0, 0.07, 3, 32).rotateX(Math.PI / 2), M.accent, 0, F + 0.002, -3.8, false).scale.y = 0.2;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      this.cube(0.4, 0.008, 0.12, k % 2 ? M.yellow : M.hazard, Math.cos(a) * 3.3, F + 0.004, -3.8 + Math.sin(a) * 3.3, this.root, false).rotation.y = -a + Math.PI / 2;
    }
    // the walkway in from the door, edged in yellow and black
    for (const sx of [-1, 1]) {
      for (let z = -1; z < Z1; z += 0.5) this.box(sx * 1.6 - 0.06, F, z, sx * 1.6 + 0.06, F + 0.006, z + 0.25, M.yellow, this.root, false);
    }
    for (const [x, z] of [
      [-6, 3.5],
      [6.5, -2.2],
      [-12, -1.4],
      [12.5, 2.2],
    ]) {
      this.add(this.root, new CylinderGeometry(0.28, 0.28, 0.008, 8), M.grate, x, F + 0.004, z, false);
    }
    // the far wall, full height (its face is dressed in buildBackWall)
    this.box(X0 - 0.3, F, Z0 - 0.4, X1 + 0.3, F + 7, Z0, M.liningDark);
    this.box(X0 - 0.3, F + 7, Z0 - 0.42, X1 + 0.3, F + 7.03, Z0 + 0.01, M.cut, this.root, false);
    this.box(X0, F, Z0 - 0.01, X1, F + 0.2, Z0 + 0.02, M.trim, this.root, false);
    this.rect(X0 - 0.4, Z0 - 0.6, X1 + 0.4, Z0);
    // the ends, cut off where the cutaway takes them
    for (const [x0, x1] of [
      [X0 - 0.35, X0],
      [X1, X1 + 0.35],
    ]) {
      this.wall(x0, Z0 - 0.4, x1, Z1 + 0.3, WALL, M.liningDark, false);
      this.rect(x0 - 0.3, Z0, x1 + 0.3, Z1);
    }
    // the front: a low sill, open in the middle for the way in; its outer face (against the
    // buried sand) dark like the cut
    for (const [x0, x1] of [
      [X0 - 0.35, -DOOR],
      [DOOR, X1 + 0.35],
    ]) {
      this.wall(x0, Z1, x1, Z1 + 0.3, 1.0, M.liningDark);
      this.box(x0, F - 0.3, Z1 + 0.3, x1, F + 1.03, Z1 + 0.32, M.cut, this.root, false);
    }
    // the doorway's frame: hazard-striped jambs, the threshold plate
    for (const sx of [-1, 1]) {
      this.box(sx * DOOR - 0.15, F, Z1 - 0.05, sx * DOOR + 0.15, F + 1.3, Z1 + 0.35, M.panel);
      for (let y = 0.2; y < 1.2; y += 0.3) this.box(sx * DOOR - 0.155, F + y, Z1 + 0.36, sx * DOOR + 0.155, F + y + 0.15, Z1 + 0.37, M.yellow, this.root, false);
    }
    this.box(-DOOR, F, Z1 - 0.2, DOOR, F + 0.03, Z1 + 0.5, M.metal, this.root, false);
    // daylight spills in through the forced door, across the floor
    const day = this.glow(0xffe8b8, 3.2, 0, F + 0.02, Z1 - 0.9, 0);
    day.material.uniforms.uFlat.value = 1;
    this.dayGlow = day;
  }

  /** A pool of a lamp's light on the floor under it. */
  private pool2(color: number, size: number, x: number, z: number, k = 0.22) {
    const g = this.glow(color, size, x, F + 0.02, z, 0);
    g.material.uniforms.uFlat.value = 1;
    this.pools.push({ g, k });
    return g;
  }

  /**
   * What keeps the hall dark but for the sun through its broken roof: the roof
   * with its hole, and the outer walls, drawn only into the sun's shadow.
   */
  private buildCasters() {
    const C = this.casters;
    const mat = this.M.dark;
    const slab = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
      const m = this.box(x0, y0, z0, x1, y1, z1, mat, C, true);
      m.layers.set(SHADOW_LAYER);
    };
    const y0 = F + 7.6;
    const y1 = F + 8.2;
    const b = BREACH;
    slab(X0 - 0.5, y0, Z0 - 0.5, b.x - b.hx, y1, Z1 + 0.5);
    slab(b.x + b.hx, y0, Z0 - 0.5, X1 + 0.5, y1, Z1 + 0.5);
    slab(b.x - b.hx, y0, Z0 - 0.5, b.x + b.hx, y1, b.z - b.hz);
    slab(b.x - b.hx, y0, b.z + b.hz, b.x + b.hx, y1, Z1 + 0.5);
    slab(X0 - 0.5, F, Z0 - 0.6, X1 + 0.5, y0, Z0 - 0.3);
    slab(X0 - 0.5, F + 1.0, Z1 + 0.35, X1 + 0.5, y0, Z1 + 0.6);
    slab(X0 - 0.6, F, Z0 - 0.5, X0 - 0.35, y0, Z1 + 0.5);
    slab(X1 + 0.35, F, Z0 - 0.5, X1 + 0.6, y0, Z1 + 0.5);
  }

  /** The far wall: ribs, the band of painted tones, windows choked with sand, a crane rail. */
  private buildBackWall() {
    const M = this.M;
    const z = Z0;
    // ribs standing out of it, capped in orange
    for (let x = -14.7; x <= 14.8; x += 4.2) {
      this.box(x - 0.22, F, z, x + 0.22, F + 7, z + 0.35, M.panel);
      this.box(x - 0.24, F + 6.6, z, x + 0.24, F + 7, z + 0.37, M.accent);
      this.box(x - 0.24, F, z, x + 0.24, F + 0.5, z + 0.37, M.metal);
    }
    // an orange stripe along it, and a seam
    this.box(X0, F + 1.6, z, X1, F + 1.75, z + 0.02, M.accent, this.root, false);
    this.box(X0, F + 3.9, z, X1, F + 3.93, z + 0.02, M.metal, this.root, false);
    // the high windows, packed solid with the sand that buried the hall
    for (let x = -12.6; x <= 12.7; x += 4.2) {
      this.box(x - 1.3, F + 5.2, z, x + 1.3, F + 6.3, z + 0.05, M.metal, this.root, false);
      this.box(x - 1.2, F + 5.28, z, x + 1.2, F + 6.22, z + 0.07, M.sandGlass, this.root, false);
      // a crack, and sand trickled from it down the wall
      if (Math.abs(x) > 6 && x < 10) {
        this.box(x - 0.6, F + 5.26, z, x - 0.55, F + 6.24, z + 0.08, M.dark, this.root, false);
        this.box(x - 0.7, F, z + 0.08, x - 0.45, F + 0.12, z + 0.5, M.sand, this.root, false);
        this.box(x - 0.6, F + 0.12, z + 0.06, x - 0.56, F + 5.2, z + 0.08, M.sand, this.root, false);
      }
    }
    // a line of warm strip lights along it, under the windows
    for (let x = -14.7 + 2.1; x <= 14.8; x += 4.2) this.box(x - 0.9, F + 4.6, z, x + 0.9, F + 4.68, z + 0.05, this.stripMat, this.root, false);
    // the song painted on the wall
    this.song(-5.3, F + 2.05, z + 0.38, 1.3);
    this.w(-5.3, F + 2.05, z + 0.4, this.muralAt);
    // the rail of a gantry crane, its hook block parked over the cradle
    this.box(X0 + 0.5, F + 6.3, z + 0.35, X1 - 0.5, F + 6.5, z + 0.75, M.metal);
    this.box(-0.6, F + 6.1, z + 0.3, 0.6, F + 6.3, z + 1.2, M.accent);
    this.box(-0.03, F + 4.6, z + 0.95, 0.03, F + 6.1, z + 1.01, M.dark, this.root, false);
    this.cube(0.3, 0.35, 0.3, M.metal, 0, F + 4.5, z + 0.98);
    // shot up: laser burns and bullet holes peppering it behind the barricade
    for (let i = 0; i < 46; i++) {
      const bx = -6.5 + ((i * 3.71) % 13);
      const by = F + 0.6 + ((i * 1.93) % 3.6);
      // (they missed the song)
      if (bx > -8.6 && bx < -2.0 && by > F + 0.9 && by < F + 3.3) continue;
      if (i % 5 === 0) {
        this.add(this.root, new CylinderGeometry(0.12, 0.14, 0.01, 6).rotateX(Math.PI / 2), M.charred, bx, by, z + 0.04, false);
        this.cube(0.04, 0.04, 0.01, M.ember, bx, by, z + 0.05, this.root, false);
      } else this.cube(0.05, 0.05, 0.01, M.dark, bx, by, z + 0.036, this.root, false);
    }
  }

  /**
   * The song the Akridians painted on their wall, the way they write music: a
   * stroke for each note in its tone's colour, as long as it is held, set as
   * high as its tone. Centred at (x, y) on a wall facing +z at depth z; `s` is
   * its size. Painted in a glowing paint, it shows in the dark.
   */
  private song(x: number, y: number, z: number, s: number) {
    const M = this.M;
    const unit = 0.55 * s;
    const total = WALL_SONG.reduce((n, [, b]) => n + b, 0) * unit + (WALL_SONG.length - 1) * 0.12 * s;
    const w = total + 0.7 * s;
    const h = 1.5 * s;
    // its panel: dark, framed in orange, with a pale rule along the bottom
    this.box(x - w / 2, y - h / 2, z, x + w / 2, y + h / 2, z + 0.03, M.dark, this.root, false);
    this.box(x - w / 2 - 0.06 * s, y + h / 2, z, x + w / 2 + 0.06 * s, y + h / 2 + 0.07 * s, z + 0.04, M.accent, this.root, false);
    this.box(x - w / 2 - 0.06 * s, y - h / 2 - 0.07 * s, z, x + w / 2 + 0.06 * s, y - h / 2, z + 0.04, M.accent, this.root, false);
    for (const sx of [-1, 1]) this.box(x + sx * (w / 2 + 0.03 * s) - 0.03 * s, y - h / 2, z, x + sx * (w / 2 + 0.03 * s) + 0.03 * s, y + h / 2, z + 0.04, M.accent, this.root, false);
    const lo = Math.min(...WALL_SONG.map(([t]) => t));
    const hi = Math.max(...WALL_SONG.map(([t]) => t));
    let at = x - total / 2;
    for (const [tone, beats] of WALL_SONG) {
      const len = beats * unit;
      const ty = y - h * 0.3 + ((tone - lo) / Math.max(1, hi - lo)) * h * 0.6;
      const c = TONE_COLORS[tone];
      const paint = toonMaterial({ dark: c, mid: c, light: c, unlit: true, outline: 0 });
      this.box(at, ty - 0.09 * s, z + 0.03, at + len, ty + 0.09 * s, z + 0.045, paint, this.root, false);
      // a fainter trace of it below, where the paint ran
      this.box(at + len * 0.3, ty - 0.2 * s, z + 0.03, at + len * 0.34, ty - 0.09 * s, z + 0.04, paint, this.root, false);
      at += len + 0.12 * s;
    }
  }

  /**
   * The cradle, where they built Akridians: a round dais under a gantry, two
   * robot arms frozen mid-work, and hanging on cables from the gantry's beam
   * the frame of one not yet built, its heart still lit.
   */
  private buildCradle() {
    const M = this.M;
    const cx = 0;
    const cz = -3.8;
    const R = this.root;
    this.add(R, new CylinderGeometry(2.05, 2.2, 0.3, 16), M.metal, cx, F + 0.15, cz);
    this.add(R, new CylinderGeometry(2.08, 2.08, 0.05, 16), M.accent, cx, F + 0.27, cz);
    this.add(R, new CylinderGeometry(1.6, 1.6, 0.012, 16), M.panel, cx, F + 0.305, cz, false);
    // a ring of light set in the dais, its colour the hanging heart's
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      this.cube(0.18, 0.01, 0.05, this.coreMat, cx + Math.cos(a) * 1.82, F + 0.305, cz + Math.sin(a) * 1.82, R, false).rotation.y = -a;
    }
    this.round(cx, cz, 2.1);
    // the gantry: two pillars and the beam across them
    for (const sx of [-1, 1]) {
      this.box(cx + sx * 2.3 - 0.25, F, cz - 0.25, cx + sx * 2.3 + 0.25, F + 5.6, cz + 0.25, M.panel);
      this.box(cx + sx * 2.3 - 0.27, F + 5.0, cz - 0.27, cx + sx * 2.3 + 0.27, F + 5.2, cz + 0.27, M.accent);
      for (let y = 0.6; y < 5; y += 0.6) this.box(cx + sx * 2.3 - 0.26, F + y, cz + 0.255, cx + sx * 2.3 + 0.26, F + y + 0.03, cz + 0.26, M.metal, R, false);
    }
    this.box(cx - 2.6, F + 5.6, cz - 0.3, cx + 2.6, F + 6.0, cz + 0.3, M.hull);
    this.box(cx - 2.62, F + 5.55, cz - 0.31, cx + 2.62, F + 5.62, cz + 0.31, M.accent);
    // the frame hanging on its cables: a spine, ribs round a glowing heart, a skull's
    // outline, arms of bare rods, no shell yet on any of it
    const H = new Group();
    H.position.set(cx, F + 1.2, cz);
    H.rotation.y = 0.35;
    R.add(H);
    for (const [ox, oz] of [
      [-0.25, -0.1],
      [0.25, -0.1],
      [0, 0.2],
    ]) this.box(ox - 0.012, 2.3, oz - 0.012, ox + 0.012, 4.45, oz + 0.012, M.dark, H, false);
    this.box(-0.06, 0.9, -0.06, 0.06, 2.4, 0.06, M.metal, H);
    for (let k = 0; k < 3; k++) {
      const rib = this.add(H, new TorusGeometry(0.2 - k * 0.025, 0.018, 4, 10, Math.PI * 1.6), M.metal, 0, 1.85 - k * 0.17, 0.02);
      rib.rotation.set(Math.PI / 2, 0, Math.PI * 0.7);
    }
    const heart = this.cube(0.14, 0.16, 0.12, this.coreMat, 0, 1.72, 0.04, H, false);
    void heart;
    this.w(cx, F + 1.2 + 1.72, cz, this.coreAt);
    this.coreGlow.position.copy(this.coreAt);
    // the skull's frame, an eye socket, a single horn root
    for (const [w, h, d, x, y, z] of [
      [0.32, 0.03, 0.03, 0, 2.62, 0.14],
      [0.32, 0.03, 0.03, 0, 2.38, 0.14],
      [0.03, 0.27, 0.03, 0.15, 2.5, 0.14],
      [0.03, 0.27, 0.03, -0.15, 2.5, 0.14],
      [0.03, 0.03, 0.3, 0.15, 2.62, 0],
      [0.03, 0.03, 0.3, -0.15, 2.62, 0],
      [0.06, 0.16, 0.06, 0.12, 2.72, -0.04],
    ] as const) this.cube(w, h, d, M.metal, x, y, z, H);
    this.cube(0.06, 0.06, 0.02, this.coreMat, 0.07, 2.5, 0.155, H, false);
    for (const sx of [-1, 1]) {
      const arm = new Group();
      arm.position.set(sx * 0.24, 2.05, 0);
      arm.rotation.z = sx * 0.12;
      H.add(arm);
      this.box(-0.02, -0.6, -0.02, 0.02, 0, 0.02, M.metal, arm);
      this.box(-0.018, -1.1, -0.018, 0.018, -0.6, 0.018, M.metal, arm).rotation.x = -0.15;
      this.cube(0.06, 0.06, 0.06, M.accent, 0, -0.6, 0, arm);
    }
    for (const sx of [-1, 1]) this.box(sx * 0.1 - 0.025, 0.1, -0.025, sx * 0.1 + 0.025, 0.95, 0.025, M.metal, H);
    this.keep.push(H);
    this.lamp(cx, F + 3.0, cz + 0.4, 0.95, 0);
    this.pool2(0x5ad8ff, 2.4, cx, cz, 0.12);
    // the lamp over the song on the wall
    this.lamp(-5.3, F + 3.8, Z0 + 1.6, 0.9, 0);
    this.pool2(0xffd8a0, 2.4, -5.3, Z0 + 1.6, 0.16);
    // the robot arms: one still reaching for the frame, one fallen across the dais
    const robot = (x: number, z: number, yaw: number, lift: number, reach: number, fallen: boolean) => {
      const b = new Group();
      b.position.set(x, F + 0.3, z);
      b.rotation.y = yaw;
      R.add(b);
      this.add(b, new CylinderGeometry(0.3, 0.36, 0.3, 10), M.hull, 0, 0.15, 0);
      this.add(b, new CylinderGeometry(0.31, 0.31, 0.06, 10), M.accent, 0, 0.32, 0);
      const up = new Group();
      up.position.set(0, 0.35, 0);
      up.rotation.x = lift;
      b.add(up);
      this.cube(0.2, 1.3, 0.2, M.panel, 0, 0.65, 0, up);
      this.add(up, new CylinderGeometry(0.14, 0.14, 0.26, 8).rotateZ(Math.PI / 2), M.metal, 0, 1.3, 0);
      const fore = new Group();
      fore.position.set(0, 1.3, 0);
      fore.rotation.x = reach;
      up.add(fore);
      this.cube(0.15, 1.0, 0.15, M.hull, 0, 0.5, 0, fore);
      this.cube(0.16, 0.06, 0.16, M.accent, 0, 0.9, 0, fore);
      for (const sx of [-1, 1]) this.cube(0.03, 0.18, 0.06, M.metal, sx * 0.05, 1.08, 0, fore);
      if (fallen) {
        // torn off its base by a blast: a scorch under it, cables spilled
        this.add(R, new CylinderGeometry(0.5, 0.55, 0.008, 8), M.charred, x, F + 0.31, z, false);
      }
    };
    robot(cx - 1.35, cz + 0.55, 0.9, -0.45, -1.1, false);
    robot(cx + 1.45, cz + 0.4, -2.3, 1.25, 0.35, true);
    // cables snaking off the dais across the floor
    for (const [x0, z0, x1, z1] of [
      [1.9, -3.0, 3.4, -1.9],
      [3.4, -1.9, 6.4, -2.4],
      [-1.9, -3.1, -3.8, -2.4],
      [-3.8, -2.4, -8.4, -2.8],
    ]) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const c = this.cube(0.06, 0.05, len, M.dark, (x0 + x1) / 2, F + 0.025, (z0 + z1) / 2, R, false);
      c.rotation.y = Math.atan2(x1 - x0, z1 - z0);
    }
  }

  /** Where the roof fell in: plates and beams in a heap, sand pouring down onto it, the sun in a shaft. */
  private buildBreach() {
    const M = this.M;
    const b = BREACH;
    const R = this.root;
    // the sun's way down: under the hole and slanting away from the sun to the floor
    const L = shared.uSunDir.value;
    const inv = new Matrix4().copy(this.root.matrixWorld).invert();
    const l = L.clone().transformDirection(inv);
    const top = new Vector3(b.x, F + 7.6, b.z);
    const drop = (F + 7.6 - F) / Math.max(0.2, l.y);
    const foot = top.clone().addScaledVector(l, -drop);
    // where it falls on the floor, a warm glow round the sunlit patch
    this.pool2(0xffe0a0, 2.6, foot.x, foot.z, 0.16);
    this.w(top.x, top.y - 0.4, top.z, this.breachAt);
    this.w(top.x, top.y, top.z, this.shaftTop);
    this.w(foot.x, foot.y, foot.z, this.shaftFoot);
    // the heap under the hole: broken roof plates, a bent beam, sand
    const sand = this.add(R, new SphereGeometry(1.7, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.sand, b.x, F, b.z);
    sand.scale.set(1.25, 0.62, 1.0);
    this.add(R, new SphereGeometry(0.7, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), M.sand, b.x + 0.2, F + 0.9, b.z - 0.1).scale.set(1, 0.7, 1);
    this.w(b.x, F + 1.0, b.z, this.sandAt);
    for (const [w, d, x, y, z, rx, rz] of [
      [2.2, 1.4, b.x - 0.9, F + 0.45, b.z + 0.4, 0.3, -0.45],
      [1.6, 1.1, b.x + 1.0, F + 0.6, b.z - 0.5, -0.5, 0.35],
      [1.2, 0.9, b.x + 0.2, F + 1.1, b.z + 0.9, 0.9, 0.2],
    ]) {
      const p = this.cube(w, 0.08, d, M.hull, x, y, z);
      p.rotation.set(rx, 0.3, rz);
      const s = this.cube(w * 0.98, 0.02, 0.1, M.accent, x, y + 0.05, z);
      s.rotation.copy(p.rotation);
    }
    const beam = this.cube(0.18, 0.18, 3.2, M.metal, b.x - 0.3, F + 1.2, b.z - 0.2);
    beam.rotation.set(0.25, 0.7, 0.45);
    for (let k = 0; k < 9; k++) {
      const a = k * 2.1;
      const r = 1.6 + (k % 3) * 0.5;
      const s = this.add(R, new SphereGeometry(0.35 + (k % 3) * 0.12, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2), M.sand, b.x + Math.cos(a) * r, F, b.z + Math.sin(a) * r * 0.8);
      s.scale.set(1.5, 0.35, 1.1);
    }
    this.round(b.x, b.z, 1.7);
    // torn cable hanging from the hole's edge, sparking now and then
    this.box(b.x - b.hx + 0.2, F + 5.4, b.z - 0.02, b.x - b.hx + 0.24, F + 7.6, b.z + 0.02, M.dark, R, false);
    this.w(b.x - b.hx + 0.22, F + 5.4, b.z, this.sparkAt);
  }

  /** The barricade they held, and what the attack left: scorch, holes, a grenade's mark, casings, a dead man. */
  private buildFight() {
    const M = this.M;
    const R = this.root;
    // overturned tables and crates thrown up across the hall in front of the cradle
    const table = (x: number, z: number, yaw: number) => {
      const g = new Group();
      g.position.set(x, F, z);
      g.rotation.y = yaw;
      R.add(g);
      // on its side: the top stood on edge facing the door, the legs sticking back
      this.cube(1.6, 0.85, 0.06, M.panel, 0, 0.43, 0, g);
      this.cube(1.62, 0.04, 0.08, M.accent, 0, 0.82, 0, g);
      for (const sx of [-1, 1]) for (const sy of [0.15, 0.7]) this.cube(0.05, 0.05, 0.7, M.metal, sx * 0.7, sy, -0.36, g);
      // scorched and holed from the door's side
      this.cube(0.5, 0.14, 0.01, M.soot, 0.25, 0.5, 0.035, g, false).rotation.z = 0.35;
      this.cube(0.3, 0.08, 0.01, M.soot, -0.35, 0.3, 0.035, g, false).rotation.z = -0.2;
      for (let i = 0; i < 6; i++) this.cube(0.04, 0.04, 0.01, M.dark, -0.6 + i * 0.23, 0.25 + ((i * 0.37) % 0.5), 0.035, g, false);
      this.block(
        [
          [-0.8, -0.75],
          [0.8, -0.75],
          [0.8, 0.05],
          [-0.8, 0.05],
        ].map(([a, c]) => [x + a * Math.cos(yaw) + c * Math.sin(yaw), z - a * Math.sin(yaw) + c * Math.cos(yaw)] as [number, number]),
      );
    };
    const crate = (x: number, z: number, yaw: number, s = 1) => {
      const g = new Group();
      g.position.set(x, F, z);
      g.rotation.y = yaw;
      R.add(g);
      this.cube(0.8 * s, 0.7 * s, 0.6 * s, M.hull, 0, 0.35 * s, 0, g);
      this.cube(0.82 * s, 0.08 * s, 0.62 * s, M.accent, 0, 0.55 * s, 0, g);
      this.cube(0.3 * s, 0.2 * s, 0.01, M.hazard, 0.15 * s, 0.3 * s, 0.305 * s, g, false);
      this.round(x, z, 0.45 * s);
      return g;
    };
    // the lamp hanging over it, swinging a little on its chain, stuttering
    this.box(0.47, F + 4.3, -0.33, 0.53, F + 7.6, -0.27, M.dark, R, false);
    this.cube(0.7, 0.18, 0.4, M.metal, 0.5, F + 4.2, -0.3);
    this.lamp(0.5, F + 4.0, -0.3, 1.1, 1);
    this.pool2(0xffe0b0, 2.8, 0.5, -0.3, 0.26);
    table(-4.6, -0.5, 0.15);
    table(-2.5, -0.3, -0.05);
    crate(-1.0, -0.4, 0.3);
    table(1.0, -0.45, 0.08);
    crate(3.1, -0.6, -0.2);
    crate(3.7, -1.2, 0.5, 0.8);
    table(5.4, -0.8, -0.35);
    // a cabinet dragged over and tipped down as cover
    const cab = this.cube(0.6, 0.5, 1.8, M.panel, -6.5, F + 0.25, -0.9);
    cab.rotation.y = 0.25;
    this.cube(0.62, 0.05, 1.82, M.accent, -6.5, F + 0.5, -0.9).rotation.y = 0.25;
    this.round(-6.5, -0.9, 0.7);
    // a grenade's mark on the floor in front of it, its burst of fragments round it
    this.pool(-2.0, 1.5, 0.95, M.charred, 0, 1.0, 1.0);
    this.pool(-2.0, 1.5, 0.55, M.soot, 1, 1.0, 1.0);
    for (let i = 0; i < 16; i++) {
      const a = i * 2.4;
      const r = 1.0 + (i % 4) * 0.35;
      this.mark(-2.0 + Math.cos(a) * r, 1.5 + Math.sin(a) * r, 0.08 + (i % 3) * 0.05, 0.04, a, i % 2 ? M.metal : M.charred, 0.006);
    }
    // the spent casings strewn where they fired from, by the door
    for (let i = 0; i < 60; i++) {
      const x = -2.8 + ((i * 2.17) % 5.4) + Math.sin(i * 7.1) * 0.3;
      const z = 2.6 + ((i * 1.31) % 3.4);
      const c = this.cube(0.025, 0.025, 0.07, M.brass, x, F + 0.013, z, R, false);
      c.rotation.y = i * 1.3;
    }
    // a dropped magazine, and a helmet knocked off
    this.cube(0.05, 0.16, 0.08, M.blacker, 1.4, F + 0.025, 4.2).rotation.set(Math.PI / 2, 0.6, 0);
    this.buildHuman(2.4, 2.6, 0.4);
  }

  /** The human their fire caught: face down in black armour, his blood red under him. */
  private buildHuman(x: number, z: number, yaw: number) {
    const M = this.M;
    const H = new Group();
    H.position.set(x, F, z);
    H.rotation.y = yaw;
    this.root.add(H);
    const B = new Group();
    B.scale.setScalar(1.1);
    H.add(B);
    this.cube(0.36, 0.2, 0.3, M.black, 0, 0.12, 0, B);
    this.cube(0.44, 0.26, 0.6, M.black, 0, 0.15, 0.46, B);
    this.cube(0.46, 0.08, 0.52, M.blacker, 0, 0.3, 0.48, B);
    this.cube(0.3, 0.14, 0.3, M.blacker, 0, 0.41, 0.5, B);
    this.cube(0.04, 0.02, 0.04, M.redLine, 0.1, 0.48, 0.42, B, false);
    for (const sx of [-1, 1]) this.cube(0.16, 0.12, 0.2, M.blacker, sx * 0.27, 0.24, 0.72, B).rotation.z = sx * 0.4;
    // where the Akridians' fire went through his armour
    for (const [wx, wz] of [
      [0.1, 0.32],
      [-0.06, 0.58],
      [0.14, 0.7],
    ]) {
      this.add(B, new CylinderGeometry(0.05, 0.055, 0.012, 6), M.charred, wx, 0.345, wz, false);
      this.cube(0.024, 0.014, 0.024, M.ember, wx, 0.352, wz, B, false);
    }
    const head = new Group();
    head.position.set(-0.05, 0.15, 0.92);
    head.rotation.set(0.1, 0, -1.2);
    B.add(head);
    this.cube(0.24, 0.26, 0.28, M.black, 0, 0, 0, head);
    this.cube(0.2, 0.12, 0.04, M.visor, 0, 0.02, 0.15, head);
    this.cube(0.16, 0.015, 0.01, M.redLine, 0, 0.04, 0.172, head, false);
    const limb = (parent: Object3D, px: number, py: number, pz: number, rx: number, ry: number, rz: number, len: number, w: number) => {
      const g = new Group();
      g.position.set(px, py, pz);
      g.rotation.set(rx, ry, rz);
      parent.add(g);
      this.cube(w, w, len, M.black, 0, 0, len / 2, g);
      this.cube(w * 1.12, w * 0.5, len * 0.5, M.blacker, 0, w * 0.4, len * 0.45, g);
      return g;
    };
    const ru = limb(B, -0.3, 0.12, 0.72, 0.1, -0.5, 0, 0.32, 0.12);
    limb(ru, 0, 0, 0.32, -0.05, 0.4, 0, 0.3, 0.1);
    const lu = limb(B, 0.3, 0.1, 0.68, 0.2, 2.4, 0.2, 0.3, 0.12);
    limb(lu, 0, 0, 0.3, 0.4, -1.2, 0, 0.28, 0.1);
    for (const [sx, spread] of [
      [-1, -0.25],
      [1, 0.2],
    ]) {
      const th = limb(B, sx * 0.11, 0.1, -0.12, -0.05, Math.PI + spread, 0, 0.44, 0.15);
      const sh = limb(th, 0, 0, 0.44, 0, 0.2 * sx, 0, 0.42, 0.13);
      this.cube(0.15, 0.24, 0.12, M.blacker, 0, -0.08, 0.46, sh).rotation.x = 0.2;
    }
    this.pool(x + 0.1, z + 0.4, 0.42, M.redBlood, 0);
    this.pool(x - 0.2, z + 0.9, 0.2, M.redBlood, 1);
    // his rifle, dropped beside him
    const r = this.cube(0.07, 0.07, 0.9, M.black, x - 0.6, F + 0.04, z + 0.9);
    r.rotation.y = 1.1;
    this.cube(0.05, 0.16, 0.06, M.blacker, x - 0.55, F + 0.04, z + 0.8).rotation.set(Math.PI / 2, 1.1, 0);
    this.round(x, z + 0.5, 0.6);
  }

  /** The Akridians who held the hall, where they died. */
  private *buildDead(): Generator<unknown, void, unknown> {
    const M = this.M;
    const set: [Skin, ScriptPose, number, number, number, [number, number][], boolean][] = [
      // skin, pose, x, z, facing (from facing the door), wounds (x, y on the chest's face), front
      [TEAL, SITTING, -3.3, -1.25, Math.PI, [[0.06, 0.18], [-0.08, 0.08]], true],
      [BLUE, DRAPED, 3.1, -1.35, 0.1, [[0.05, 0.16]], false],
      [VIOLET, ON_BACK, 1.6, -2.1, 2.2, [[0.0, 0.14], [0.08, 0.2], [-0.07, 0.05]], true],
      [OCHRE, CRAWLING, -7.0, 0.1, -Math.PI / 2 - 0.15, [[0.06, 0.1]], false],
      [GREEN, AT_DOOR, 15.1, 0.05, 0.05, [[0.05, 0.18], [-0.06, 0.1]], true],
    ];
    const v = new Vector3();
    const rootYaw = new Vector3(0, 0, 1).transformDirection(this.root.matrixWorld);
    const baseYaw = Math.atan2(rootYaw.x, rootYaw.z);
    for (const [skin, pose, x, z, turn, wounds, front] of set) {
      this.w(x, F, z, v);
      const c = new Creature(this.world, v.x, v.z, skin);
      c.setYaw(baseYaw + turn);
      c.pos.set(v.x, this.floorY, v.z);
      c.scriptBreath = { value: 0, amp: 0 };
      for (let i = 0; i < 30; i++) c.updateScripted(1 / 30, pose, this.world);
      const rig = c.rig;
      const zf = front ? 0.125 : -0.125;
      wounds.forEach(([wx, wy], k) => {
        const burn = this.add(rig.chest, new CylinderGeometry(0.045, 0.05, 0.012, 6).rotateX(Math.PI / 2), M.charred, wx, 0.03 + wy, zf, false);
        burn.rotation.z = k;
        this.cube(0.022, 0.022, 0.014, M.ember, wx, 0.03 + wy, zf * 1.04, rig.chest, false);
      });
      rig.root.updateMatrixWorld(true);
      this.bodies.add(rig.root);
      this.colliders.push(footprintOf(rig.root, 0.3));
      // their blood, dark blue-grey, pooled under them
      for (const [r, dx, dz, k] of [
        [0.36, 0.05, 0.1, 0],
        [0.22, 0.4, -0.25, 1],
        [0.12, -0.36, 0.35, 2],
      ]) this.pool(x + dx, z + dz, r, M.blood, k);
      yield;
    }
    // the trail where the ochre one dragged itself from the barricade toward the plant room
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const x = -3.9 + (-6.6 + 3.9) * t;
      const z = -0.9 + (0.0 + 0.9) * t + Math.sin(t * 7) * 0.12;
      this.mark(x, z, 0.32, 0.22 + 0.12 * Math.sin(i), 0.3 + i * 0.2, M.blood, 0.002 + (i % 3) * 0.0005);
    }
    // the green one's hands on the vault door, smeared down it
    for (let i = 0; i < 5; i++) this.box(13.5 + i * 0.12, F + 0.6 + i * 0.2, VAULT.z1 + 0.05, 13.62 + i * 0.12, F + 0.75 + i * 0.22, VAULT.z1 + 0.06, M.blood, this.root, false);
  }

  /** The security office: a window onto the plant room, a desk under a bank of monitors, papers. */
  private buildOffice() {
    const M = this.M;
    const R = this.root;
    const x0 = X0;
    const x1 = -10.6;
    const z0 = 1.6;
    // its back wall: solid to waist height, a long window over it, glass a share of its pixels
    this.wall(x0, z0 - 0.15, x1, z0 + 0.15, 1.0);
    const glass = ditherMaterial(0x2a3a44, 0x9ab8c4, 0.18);
    this.box(x0, F + 1.0, z0 - 0.02, x1, F + 2.5, z0 + 0.02, glass, R, false);
    this.box(x0, F + 2.5, z0 - 0.15, x1, F + WALL, z0 + 0.15, M.lining);
    this.box(x0, F + WALL, z0 - 0.16, x1, F + WALL + 0.03, z0 + 0.16, M.cut, R, false);
    for (let x = x0 + 1.6; x < x1; x += 1.6) this.box(x - 0.05, F + 1.0, z0 - 0.06, x + 0.05, F + 2.5, z0 + 0.06, M.metal);
    // a hole shot through the window, the glass spilled on the desk
    this.add(R, new CylinderGeometry(0.2, 0.2, 0.05, 7).rotateX(Math.PI / 2), M.dead, -12.2, F + 2.0, z0, false);
    // its side wall, a door in it
    this.wall(x1 - 0.15, z0, x1 + 0.15, 3.4);
    this.wall(x1 - 0.15, 4.6, x1 + 0.15, Z1);
    this.box(x1 - 0.17, F + 2.2, 3.4, x1 + 0.17, F + WALL, 4.6, M.lining);
    // the desk along the window, the monitors on it: two rows of three
    this.box(-16.4, F + 0.74, 1.8, -11.0, F + 0.8, 2.6, M.panel);
    this.box(-16.4, F, 1.85, -16.2, F + 0.74, 2.55, M.metal);
    this.box(-11.2, F, 1.85, -11.0, F + 0.74, 2.55, M.metal);
    this.rect(-16.5, 1.7, -10.9, 2.65);
    const mx = -13.7;
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 3; k++) {
        const x = mx + (k - 1) * 1.15;
        const y = F + 1.15 + row * 0.62;
        this.box(x - 0.52, y - 0.3, 1.86, x + 0.52, y + 0.3, 2.06, M.metal);
        const feed = row * 3 + k;
        const lit = toonMaterial({ dark: 0x2a4a3a, mid: 0x2a4a3a, light: 0x2a4a3a, unlit: true, outline: 0 });
        this.box(x - 0.46, y - 0.25, 2.06, x + 0.46, y + 0.25, 2.075, lit, R, false);
        this.screens.push({ mat: lit, feed: feed < 4 ? feed : -1, seed: feed * 7.3 });
      }
    }
    this.monitors.proxy.position.set(mx, F + 1.45, 2.05);
    this.monitors.proxy.visible = false;
    R.add(this.monitors.proxy);
    this.keep.push(this.monitors.proxy);
    this.w(mx, F, 3.25, this.monitors.stand);
    this.w(mx, F + 1.4, 2.1, this.monitors.look);
    this.w(mx, F + 1.4, 2.4, this.officeAt);
    // a keyboard, a mug, papers, the chair pushed back
    this.box(mx - 0.4, F + 0.8, 2.3, mx + 0.4, F + 0.83, 2.5, M.dark, R, false);
    this.add(R, new CylinderGeometry(0.05, 0.045, 0.1, 6), M.panel, mx + 0.9, F + 0.85, 2.4);
    for (let i = 0; i < 8; i++) this.mark(-15 + (i * 0.77) % 3.5, 2.9 + ((i * 1.3) % 3), 0.22, 0.3, i * 0.9, M.paper, 0.004 + i * 0.0006);
    const chair = new Group();
    chair.position.set(mx + 0.3, F, 3.5);
    chair.rotation.y = 0.6;
    R.add(chair);
    this.cube(0.5, 0.08, 0.5, M.cloth, 0, 0.48, 0, chair);
    this.cube(0.5, 0.6, 0.08, M.cloth, 0, 0.8, -0.24, chair);
    this.add(chair, new CylinderGeometry(0.04, 0.04, 0.44, 6), M.metal, 0, 0.22, 0);
    for (let k = 0; k < 5; k++) this.cube(0.05, 0.04, 0.3, M.metal, Math.sin(k * 1.26) * 0.15, 0.03, Math.cos(k * 1.26) * 0.15, chair).rotation.y = k * 1.26;
    this.round(mx + 0.3, 3.5, 0.32);
    // the gun rack by the door, emptied
    this.box(x1 - 0.5, F + 0.2, 5.4, x1 - 0.15, F + 2.0, 6.6, M.metal);
    for (let k = 0; k < 4; k++) this.box(x1 - 0.55, F + 0.6, 5.55 + k * 0.28, x1 - 0.5, F + 1.7, 5.6 + k * 0.28, M.dark, R, false);
    this.rect(x1 - 0.55, 5.35, x1 - 0.1, 6.65);
    this.lamp(mx, F + 2.4, 3.2, 0.95, 0);
    this.glow(0x7ae0a0, 1.4, mx, F + 1.4, 2.4, 0.2);
  }

  /** The plant room: tanks, pumps, gauges, and the manifold where the six pipes begin. */
  private buildPlant() {
    const M = this.M;
    const R = this.root;
    // its wall to the hall, open at the front (a wide way through)
    this.wall(-8.75, Z0, -8.45, -1.2);
    // two tall tanks
    for (const z of [-5.4, -2.9]) {
      this.add(R, new CylinderGeometry(0.8, 0.8, 4.4, 12), M.hull, -15.7, F + 2.2, z);
      for (const y of [0.6, 2.2, 3.8]) this.add(R, new CylinderGeometry(0.82, 0.82, 0.12, 12), M.accent, -15.7, F + y, z);
      this.add(R, new CylinderGeometry(0.55, 0.8, 0.3, 12), M.panel, -15.7, F + 4.55, z);
      this.round(-15.7, z, 0.85);
      // a gauge on each, its needle still
      this.add(R, new CylinderGeometry(0.12, 0.12, 0.04, 8).rotateZ(Math.PI / 2), M.panel, -14.88, F + 1.4, z);
      this.cube(0.01, 0.12, 0.02, M.redLine, -14.85, F + 1.43, z, R, false).rotation.x = 0.7;
    }
    // the pumps, each a motor and a flywheel, on a plinth
    for (const [x, z] of [
      [-12.8, -5.9],
      [-12.8, -4.3],
    ]) {
      this.box(x - 0.9, F, z - 0.5, x + 0.9, F + 0.25, z + 0.5, M.metal);
      this.cube(1.0, 0.7, 0.7, M.panel, x - 0.2, F + 0.6, z);
      this.add(R, new CylinderGeometry(0.42, 0.42, 0.12, 12).rotateX(Math.PI / 2), M.dark, x + 0.55, F + 0.65, z);
      this.cube(0.3, 0.08, 0.72, M.accent, x - 0.2, F + 0.96, z);
      this.rect(x - 0.9, z - 0.5, x + 0.9, z + 0.5);
    }
    // a workbench, a ladder up the wall, warning stencils
    this.box(-11.5, F + 0.8, -1.0, -9.2, F + 0.86, -0.4, M.wood);
    for (const x of [-11.4, -9.3]) this.box(x - 0.04, F, -0.95, x + 0.04, F + 0.8, -0.45, M.metal);
    this.rect(-11.6, -1.05, -9.1, -0.35);
    for (let y = 0.4; y < 5.6; y += 0.35) this.box(-10.3, F + y, Z0 + 0.05, -9.7, F + y + 0.04, Z0 + 0.12, M.metal, R, false);
    for (const x of [-10.3, -9.7]) this.box(x - 0.03, F, Z0 + 0.05, x + 0.03, F + 5.6, Z0 + 0.12, M.metal, R, false);
    this.cube(0.9, 0.5, 0.02, M.yellow, -13.3, F + 2.2, Z0 + 0.03, R, false);
    this.cube(0.7, 0.3, 0.025, M.hazard, -13.3, F + 2.2, Z0 + 0.035, R, false);
    this.lamp(-12.6, F + 3.2, -2.8, 0.85, 1);
    this.pool2(0xffd090, 2.0, -12.6, -2.8, 0.21);
  }

  /**
   * The six pipes: out of the manifold in the plant room, up and along the far
   * wall the length of the hall, down over the vault's roof and its front, and
   * into it. Each is its own size and banded in its own tone's colour.
   */
  private buildPipes() {
    const M = this.M;
    const R = this.root;
    const n = PIPE_TONES.length;
    // the manifold they come out of
    this.box(-11.9, F, Z0 + 0.1, -10.1, F + 1.0, Z0 + 0.9, M.metal);
    this.add(R, new TorusGeometry(0.25, 0.04, 5, 10), M.accent, -11.0, F + 1.2, Z0 + 0.95);
    for (let k = 0; k < n; k++) {
      const tone = PIPE_TONES[k];
      // the lowest tones are the thickest
      const r = 0.155 - tone * 0.011;
      const color = TONE_COLORS[tone];
      const band = toonMaterial({ dark: shade(color, 0.45), mid: shade(color, 0.75), light: color, litAt: 0.55, outline: 0.4, highlight: 0.6 });
      const runY = F + 4.35 + k * 0.32;
      const runZ = Z0 + 0.42 + (k % 2) * 0.05;
      const dropX = PIPE_X + k * PIPE_STEP;
      const roofY = F + VAULT.h + 0.25 + (n - 1 - k) * 0.0;
      const frontZ = VAULT.z1 + 0.18;
      const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
        const a = new Vector3(ax, ay, az);
        const b = new Vector3(bx, by, bz);
        const len = a.distanceTo(b);
        const m = this.add(R, new CylinderGeometry(r, r, len, 8), M.metal, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
        m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
        // its colour, in bands along it
        const bands = len > 2 ? Math.max(1, Math.floor(len / 5)) : 0;
        for (let i = 0; i < bands; i++) {
          const t = (i + 0.5) / bands;
          const bm = this.add(R, new CylinderGeometry(r + 0.012, r + 0.012, 0.12, 8), band, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, false);
          bm.quaternion.copy(m.quaternion);
        }
        return m;
      };
      const elbow = (x: number, y: number, z: number) => this.add(R, new IcosahedronGeometry(r * 1.25, 1), M.metal, x, y, z);
      const startX = -11.0 + (k - 2.5) * 0.25;
      seg(startX, F + 1.0, Z0 + 0.5, startX, runY, runZ);
      elbow(startX, runY, runZ);
      seg(startX, runY, runZ, dropX, runY, runZ);
      elbow(dropX, runY, runZ);
      seg(dropX, runY, runZ, dropX, roofY, runZ);
      elbow(dropX, roofY, runZ);
      seg(dropX, roofY, runZ, dropX, roofY, frontZ);
      elbow(dropX, roofY, frontZ);
      seg(dropX, roofY, frontZ, dropX, F + 0.45, frontZ);
      elbow(dropX, F + 0.45, frontZ);
      seg(dropX, F + 0.45, frontZ, dropX, F + 0.45, VAULT.z1 - 0.1);
      // a collar where it goes into the wall, and a cap of its colour at the knocking height
      this.add(R, new CylinderGeometry(r + 0.04, r + 0.04, 0.06, 8).rotateX(Math.PI / 2), M.trim, dropX, F + 0.45, VAULT.z1 + 0.03);
      this.add(R, new CylinderGeometry(r + 0.02, r + 0.02, 0.28, 8), band, dropX, F + 1.15, frontZ, false);
      // inside the vault it comes out low and runs along under its front wall
      this.seg2(dropX, F + 0.45, VAULT.z1 - 0.3, r, M.metal);
      // the mouse's box round where it is knocked on
      const proxy = new Mesh(new BoxGeometry(PIPE_STEP * 0.95, 1.4, 0.5));
      proxy.position.set(dropX, F + 1.2, frontZ);
      proxy.visible = false;
      R.add(proxy);
      this.keep.push(proxy);
      this.pipes.push({
        at: this.w(dropX, F + 1.15, frontZ + r),
        inner: this.w(dropX, F + 0.5, VAULT.z1 - 0.32),
        tone,
        f: TONES[tone],
        size: clamp((0.155 - r) / -0.1 + 1, 0, 1),
        proxy,
        color,
      });
    }
    const mid = PIPE_X + ((n - 1) * PIPE_STEP) / 2;
    this.w(mid, F, VAULT.z1 + 1.05, this.pipeStand);
    this.w(mid, F + 1.1, VAULT.z1 + 0.2, this.pipeLook);
    // and painted by the door, small, the song from the hall's wall
    this.song(15.85, F + 2.1, VAULT.z1, 0.4);
    this.lamp(mid, F + 2.6, VAULT.z1 + 1.6, 0.85, 0);
    this.pool2(0xffe0b0, 1.8, mid, VAULT.z1 + 1.3, 0.14);
  }

  /** A short stub of pipe inside the vault, where it comes through the wall. */
  private seg2(x: number, y: number, z: number, r: number, mat: Material) {
    const m = this.add(this.root, new CylinderGeometry(r, r, 0.5, 8).rotateX(Math.PI / 2), mat, x, y, z);
    return m;
  }

  /** The vault: walls, a roof of its own, a heavy door locked from inside, a cot, stores. */
  private buildVault() {
    const M = this.M;
    const R = this.root;
    const v = VAULT;
    // its walls and roof
    this.wall(v.x0 - 0.3, v.z0, v.x0, v.z1, v.h, M.liningDark);
    this.wall(v.x0 - 0.3, v.z1 - 0.3, v.door0, v.z1, v.h, M.liningDark);
    this.wall(v.door1, v.z1 - 0.3, v.x1, v.z1, v.h, M.liningDark);
    this.box(v.door0, F + 2.4, v.z1 - 0.3, v.door1, F + v.h, v.z1, M.liningDark);
    this.box(v.x0 - 0.35, F + v.h, v.z0, v.x1, F + v.h + 0.18, v.z1 + 0.05, M.panel);
    this.box(v.x0 - 0.37, F + v.h + 0.18, v.z0, v.x1, F + v.h + 0.21, v.z1 + 0.07, M.accent);
    this.cube(1.0, 0.25, 0.8, M.metal, 15.2, F + v.h + 0.3, -4.0);
    // the door: thick, banded in hazard stripes, no handle on this side
    const D = this.vault.door;
    D.position.set((v.door0 + v.door1) / 2, F, v.z1 - 0.12);
    R.add(D);
    this.keep.push(D);
    const dw = v.door1 - v.door0;
    this.cube(dw, 2.38, 0.18, M.panel, 0, 1.19, 0, D);
    for (let k = 0; k < 5; k++) this.cube(dw * 0.98, 0.12, 0.01, k % 2 ? M.yellow : M.hazard, 0, 0.15 + k * 0.14, 0.095, D, false);
    this.cube(0.6, 0.5, 0.02, M.dark, 0, 1.6, 0.095, D, false);
    this.cube(0.4, 0.04, 0.025, M.metal, 0, 1.25, 0.1, D, false);
    // the frame round it, and the lock's panel with its light
    for (const sx of [v.door0 - 0.1, v.door1 + 0.1]) this.box(sx - 0.1, F, v.z1 - 0.32, sx + 0.1, F + 2.5, v.z1 + 0.06, M.metal);
    this.box(v.door0 - 0.2, F + 2.4, v.z1 - 0.32, v.door1 + 0.2, F + 2.55, v.z1 + 0.06, M.metal);
    this.box(v.door1 + 0.25, F + 1.1, v.z1, v.door1 + 0.55, F + 1.55, v.z1 + 0.06, M.dark);
    this.box(v.door1 + 0.33, F + 1.35, v.z1 + 0.06, v.door1 + 0.47, F + 1.45, v.z1 + 0.075, this.vault.lock, R, false);
    this.w(v.door1 + 0.4, F + 1.4, v.z1 + 0.2, this.vault.lockGlow.position);
    this.vault.proxy.position.set((v.door0 + v.door1) / 2 + 0.3, F + 1.2, v.z1 + 0.15);
    this.vault.proxy.visible = false;
    R.add(this.vault.proxy);
    this.keep.push(this.vault.proxy);
    this.w((v.door0 + v.door1) / 2, F, v.z1 + 1.0, this.vault.stand);
    this.w((v.door0 + v.door1) / 2, F + 1.3, v.z1, this.vault.look);
    this.w((v.door0 + v.door1) / 2, F, v.z1 - 0.8, this.vault.inside);
    this.w((v.door0 + v.door1) / 2 - 0.4, F, v.z1 + 1.4, this.vault.outside);
    // a collider over the doorway while it is shut (taken away when it opens)
    this.rect(v.door0, v.z1 - 0.3, v.door1, v.z1);
    // inside: a cot, shelves of stores, tins and a water can on the floor, a blanket,
    // a hand lamp left on
    this.box(15.2, F, -6.6, 16.6, F + 0.45, -4.6, M.metal);
    this.box(15.25, F + 0.45, -6.55, 16.55, F + 0.55, -4.65, M.cloth);
    for (const y of [0.4, 1.1, 1.8]) this.box(10.6, F + y, -6.7, 13.6, F + y + 0.06, -6.2, M.metal);
    for (let k = 0; k < 9; k++) this.add(R, new CylinderGeometry(0.08, 0.08, 0.16, 6), k % 3 ? M.panel : M.accent, 10.9 + (k % 5) * 0.55, F + 0.54 + Math.floor(k / 5) * 0.7, -6.45);
    for (let k = 0; k < 6; k++) this.add(R, new CylinderGeometry(0.07, 0.07, 0.14, 6), M.panel, 12.6 + (k % 3) * 0.3, F + 0.07, -2.2 + Math.floor(k / 3) * 0.3);
    this.cube(0.9, 0.04, 0.7, M.cloth, 11.6, F + 0.03, -2.6, R, false).rotation.y = 0.4;
    // the hand lamp it keeps by it in its corner, turned down low
    this.cube(0.2, 0.25, 0.14, M.hull, 12.25, F + 0.13, -2.35);
    this.cube(0.12, 0.06, 0.02, this.coreMat, 12.25, F + 0.16, -2.27, R, false);
    this.lamp(12.2, F + 0.9, -2.2, 0.85, 0, true);
    this.glow(0xffc070, 0.5, 12.25, F + 0.25, -2.2, 0.6);
    // where it hides: crouched in the corner by the pipes, where the knocks come through
    this.w(11.15, F, v.z1 - 0.95, this.hide);
    const fwd = new Vector3(1, 0, -0.55).normalize().transformDirection(this.root.matrixWorld);
    this.hideYaw = Math.atan2(fwd.x, fwd.z);
  }

  /** The lab: empty capsules (one smashed), shelves of half-made heads, a workbench. */
  private buildLab() {
    const M = this.M;
    const R = this.root;
    const glass = ditherMaterial(0x3a6a74, 0xa8e0e8, 0.25);
    for (const [z, smashed] of [
      [1.4, false],
      [3.4, true],
      [5.4, false],
    ] as const) {
      this.box(14.6, F, z - 0.6, 16.6, F + 0.55, z + 0.6, M.hull);
      this.box(14.58, F + 0.4, z - 0.62, 16.62, F + 0.48, z + 0.62, M.accent);
      this.box(14.8, F + 0.55, z - 0.45, 16.4, F + 0.6, z + 0.45, M.dead, R, false);
      if (!smashed) {
        const lid = this.add(R, new CylinderGeometry(0.45, 0.45, 1.6, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), glass, 15.6, F + 0.6, z, false);
        lid.rotation.x = Math.PI / 2;
      } else {
        for (let i = 0; i < 10; i++) this.mark(13.6 + (i % 4) * 0.3, z - 0.6 + i * 0.13, 0.12, 0.06, i, M.dead, 0.005);
        this.add(R, new CylinderGeometry(0.45, 0.45, 0.5, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2), glass, 16.2, F + 0.6, z, false).rotation.x = Math.PI / 2;
      }
      this.rect(14.6, z - 0.6, 16.6, z + 0.6);
    }
    // shelves of heads: shells made in their makers' colours, waiting for bodies
    this.box(9.0, F, 1.8, 9.5, F + 2.3, 5.8, M.metal);
    this.rect(8.95, 1.75, 9.55, 5.85);
    const shells = [0x7a4a40, 0x4b6684, 0x5a6e4a, 0x86682a, 0x5a4476, 0x386660];
    for (let row = 0; row < 3; row++) {
      this.box(8.95, F + 0.5 + row * 0.7, 1.8, 9.55, F + 0.55 + row * 0.7, 5.8, M.panel);
      for (let k = 0; k < 4; k++) {
        const c = shells[(row * 4 + k) % shells.length];
        const m = toonMaterial({ dark: shade(c, 0.6), mid: c, light: shade(c, 1.3), litAt: 0.55, outline: 0.6, highlight: 0.6 });
        const z = 2.2 + k * 0.95;
        this.cube(0.3, 0.3, 0.38, m, 9.3, F + 0.72 + row * 0.7, z);
        this.cube(0.05, 0.16, 0.05, m, 9.3, F + 0.95 + row * 0.7, z + 0.1);
        this.cube(0.02, 0.06, 0.06, M.dead, 9.46, F + 0.75 + row * 0.7, z + 0.1, R, false);
      }
    }
    // the workbench: a head opened up on it, its tools
    this.box(11.6, F + 0.85, 2.6, 13.6, F + 0.92, 3.8, M.panel);
    for (const [x, z] of [
      [11.7, 2.7],
      [13.5, 2.7],
      [11.7, 3.7],
      [13.5, 3.7],
    ]) this.box(x - 0.04, F, z - 0.04, x + 0.04, F + 0.85, z + 0.04, M.metal);
    this.rect(11.5, 2.5, 13.7, 3.9);
    this.cube(0.34, 0.3, 0.4, M.fur, 12.5, F + 1.07, 3.2);
    this.cube(0.16, 0.16, 0.02, M.dark, 12.5, F + 1.1, 3.41, R, false);
    this.cube(0.3, 0.02, 0.06, M.metal, 13.1, F + 0.93, 3.0, R, false).rotation.y = 0.4;
    this.cube(0.24, 0.02, 0.05, M.accent, 12.0, F + 0.93, 3.5, R, false).rotation.y = -0.8;
    this.lamp(12.6, F + 2.6, 3.2, 0.85, 0);
    this.pool2(0xd8f0ff, 2.0, 12.6, 3.2, 0.12);
    // the cameras: one over the hall, one by the door, one in the lab, one in the vault
    const feed = (ax: number, ay: number, az: number, lx: number, ly: number, lz: number, fov: number) => {
      this.feeds.push({ at: this.w(ax, ay, az), look: this.w(lx, ly, lz), fov });
      // the camera itself on its bracket
      this.cube(0.22, 0.16, 0.34, M.dark, ax, ay, az).lookAt(this.w(lx, ly, lz));
    };
    feed(-8.2, F + 5.4, 6.4, 0.5, F + 0.8, -2.0, 62);
    feed(3.2, F + 4.2, 6.5, -0.8, F + 0.4, 1.6, 66);
    feed(16.4, F + 3.4, 6.4, 11.6, F + 0.9, -0.4, 64);
    feed(13.1, F + 1.55, -3.3, 11.15, F + 0.45, -1.55, 60);
  }

  // ------------------------------------------------------------------ running

  /**
   * Light the hall and run what goes on in it. `inside` is how far the
   * creature is in (0..1, eased); `listener` is where it hears from.
   */
  update(dt: number, time: number, inside: number, listener: Vector3) {
    this.root.visible = inside > 0;
    this.bodies.visible = inside > 0;
    this.casters.visible = inside > 0;
    if (inside <= 0) {
      for (const g of this.glows) g.strength = 0;
      return;
    }
    shared.uRoomOn.value = inside;
    shared.uRoomKind.value = 1;
    shared.uRoomInv.value.copy(this.inv);
    // the lamps: the one over the barricade stutters, the plant room's flickers
    const n = noise1(time * 4, 23);
    this.flick = n > -0.3 ? 1 : Math.random() < 0.4 ? 0.8 : 0.1;
    const core = 0.8 + 0.2 * Math.sin(time * 0.5) + 0.05 * noise1(time * 3, 5);
    this.lamps.forEach((l, i) => {
      const v = shared.uRoomLight.value[i];
      let k = l.base * (l.flicker ? this.flick : 1);
      if (i === 0) k *= core;
      v.set(l.pos.x, l.pos.y, l.pos.z, k);
    });
    for (let i = this.lamps.length; i < shared.uRoomLight.value.length; i++) shared.uRoomLight.value[i].w = 0;
    for (const g of this.glows) g.strength = 0.35 * inside;
    this.coreGlow.strength = 0.55 * core * inside;
    if (this.dayGlow) this.dayGlow.strength = 0.2 * inside;
    for (const p of this.pools) p.g.strength = p.k * inside * (p.k > 0.2 ? this.flick : 1);
    (this.coreMat.uniforms.uLight.value as Vector3).set(0.35, 0.85, 1).multiplyScalar(0.75 + 0.25 * core);
    // the vault's lock: red, steady; flashing when someone tries it; green when it lets go
    const vs = this.vault;
    vs.refused = Math.max(0, vs.refused - dt);
    const red = vs.state === 'locked' ? (vs.refused > 0 ? (time % 0.25 < 0.12 ? 1 : 0.15) : 0.75) : 0;
    const lc = vs.state === 'locked' ? [red, 0.1 * red, 0.08 * red] : [0.25, 1, 0.4];
    (vs.lock.uniforms.uLight.value as Vector3).set(lc[0], lc[1], lc[2]);
    vs.lockGlow.color.set(lc[0], lc[1], lc[2]);
    vs.lockGlow.strength = 0.5 * inside * Math.max(red, vs.state === 'locked' ? 0 : 1);
    if (vs.state === 'opening') {
      vs.t += dt;
      const k = Math.min(1, vs.t / 2.2);
      vs.door.position.x = (VAULT.door0 + VAULT.door1) / 2 + (VAULT.door1 - VAULT.door0 + 0.1) * (k * k * (3 - 2 * k));
      if (k >= 1) vs.state = 'open';
    }
    // the monitors: snow and dim pictures, the one being watched bright
    for (const s of this.screens) {
      const v = s.mat.uniforms.uLight.value as Vector3;
      if (s.feed < 0) {
        const f = 0.12 + 0.12 * Math.random();
        v.set(f, f * 1.1, f);
      } else {
        const on = s.feed === this.feedOn ? 1.6 : 1;
        const f = (0.22 + 0.05 * noise1(time * 6 + s.seed, 3) + (Math.random() < 0.02 ? 0.15 : 0)) * on;
        v.set(f * 0.75, f * 1.15, f * 0.9);
      }
    }
    // sand pours in through the roof in a thin stream, and catches the sun
    this.sandTimer -= dt;
    while (this.sandTimer <= 0) {
      this.sandTimer += 0.03;
      const p = this.breachAt;
      this.dust.spawn(p.x + (Math.random() - 0.5) * 0.35, p.y, p.z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.1, -0.5, (Math.random() - 0.5) * 0.1, 1.2, SAND, 1, { g: 9, drag: 0.3, windK: 0, c2: SAND_FADE });
    }
    // motes drifting in the shaft
    this.moteTimer -= dt;
    if (this.moteTimer <= 0) {
      this.moteTimer = 0.18;
      const p = this.tmp.lerpVectors(this.shaftFoot, this.shaftTop, 0.05 + Math.random() * 0.85);
      this.dust.spawn(p.x + (Math.random() - 0.5) * 2.2, p.y, p.z + (Math.random() - 0.5) * 1.8, 0.04, 0.02, 0.02, 5 + Math.random() * 3, MOTE, 1, { g: -0.01, drag: 0.6, windK: 0, c2: MOTE_FADE });
    }
    // the torn cable at the hole's edge sparks
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 1.5 + Math.random() * 4;
      const p = this.sparkAt;
      for (let i = 0; i < 10; i++) {
        this.dust.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.4 + Math.random() * 0.4, SPARK_HOT, 1, { g: 9, drag: 0.5, windK: 0, c2: SPARK_COOL });
      }
    }
    // its sounds: the sand, the cradle's heart, the monitors; a groan of the frame, a drip
    const near = (p: Vector3, r: number) => clamp(1 - listener.distanceTo(p) / r, 0, 1);
    const pan = (p: Vector3) => clamp((p.x - listener.x) / 8, -0.8, 0.8);
    this.audio.setHall(near(this.sandAt, 9) ** 2, pan(this.sandAt), 0.15 + 0.85 * near(this.coreAt, 12) ** 2, pan(this.coreAt), near(this.officeAt, 5) ** 2);
    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = 20 + Math.random() * 25;
      this.audio.hallGroan(0.1, (Math.random() - 0.5) * 1.2);
    }
    this.dripTimer -= dt;
    if (this.dripTimer <= 0) {
      this.dripTimer = 7 + Math.random() * 9;
      this.audio.hallDrip(0.015 + Math.random() * 0.015, (Math.random() - 0.5) * 1.2);
    }
  }

  /** Open the vault's door from inside: its bolts are drawn, then it slides away. */
  unlockVault() {
    this.vault.state = 'unlocking';
    this.audio.vaultUnlock(0.5);
  }

  /** The door starts to slide open (after its bolts are drawn). */
  openVault() {
    this.vault.state = 'opening';
    this.vault.t = 0;
    this.audio.vaultSlide(2.2, 0.4);
    // its doorway is no longer in the way
    const v = new Vector3();
    const c = this.w((VAULT.door0 + VAULT.door1) / 2, 0, VAULT.z1 - 0.15, v);
    const i = this.colliders.findIndex((k) => Math.hypot(k.x - c.x, k.z - c.z) < 0.2);
    if (i >= 0) this.colliders.splice(i, 1);
  }

  /** Shut and locked again (after a death undoes it). */
  resetVault() {
    const vs = this.vault;
    if (vs.state !== 'locked') {
      const v = VAULT;
      this.rect(v.door0, v.z1 - 0.3, v.door1, v.z1);
    }
    vs.state = 'locked';
    vs.t = 0;
    vs.refused = 0;
    vs.door.position.x = (VAULT.door0 + VAULT.door1) / 2;
  }
}
