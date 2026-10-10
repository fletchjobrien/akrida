import { BoxGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, Object3D, Vector2, Vector3, type BufferGeometry, type Material, type ShaderMaterial } from 'three';
import type { Creature, World } from '../character/Creature';
import type { FootPose, HandPose, ScriptPose } from '../character/scriptPose';
import { toonMaterial } from '../render/shared';
import { PALETTE, rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { terrainHeight } from '../world/terrain';
import type { Dust } from '../world/particles';
import { pushOutOfRock } from '../world/rocks';
import type { AudioEngine } from '../audio/AudioEngine';

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({ x, z, lift, tilt, pitch, poleDown });

/** Thrown through the air: limbs flung out, head snapped back. */
const FLUNG: ScriptPose = {
  tremble: 0,
  exertion: 0,
  eyeOpen: 0.3,
  pelvisX: 0,
  pelvisY: 0.45,
  pelvisZ: 0,
  pelvisPitch: 0,
  pelvisYaw: 0,
  pelvisRoll: 0,
  spinePitch: -0.4,
  chestPitch: -0.3,
  chestRoll: 0.2,
  neckPitch: -0.7,
  headPitch: -0.8,
  headYaw: 0.5,
  headRoll: 0.3,
  handL: hand(0, 0, 0, 0),
  handR: hand(0, 0, 0, 0),
  armPitch: -2.3,
  elbow: -0.2,
  armOut: 1.3,
  footL: foot(0.3, 0.45, 0.4, 0.4, 0.6, -1),
  footR: foot(-0.3, -0.3, 0.3, -0.4, -0.5, 1),
};

/** Where it came to rest: twisted half onto its side, back arched, head wrenched round and back. */
const BROKEN: ScriptPose = {
  tremble: 0,
  exertion: 0,
  eyeOpen: 0.45,
  pelvisX: 0,
  pelvisY: 0.13,
  pelvisZ: 0,
  pelvisPitch: -1.38,
  pelvisYaw: 0.75,
  pelvisRoll: 0.15,
  spinePitch: -0.28,
  chestPitch: -0.22,
  chestRoll: 0.45,
  neckPitch: -0.55,
  headPitch: -0.75,
  headYaw: 1.35,
  headRoll: 0.65,
  handL: hand(0.55, 0.03, 0.2),
  handR: hand(-0.25, 0.03, -0.32),
  armPitch: -1.2,
  elbow: -0.2,
  armOut: 1.0,
  footL: foot(0.55, 0.45, 0, 0.7, 0.4, -1),
  footR: foot(-0.12, 0.78, 0.04, -0.9, 1.0, 0.6),
};

/** Down on its back where it fell, the stump in the air, eyes wide. */
const DOWN: ScriptPose = {
  ...BROKEN,
  tremble: 0.7,
  exertion: 1,
  eyeOpen: 1,
  pelvisYaw: 0.3,
  pelvisRoll: 0.05,
  spinePitch: -0.15,
  chestPitch: -0.1,
  chestRoll: 0.15,
  neckPitch: -0.3,
  headPitch: -0.35,
  headYaw: 0.5,
  headRoll: 0.25,
  handL: hand(0.42, 0.12, -0.15),
  handR: hand(-0.38, 0.03, -0.2),
  footL: foot(0.3, 0.55, 0, 0.5, 0.3, -0.8),
  footR: foot(-0.26, 0.62, 0, 0.4, 0.3, -0.8),
};

/** Curled onto its side away from the stump, knees drawn up, its hand clamped over the wound. */
const CLUTCH: ScriptPose = {
  ...DOWN,
  pelvisY: 0.16,
  pelvisPitch: -1.25,
  pelvisYaw: -1.0,
  spinePitch: 0.45,
  chestPitch: 0.35,
  chestRoll: -0.2,
  neckPitch: 0.45,
  headPitch: 0.35,
  headYaw: 0.4,
  headRoll: -0.2,
  handL: hand(0.2, 0.32, -0.1),
  handR: hand(0.14, 0.34, -0.22),
  footL: foot(0.2, 0.32, 0.12, 0.9, 0.9, -1),
  footR: foot(-0.12, 0.28, 0.02, 0.9, 0.9, -1),
};

/** Thrashing on its back: the spine bowed, head thrown back, legs kicking. */
const THRASH: ScriptPose = {
  ...DOWN,
  pelvisY: 0.15,
  pelvisYaw: 0.1,
  spinePitch: -0.45,
  chestPitch: -0.35,
  neckPitch: -0.6,
  headPitch: -0.6,
  headYaw: 0,
  handL: hand(0.45, 0.35, -0.3),
  handR: hand(-0.45, 0.3, -0.35),
  footL: foot(0.28, 0.6, 0.15, 0.4, 0.3, -0.5),
  footR: foot(-0.25, 0.55, 0.15, 0.4, 0.3, -0.5),
};

/** Trying to get up: propped on its one hand, half sat up, knees bent under it. */
const RISE: ScriptPose = {
  ...DOWN,
  pelvisY: 0.2,
  pelvisPitch: -0.75,
  pelvisYaw: -0.15,
  spinePitch: 0.15,
  chestPitch: 0.2,
  chestRoll: -0.15,
  neckPitch: 0.25,
  headPitch: 0.2,
  headYaw: 0.3,
  headRoll: 0,
  handL: hand(0.3, 0.3, 0.05),
  handR: hand(-0.32, 0.02, -0.12),
  footL: foot(0.22, 0.45, 0.04, 0.5, 0.6, -0.3),
  footR: foot(-0.2, 0.5, 0.02, 0.5, 0.6, -0.3),
};

/** Lifted on its back to look at what is left of its arm, frozen with shock. */
const STARE: ScriptPose = {
  ...DOWN,
  pelvisY: 0.15,
  pelvisPitch: -1.2,
  pelvisYaw: 0.15,
  spinePitch: 0.25,
  chestPitch: 0.3,
  neckPitch: 0.45,
  headPitch: 0.25,
  headYaw: 1.0,
  headRoll: 0.2,
  handL: hand(0.3, 0.42, -0.05),
  handR: hand(0.02, 0.4, -0.12),
};

/** Dead: slack on its back, half turned, the head rolled aside, the eyes half open. */
const STILL: ScriptPose = {
  ...BROKEN,
  tremble: 0,
  exertion: 0,
  eyeOpen: 0.35,
  pelvisYaw: 0.45,
  spinePitch: 0.05,
  chestPitch: 0.02,
  chestRoll: 0.25,
  neckPitch: -0.15,
  headPitch: -0.2,
  headYaw: 1.2,
  headRoll: 0.45,
  handL: hand(0.38, 0.03, -0.2),
  handR: hand(-0.4, 0.03, -0.3),
  footL: foot(0.36, 0.62, 0, 0.3, 0, -1),
  footR: foot(-0.3, 0.58, 0.02, 0.3, 0.3, -0.7),
};

type Act = 'fly' | 'land' | 'clutch' | 'thrash' | 'rise' | 'collapse' | 'stare' | 'fade' | 'dead';

type Numeric = { [k: string]: number | Numeric };

/** Every number in `pose` pulled toward `target` by a damped spring (stiffness `k`, damping `d`). */
function spring(pose: Numeric, target: Numeric, vel: Numeric, dt: number, k: number, d: number) {
  for (const key of Object.keys(target)) {
    const t = target[key];
    if (typeof t === 'number') {
      const v = ((vel[key] as number) ?? 0) + ((t - (pose[key] as number)) * k - ((vel[key] as number) ?? 0) * d) * dt;
      vel[key] = v;
      pose[key] = (pose[key] as number) + v * dt;
    } else {
      if (typeof vel[key] !== 'object') vel[key] = {};
      spring(pose[key] as Numeric, t, vel[key] as Numeric, dt, k, d);
    }
  }
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
function blend(out: Numeric, a: Numeric, b: Numeric, t: number) {
  for (const k of Object.keys(a)) {
    const av = a[k];
    const bv = b[k];
    if (typeof av === 'number') out[k] = av + ((bv as number) - av) * t;
    else {
      if (typeof out[k] !== 'object') out[k] = {};
      blend(out[k] as Numeric, av, bv as Numeric, t);
    }
  }
}

const C = (hex: number) => rgb(hex).toArray();
const FIRE = [C(0xfffbe8), C(0xffe890), C(0xffb040), C(0xe86a20), C(0xa83418), C(0x5a2414)];
const SMOKE = C(0x2e2a28);
const PUFF = [C(0x5a4a40), C(0x4a4442), C(0x5e5856)];
const SMOKE_FADE = C(0x6e6660);
const SPARK = C(0xfff0c0);
const SPARK_COOL = C(0xe0702a);
const BLOOD = C(0x26303c);
const BLOOD_FADE = C(0x1a2028);
const GORE = C(PALETTE.furDark);
const SAND = C(PALETTE.sandMid);
const SAND_FADE = C(PALETTE.sandLit);

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

interface Ball {
  mesh: Mesh;
  mat: ShaderMaterial;
  age: number;
  life: number;
  size: number;
  vel: Vector3;
}
interface Piece {
  mesh: Object3D;
  vel: Vector3;
  spin: Vector3;
  smoke: boolean;
  bleed: boolean;
  rest: boolean;
}

/**
 * The drone strikes. A white flash; the warhead's fireball blooms and boils
 * up into black smoke; shrapnel, sparks and the drone's pieces spray out;
 * a ring of sand blasts outward along the ground; the ground is scorched.
 *
 * Time all but stops for a heartbeat, then crawls back. The creature is
 * knocked off its feet and back a body length, a forearm torn away, burnt
 * black where the blast caught it. It goes over backward, lands hard on its
 * back, bounces and slides, its joints on loose springs so it flops like a
 * rag doll. Then it is in agony for some seconds: it stares at the stump and
 * screams, thrashes, curls round the wound, tries to rise and collapses,
 * each time weaker, until it can only twitch and gasp, and dies with a
 * rattle. Blood pumps from the stump with each failing heartbeat and pools
 * in the sand; it smokes. Its ears ring and the world is far away; the colour
 * drains out of everything, the view closes in on it, and goes dark.
 */
export class Strike {
  active = false;
  /** Game time since the blast, and real time. */
  t = 0;
  private real = 0;
  /** How fast the world runs (it all but stops at the blast). */
  timeScale = 1;
  shake = 0;
  /** 0..1: the death closing in (colour, vignette, blur, zoom), and the final dark. */
  fade = 0;
  dark = 0;
  /** Over: time to go back to the checkpoint. */
  done = false;

  readonly group = new Group();
  private readonly flash = new Glow(rgb(0xfff4dc), 5, { core: 0.4 });
  private readonly fireGlow = new Glow(rgb(0xff8a30), 3, { core: 0.3 });
  private balls: Ball[] = [];
  private pieces: Piece[] = [];
  private pools: { mesh: Mesh; grow: number; delay: number; size: number }[] = [];
  private attached: Object3D[] = [];
  private hidden: Object3D[] = [];
  private creature: Creature | null = null;
  private readonly at = new Vector3();
  private readonly dir = new Vector3();
  private readonly bodyPos = new Vector3();
  private readonly bodyVel = new Vector3();
  private lift = 0;
  private landed = false;
  private bounced = false;
  private settle = 0;
  private victim: 'player' | 'other' = 'player';
  private readonly pose: ScriptPose = JSON.parse(JSON.stringify(FLUNG));
  /** What the body is trying to do: the pose follows it on springs, loose as a rag when it is knocked about. */
  private readonly target: ScriptPose = JSON.parse(JSON.stringify(FLUNG));
  private readonly out: ScriptPose = JSON.parse(JSON.stringify(FLUNG));
  private vel: Numeric = {};
  private act: Act = 'fly';
  private actT = 0;
  private actDur = 0;
  private voiceTimer = 0;
  private breathPhase = 0;
  private smokeTimer = 0;
  private bleedTimer = 0;
  private beats: number[] = [];
  private readonly stump = new Object3D();
  private readonly chestSmoke = new Object3D();
  private readonly tmp = new Vector3();
  private readonly mats: Record<string, Material>;
  private readonly world: World;
  private readonly base: World;
  private readonly push = new Vector2();

  constructor(
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    baseWorld: World,
  ) {
    const t = (dark: number, mid: number, light: number, outline = 0.6, highlight = 0.4) => toonMaterial({ dark, mid, light, litAt: 0.55, outline, highlight });
    this.mats = {
      metal: t(0x0e0f11, 0x1a1c1f, 0x2e3136, 0.8, 0.6),
      olive: t(0x22261c, 0x353a2a, 0x4c533c),
      scorch: t(0x141212, 0x1e1a18, 0x2a2420, 0, 0),
      ash: t(0x2a2624, 0x3a3532, 0x4e4844, 0, 0),
      blood: t(0x161c24, 0x1e2630, 0x28323e, 0, 0),
      charred: t(0x0e0b0a, 0x1a1412, 0x281e1a, 0.4, 0),
      raw: t(0x2a1418, 0x401c22, 0x5a2a30, 0.5, 0.2),
      limb: t(PALETTE.hoofDark, PALETTE.hoofMid, PALETTE.hoofMid, 0.6, 0.4),
      ember: toonMaterial({ dark: 0xc84a18, mid: 0xc84a18, light: 0xc84a18, unlit: true, outline: 0 }),
      smoke: t(0x1e1c1b, 0x2c2a28, 0x403c39, 0.3, 0),
    };
    this.flash.strength = 0;
    this.fireGlow.strength = 0;
    // the body is posed against the bare ground (it flies on its own arc)
    this.world = { ...baseWorld, height: (x: number, z: number) => terrainHeight(x, z) };
    this.base = baseWorld;
  }

  addTo(scene: Object3D) {
    scene.add(this.group, this.flash, this.fireGlow);
  }

  /** The blast alone, with no body thrown by it (what it hits takes care of itself). */
  blast(at: Vector3, dir: Vector3) {
    this.victim = 'other';
    this.clear();
    this.active = true;
    this.done = false;
    this.t = 0;
    this.real = 0;
    this.shake = 1;
    this.creature = null;
    this.at.copy(at);
    this.dir.set(dir.x, 0, dir.z);
    if (this.dir.lengthSq() < 0.01) this.dir.set(0, 0, 1);
    this.dir.normalize();
    this.beats = [];
    this.bleedTimer = 0;
    this.explode();
    this.audio.blast(1);
  }

  /** The blast at `at`, the drone having come along `dir`; `creature` is caught in it. */
  begin(at: Vector3, dir: Vector3, creature: Creature, victim: 'player' | 'other' = 'player') {
    this.victim = victim;
    this.clear();
    this.active = true;
    this.done = false;
    this.t = 0;
    this.real = 0;
    this.shake = 1;
    this.fade = 0;
    this.dark = 0;
    this.creature = creature;
    this.at.copy(at);
    // thrown along the way the drone came, away from the blast
    this.dir.set(dir.x, 0, dir.z);
    if (this.dir.lengthSq() < 0.01) this.dir.set(creature.pos.x - at.x, 0, creature.pos.z - at.z);
    if (this.dir.lengthSq() < 0.01) this.dir.set(0, 0, 1);
    this.dir.normalize();
    this.bodyPos.copy(creature.pos);
    // knocked off its feet and back a body length or so, not launched
    this.bodyVel.copy(this.dir).multiplyScalar(3.2);
    this.bodyVel.y = 3.4;
    this.lift = 0;
    this.landed = false;
    this.bounced = false;
    this.settle = 0;
    blend(this.pose as unknown as Numeric, FLUNG as unknown as Numeric, FLUNG as unknown as Numeric, 0);
    blend(this.target as unknown as Numeric, DOWN as unknown as Numeric, DOWN as unknown as Numeric, 0);
    this.pose.pelvisPitch = -0.2;
    this.vel = {};
    // the blast snaps it over backward and flings its limbs about
    this.vel.pelvisPitch = -7;
    this.vel.spinePitch = -4;
    this.vel.neckPitch = -6;
    this.vel.headYaw = 5;
    this.vel.armPitch = -8;
    this.act = 'fly';
    this.actT = 0;
    this.voiceTimer = 0.35;
    this.breathPhase = 0;
    // facing the blast, so it goes over backward
    creature.setYaw(Math.atan2(-this.dir.x, -this.dir.z));
    // its heart races, then falters and slows as it bleeds out
    this.beats = [0.7, 1.15, 1.6, 2.05, 2.5, 3.0, 3.5, 4.1, 4.8, 5.6, 6.5, 7.6, 8.9];
    this.bleedTimer = 0;
    this.maim(creature);
    this.explode();
    this.audio.blast(1);
    if (victim === 'player') this.audio.deafen(1);
  }

  /** What the blast does to the body: a forearm torn off, burns, a smouldering chest. */
  private maim(c: Creature) {
    const rig = c.rig;
    const arm = rig.arms[0];
    arm.elbow.visible = false;
    this.hidden.push(arm.elbow);
    // the stump: raw, and burnt at its edge
    const stump = new Mesh(faceted(new BoxGeometry(0.1, 0.06, 0.1)), this.mats.raw);
    stump.position.copy(arm.elbow.position);
    arm.shoulder.add(stump);
    const crust = new Mesh(faceted(new BoxGeometry(0.11, 0.025, 0.11)), this.mats.charred);
    crust.position.set(0, 0.025, 0);
    stump.add(crust);
    this.attached.push(stump);
    this.stump.position.set(0, -0.03, 0);
    stump.add(this.stump);
    // burnt black down its front and across its face, embers in the fur
    const burn = (parent: Object3D, w: number, h: number, x: number, y: number, z: number, spin: number) => {
      const b = new Mesh(faceted(new BoxGeometry(w, h, 0.02)), this.mats.charred);
      b.position.set(x, y, z);
      b.rotation.z = spin;
      parent.add(b);
      this.attached.push(b);
      const e = new Mesh(faceted(new BoxGeometry(0.022, 0.022, 0.012)), this.mats.ember);
      e.position.set(x + w * 0.2, y - h * 0.1, z * 1.08);
      parent.add(e);
      this.attached.push(e);
    };
    burn(rig.chest, 0.22, 0.2, 0.02, 0.1, 0.13, 0.3);
    burn(rig.chest, 0.12, 0.1, -0.08, 0.2, 0.135, -0.5);
    burn(rig.head, 0.16, 0.1, 0.06, 0.08, 0.13, 0.2);
    this.chestSmoke.position.set(0, 0.12, 0.15);
    rig.chest.add(this.chestSmoke);
    this.attached.push(this.chestSmoke);
    // the torn-off forearm, flung clear, bleeding
    const limb = new Group();
    const fore = new Mesh(faceted(new BoxGeometry(0.085, 0.2, 0.085)), this.mats.limb);
    limb.add(fore);
    const hoof = new Mesh(faceted(new BoxGeometry(0.095, 0.08, 0.095)), this.mats.limb);
    hoof.position.y = -0.13;
    limb.add(hoof);
    const end = new Mesh(faceted(new BoxGeometry(0.09, 0.04, 0.09)), this.mats.raw);
    end.position.y = 0.11;
    limb.add(end);
    for (const m of [fore, hoof, end]) m.layers.enable(SHADOW_LAYER);
    arm.elbow.getWorldPosition(limb.position);
    this.group.add(limb);
    const side = new Vector3(-this.dir.z, 0, this.dir.x);
    this.pieces.push({
      mesh: limb,
      vel: this.dir.clone().multiplyScalar(2.2).addScaledVector(side, 1.6).setY(4.2),
      spin: new Vector3(11, 5, 7),
      smoke: false,
      bleed: true,
      rest: false,
    });
  }

  private explode() {
    const A = this.at;
    const ground = terrainHeight(A.x, A.z);
    const M = this.mats;
    // the flash, and the fire's glow
    this.flash.position.copy(A);
    this.flash.strength = 4;
    this.fireGlow.position.copy(A);
    this.fireGlow.strength = 1.6;
    // the fireball: lumps of fire that bloom, boil and blacken into smoke
    for (let k = 0; k < 14; k++) {
      const mat = toonMaterial({ dark: 0xffffff, mid: 0xffffff, light: 0xffffff, unlit: true, outline: 0 });
      const mesh = new Mesh(new IcosahedronGeometry(1, 1), mat);
      const off = new Vector3((Math.random() - 0.5) * 0.7, Math.random() * 0.45, (Math.random() - 0.5) * 0.7);
      mesh.position.copy(A).add(off);
      mesh.scale.setScalar(0.01);
      this.group.add(mesh);
      this.balls.push({ mesh, mat, age: -Math.random() * 0.12, life: 0.7 + Math.random() * 0.7, size: 0.25 + Math.random() * 0.4, vel: off.multiplyScalar(4).setY(1 + Math.random() * 2.5) });
    }
    // fire flung out, shrapnel and sparks, the blast's smoke
    for (let i = 0; i < 110; i++) {
      const v = new Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.15, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 8);
      const c = FIRE[Math.min(FIRE.length - 1, Math.floor(Math.random() * 4))];
      this.dust.spawn(A.x, A.y, A.z, v.x, v.y, v.z, 0.25 + Math.random() * 0.55, c, 2 + Math.floor(Math.random() * 3), { g: -1.5, drag: 4.5, windK: 0.1, c2: FIRE[5] });
    }
    for (let i = 0; i < 70; i++) {
      const v = new Vector3(Math.random() - 0.5, Math.random() * 0.9 - 0.1, Math.random() - 0.5).normalize().multiplyScalar(7 + Math.random() * 14);
      this.dust.spawn(A.x, A.y, A.z, v.x, v.y, v.z, 0.5 + Math.random() * 1.1, SPARK, 1, { g: 12, drag: 0.6, windK: 0, c2: SPARK_COOL });
    }
    for (let i = 0; i < 45; i++) {
      const v = new Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize().multiplyScalar(1 + Math.random() * 3);
      this.dust.spawn(A.x, A.y, A.z, v.x, v.y + 0.5, v.z, 2.5 + Math.random() * 3, SMOKE, 3, { g: -0.5, drag: 1.4, windK: 0.6, c2: SMOKE_FADE, soft: true });
    }
    // a ring of sand blasted out along the ground
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2 + Math.random() * 0.1;
      const s = 6 + Math.random() * 6;
      this.dust.spawn(A.x + Math.cos(a) * 0.4, ground + 0.1, A.z + Math.sin(a) * 0.4, Math.cos(a) * s, 0.4 + Math.random() * 1.5, Math.sin(a) * s, 0.8 + Math.random() * 0.8, SAND, 2, { g: 2, drag: 3, windK: 0.3, c2: SAND_FADE, soft: true });
    }
    // blood and flesh sprayed from where it caught the creature
    const c = this.creature ? this.creature.pos : this.at;
    for (let i = 0; i < (this.creature ? 80 : 0); i++) {
      const v = new Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).multiplyScalar(5).addScaledVector(this.dir, 4 + Math.random() * 5);
      this.dust.spawn(c.x, c.y + 0.5, c.z, v.x, v.y + 1, v.z, 0.7 + Math.random() * 0.8, i % 5 === 0 ? GORE : BLOOD, i % 7 === 0 ? 2 : 1, { g: 11, drag: 0.4, windK: 0, c2: BLOOD_FADE });
    }
    // the ground scorched black in ragged blotches, burnt dashes flung out round it
    if (A.y - ground < 2.5) {
      const r = 1.0 * (1 - (A.y - ground) / 3.2);
      for (let k = 0; k < 14; k++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * r * 0.75;
        const br = r * (0.18 + Math.random() * 0.3) * (1 - d / (r * 1.4));
        const x = A.x + Math.cos(a) * d;
        const z = A.z + Math.sin(a) * d;
        const sc = new Mesh(new CylinderGeometry(br, br, 0.008, 6), k % 4 === 0 ? M.ash : M.scorch);
        sc.position.set(x, terrainHeight(x, z) + 0.01 + k * 0.0004, z);
        sc.rotation.y = Math.random() * 3;
        sc.scale.set(1 + Math.random() * 0.5, 1, 0.7 + Math.random() * 0.4);
        this.group.add(sc);
      }
      for (let k = 0; k < 26; k++) {
        const a = Math.random() * Math.PI * 2;
        const d = r * (0.8 + Math.random() * 0.9);
        const len = 0.08 + Math.random() * 0.22;
        const x = A.x + Math.cos(a) * d;
        const z = A.z + Math.sin(a) * d;
        const st = new Mesh(new BoxGeometry(0.035, 0.008, len), M.scorch);
        st.position.set(x, terrainHeight(x, z) + 0.011, z);
        st.rotation.y = Math.atan2(Math.cos(a), Math.sin(a));
        this.group.add(st);
      }
    }
    // the drone's pieces, some of them burning
    const parts: [BufferGeometry, Material, boolean][] = [
      [new BoxGeometry(0.035, 0.025, 0.3), M.metal, true],
      [new BoxGeometry(0.035, 0.025, 0.22), M.metal, false],
      [new BoxGeometry(0.3, 0.006, 0.035), M.metal, false],
      [new BoxGeometry(0.2, 0.006, 0.035), M.metal, false],
      [new CylinderGeometry(0.035, 0.04, 0.07, 6), M.metal, true],
      [new CylinderGeometry(0.035, 0.04, 0.07, 6), M.metal, false],
      [new BoxGeometry(0.12, 0.04, 0.1), M.olive, true],
      [new BoxGeometry(0.08, 0.03, 0.14), M.metal, false],
    ];
    for (const [g, m, smoke] of parts) {
      const mesh = new Mesh(faceted(g), m);
      mesh.layers.enable(SHADOW_LAYER);
      mesh.position.copy(A);
      this.group.add(mesh);
      const v = new Vector3(Math.random() - 0.5, 0.4 + Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(5 + Math.random() * 7);
      this.pieces.push({ mesh, vel: v, spin: new Vector3(Math.random() * 30, Math.random() * 30, Math.random() * 30), smoke, bleed: false, rest: false });
    }
  }

  /** Run the strike on `dt` of real time. */
  update(dt: number) {
    if (!this.active) return;
    this.real += dt;
    // time all but stops at the blast, then crawls back
    this.timeScale = this.real < 0.12 ? 0.04 : Math.min(1, 0.12 + (this.real - 0.12) * 0.55);
    const g = dt * this.timeScale;
    this.t += g;
    const t = this.t;
    this.shake = Math.max(0, this.shake - dt * 0.9);
    this.flash.strength = Math.max(0, 4 * (1 - this.real / 0.35));
    this.fireGlow.strength = Math.max(0, 1.6 * (1 - t / 1.4)) * (0.8 + 0.2 * Math.random());

    this.updateBalls(g);
    this.updatePieces(g);
    if (this.creature) this.updateBody(g);

    // smoke keeps rising from the blast, thinning out
    this.smokeTimer -= g;
    if (this.smokeTimer <= 0 && t < 12) {
      this.smokeTimer = 0.06 + t * 0.03;
      const ground = terrainHeight(this.at.x, this.at.z);
      this.dust.spawn(this.at.x + (Math.random() - 0.5) * 0.6, ground + 0.2, this.at.z + (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.3, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.3, 3 + Math.random() * 2, SMOKE, 3, {
        g: -0.4,
        drag: 0.8,
        windK: 0.9,
        c2: SMOKE_FADE,
        soft: true,
      });
      // and from the body
      this.chestSmoke.getWorldPosition(this.tmp);
      if (this.creature && Math.random() < 0.6) {
        this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, (Math.random() - 0.5) * 0.15, 0.4 + Math.random() * 0.3, (Math.random() - 0.5) * 0.15, 2 + Math.random() * 1.5, SMOKE, 2, {
          g: -0.3,
          drag: 0.8,
          windK: 0.8,
          c2: SMOKE_FADE,
          soft: true,
        });
      }
    }
    // its last heartbeats: each one slower and fainter, each one pumping blood from the stump
    if (this.beats.length && t > this.beats[0]) {
      const n = this.beats.length;
      this.beats.shift();
      if (this.victim === 'player') this.audio.heartbeat(0.25 * Math.min(1, n / 8));
      this.bleedTimer = 0.25;
    }
    if (this.bleedTimer > 0 && this.creature) {
      this.bleedTimer -= g;
      this.stump.getWorldPosition(this.tmp);
      for (let i = 0; i < 3; i++) {
        this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, (Math.random() - 0.5) * 1.2, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 1.2, 0.6, BLOOD, 1, { g: 10, drag: 0.3, windK: 0 });
      }
    }
    // pools spread in the sand under it
    for (const p of this.pools) {
      if (p.delay > 0) {
        p.delay -= g;
        continue;
      }
      p.grow = Math.min(1, p.grow + g * 0.3);
      const s = p.size * Math.sqrt(p.grow);
      p.mesh.scale.set(s * 1.3, 1, s * 0.85);
    }

    // the end closes in: colour gone, the edges dark, then all dark
    this.fade = Math.min(1, Math.max(0, (t - 4.5) / 5.5));
    this.dark = Math.min(1, Math.max(0, (t - 10.6) / 1.6));
    if (t > 12.4) this.done = true;
  }

  private updateBalls(g: number) {
    for (const b of this.balls) {
      b.age += g;
      if (b.age < 0) continue;
      const k = b.age / b.life;
      if (k >= 1) {
        b.mesh.visible = false;
        continue;
      }
      // blooms fast, then boils upward, swelling as it cools into smoke
      const grow = Math.min(1, b.age / 0.09);
      // boils up, then thins away to nothing as smoke
      b.mesh.scale.setScalar(Math.max(0.01, b.size * grow * (1 + k * 0.9) * (k > 0.55 ? Math.max(0, 1 - (k - 0.55) / 0.45) : 1)));
      b.mesh.position.addScaledVector(b.vel, g);
      b.vel.multiplyScalar(Math.exp(-g * 3));
      b.vel.y += g * 1.2;
      // it boils: each lump flickers a step hotter or cooler as it burns down
      let c = k < 0.1 ? 0 : k < 0.2 ? 1 : k < 0.3 ? 2 : k < 0.4 ? 3 : k < 0.5 ? 4 : k < 0.6 ? 5 : k < 0.75 ? 6 : 7;
      if (c > 0 && c < 6 && Math.random() < 0.3) c += Math.random() < 0.5 ? -1 : 1;
      const col = c < 6 ? FIRE[c] : PUFF[c - 5];
      (b.mat.uniforms.uLight.value as Vector3).set(col[0], col[1], col[2]);
    }
  }

  private updatePieces(g: number) {
    for (const p of this.pieces) {
      if (p.rest) continue;
      p.vel.y -= 18 * g;
      p.mesh.position.addScaledVector(p.vel, g);
      p.mesh.rotation.x += p.spin.x * g;
      p.mesh.rotation.y += p.spin.y * g;
      p.mesh.rotation.z += p.spin.z * g;
      const ground = terrainHeight(p.mesh.position.x, p.mesh.position.z);
      if (p.mesh.position.y < ground + 0.03) {
        p.mesh.position.y = ground + 0.03;
        if (p.vel.y < -2) {
          // bounce, kicking up sand
          p.vel.y *= -0.3;
          p.vel.x *= 0.5;
          p.vel.z *= 0.5;
          p.spin.multiplyScalar(0.5);
          this.dust.kick(p.mesh.position.x, ground, p.mesh.position.z, p.vel.x, p.vel.z, 3, 0.6);
        } else {
          p.rest = true;
          p.mesh.rotation.x = Math.round(p.mesh.rotation.x / Math.PI) * Math.PI;
          p.mesh.rotation.z = Math.round(p.mesh.rotation.z / Math.PI) * Math.PI;
          if (p.bleed) this.pool(p.mesh.position.x, p.mesh.position.z, 0.22, 0);
        }
      }
      if (p.smoke && Math.random() < 0.5) {
        const q = p.mesh.position;
        this.dust.spawn(q.x, q.y, q.z, 0, 0.3, 0, 1.2, SMOKE, 1, { g: -0.3, drag: 1, windK: 0.6, c2: SMOKE_FADE, soft: true });
      }
      if (p.bleed && Math.random() < 0.7) {
        const q = p.mesh.position;
        this.dust.spawn(q.x, q.y, q.z, p.vel.x * 0.2, 0, p.vel.z * 0.2, 0.5, BLOOD, 1, { g: 10, drag: 0.5, windK: 0 });
      }
    }
    // the burning pieces go on smoking where they lie
    if (Math.random() < 0.3) {
      for (const p of this.pieces) {
        if (!p.smoke || !p.rest || this.t > 7) continue;
        const q = p.mesh.position;
        this.dust.spawn(q.x, q.y + 0.05, q.z, (Math.random() - 0.5) * 0.1, 0.35, (Math.random() - 0.5) * 0.1, 2, SMOKE, 2, { g: -0.2, drag: 0.6, windK: 0.8, c2: SMOKE_FADE, soft: true });
      }
    }
  }

  /** A pool of blood spreading in the sand at (x, z), `size` across, starting after `delay`. */
  private pool(x: number, z: number, size: number, delay: number) {
    const mesh = new Mesh(new CylinderGeometry(1, 1.08, 0.01, 8), this.mats.blood);
    mesh.position.set(x, terrainHeight(x, z) + 0.009 + this.pools.length * 0.0007, z);
    mesh.rotation.y = Math.random() * 3;
    mesh.scale.set(0.01, 1, 0.01);
    this.group.add(mesh);
    this.pools.push({ mesh, grow: 0, delay, size });
  }

  private updateBody(g: number) {
    const c = this.creature!;
    const P = this.bodyPos;
    const V = this.bodyVel;
    const ground = terrainHeight(P.x, P.z);
    if (!this.landed) {
      V.y -= 24 * g;
      P.addScaledVector(V, g);
      this.lift = Math.max(0, P.y - ground);
      if (P.y <= ground) {
        P.y = ground;
        if (!this.bounced) {
          // slams down on its back and bounces a little, limbs flopping
          this.bounced = true;
          V.y = -V.y * 0.22;
          V.x *= 0.5;
          V.z *= 0.5;
          this.audio.thud(0.55);
          this.knock(1);
          this.dust.kick(P.x, ground, P.z, V.x, V.z, 10, 1.2);
          for (let i = 0; i < 20; i++) {
            const a = Math.random() * Math.PI * 2;
            this.dust.spawn(P.x, ground + 0.05, P.z, Math.cos(a) * 2, 0.6 + Math.random(), Math.sin(a) * 2, 0.6 + Math.random() * 0.5, BLOOD, 1, { g: 10, drag: 0.4, windK: 0 });
          }
        } else {
          this.landed = true;
          this.audio.thud(0.3);
          this.knock(0.5);
          this.dust.kick(P.x, ground, P.z, V.x, V.z, 6, 0.8);
          this.setAct('land', 0.55);
        }
      }
    } else {
      // a short slide through the sand, leaving a smear
      const sp = Math.hypot(V.x, V.z);
      if (sp > 0.05) {
        const k = Math.max(0, sp - 9 * g) / sp;
        V.x *= k;
        V.z *= k;
        P.x += V.x * g;
        P.z += V.z * g;
        if (Math.random() < 0.6) this.dust.kick(P.x, ground, P.z, V.x, V.z, 1, 0.5);
        if (Math.random() < 0.35) this.pool(P.x - V.x * 0.05, P.z - V.z * 0.05, 0.1 + Math.random() * 0.06, 0);
      } else if (this.settle === 0) {
        this.settle = 0.0001;
        // and it bleeds out where it lies
        const side = new Vector3(-this.dir.z, 0, this.dir.x);
        this.pool(P.x, P.z, 0.75, 0.6);
        this.pool(P.x + side.x * 0.45 + this.dir.x * 0.25, P.z + side.z * 0.45 + this.dir.z * 0.25, 0.42, 1.6);
        this.pool(P.x - side.x * 0.4 - this.dir.x * 0.1, P.z - side.z * 0.4 - this.dir.z * 0.1, 0.32, 3);
        this.pool(P.x + this.dir.x * 0.7, P.z + this.dir.z * 0.7, 0.2, 4.5);
      }
      P.y = ground;
      this.lift = 0;
    }
    this.agony(g);
    // the pose: the body follows what it is trying to do, loosely while it is thrown about
    const loose = this.act === 'fly' || this.act === 'land' || this.act === 'collapse';
    const [k, d] = loose ? [55, 5] : this.act === 'fade' ? [30, 7] : this.act === 'dead' ? [20, 8] : [170, 11];
    // in small steps, so the springs stay steady
    const n = Math.max(1, Math.ceil(g / (1 / 120)));
    for (let i = 0; i < n; i++) spring(this.pose as unknown as Numeric, this.target as unknown as Numeric, this.vel, g / n, k, d);
    blend(this.out as unknown as Numeric, this.pose as unknown as Numeric, this.pose as unknown as Numeric, 0);
    this.out.pelvisY += this.lift;
    this.out.footL.lift += this.lift;
    this.out.footR.lift += this.lift;
    // walls and rocks stop it dead: it slams into them and drops
    for (const r of this.base.rocks) {
      if (r.radius < 0.3 || !pushOutOfRock(r, P, 0.3, this.push)) continue;
      const into = V.x * this.push.x + V.z * this.push.y;
      if (into < 0) {
        V.x -= this.push.x * into * 1.15;
        V.z -= this.push.y * into * 1.15;
        V.x *= 0.3;
        V.z *= 0.3;
        if (into < -2) {
          this.audio.thud(0.5);
          this.knock(0.7);
          for (let i = 0; i < 12; i++) this.dust.spawn(P.x, P.y + 0.5, P.z, (Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2, 0.6, BLOOD, 1, { g: 10, drag: 0.4, windK: 0 });
        }
      }
    }
    c.pos.x = P.x;
    c.pos.z = P.z;
    // its breathing: fast, ragged panting, slowing to gasps, then none
    const rate = this.act === 'dead' ? 0 : this.act === 'fade' ? 1.4 - smooth(0, this.actDur, this.actT) * 1.1 : 1.7;
    this.breathPhase += g * rate;
    const amp = this.act === 'dead' ? 0 : this.act === 'fade' ? 2.2 - smooth(0, this.actDur, this.actT) * 1.4 : 2.4;
    c.scriptBreath = { value: Math.sin(this.breathPhase * Math.PI * 2), amp };
    c.updateScripted(g, this.out, this.world);
  }

  /** A blow to the body: every joint jolted, as a rag would be. */
  private knock(s: number) {
    const v = this.vel as Record<string, number | Numeric>;
    const kick = (key: string, a: number) => (v[key] = ((v[key] as number) ?? 0) + (Math.random() - 0.5) * 2 * a * s);
    kick('spinePitch', 6);
    kick('chestPitch', 6);
    kick('chestRoll', 6);
    kick('neckPitch', 10);
    kick('headPitch', 10);
    kick('headYaw', 12);
    kick('headRoll', 10);
    kick('pelvisYaw', 4);
    kick('pelvisRoll', 3);
    kick('armPitch', 10);
    kick('armOut', 8);
    for (const f of ['footL', 'footR']) {
      if (typeof v[f] !== 'object') v[f] = {};
      const fv = v[f] as Record<string, number>;
      fv.lift = (fv.lift ?? 0) + Math.random() * 2.5 * s;
      fv.x = (fv.x ?? 0) + (Math.random() - 0.5) * 3 * s;
      fv.z = (fv.z ?? 0) + (Math.random() - 0.5) * 3 * s;
    }
  }

  private setAct(act: Act, dur: number) {
    this.act = act;
    this.actT = 0;
    this.actDur = dur;
  }

  /**
   * After the fall: it is alive, and knows what has happened to it. It
   * screams, curls round its stump clutching at it, thrashes on its back,
   * tries to get up and collapses, lifts its head to stare at the stump; all
   * of it weaker as it bleeds out, until it can only twitch and gasp, and then
   * it is still.
   */
  private agony(g: number) {
    this.actT += g;
    const t = this.t;
    const T = this.target;
    const time = this.real;
    // how much fight is left in it
    const w = 1 - smooth(4.2, 7.0, t);
    const lv = this.victim === 'player' ? 1 : 0.35;
    switch (this.act) {
      case 'fly':
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, DOWN as unknown as Numeric, 0);
        T.eyeOpen = 1;
        break;
      case 'land':
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, DOWN as unknown as Numeric, 0);
        T.tremble = 0.4;
        if (this.actT >= this.actDur) this.nextAgony();
        break;
      case 'clutch': {
        // curled round the wound, rocking, the hand clamped on it
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, CLUTCH as unknown as Numeric, smooth(0, 0.35, this.actT));
        T.pelvisYaw += Math.sin(time * 3.2) * 0.14 * w;
        T.spinePitch += Math.sin(time * 3.2) * 0.1 * w;
        T.handR.x += Math.sin(time * 17) * 0.015;
        T.footL.z += Math.sin(time * 4.1) * 0.06 * w;
        T.footR.z += Math.sin(time * 4.1 + 2) * 0.06 * w;
        T.tremble = 0.5 + 0.5 * w;
        if (this.actT >= this.actDur) this.nextAgony();
        break;
      }
      case 'thrash': {
        // on its back, bucking: the head whipping side to side, the legs kicking at nothing
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, THRASH as unknown as Numeric, smooth(0, 0.2, this.actT) * w);
        T.headYaw += Math.sin(time * 6.5) * 1.1 * w;
        T.headRoll += Math.sin(time * 5.1) * 0.3 * w;
        T.spinePitch += Math.sin(time * 7.3) * 0.2 * w;
        T.pelvisYaw += Math.sin(time * 4.3) * 0.3 * w;
        T.footL.lift += Math.max(0, Math.sin(time * 9)) * 0.28 * w;
        T.footR.lift += Math.max(0, Math.sin(time * 9 + Math.PI)) * 0.28 * w;
        T.footL.z += Math.sin(time * 9) * 0.18 * w;
        T.footR.z += Math.sin(time * 9 + Math.PI) * 0.18 * w;
        T.handR.x += Math.sin(time * 5) * 0.15 * w;
        T.handR.y += Math.sin(time * 6.3) * 0.12 * w;
        T.handR.z += Math.cos(time * 5) * 0.2 * w;
        T.handL.y += Math.sin(time * 7.7) * 0.1 * w;
        T.tremble = 0.8 * w + 0.2;
        if (this.actT >= this.actDur) this.nextAgony();
        break;
      }
      case 'rise': {
        // it tries to get up: rolls, plants its hand, heaves itself half up, shaking ...
        const k = smooth(0, this.actDur * 0.75, this.actT) * (0.5 + 0.5 * w);
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, RISE as unknown as Numeric, k);
        T.tremble = 0.6 + k * 0.6;
        T.chestRoll += Math.sin(time * 13) * 0.05 * k;
        if (this.actT >= this.actDur) {
          // ... and the arm gives
          this.setAct('collapse', 0.7);
          this.knock(0.35);
          this.audio.thud(0.25);
          this.cry(lv, 'cry');
        }
        break;
      }
      case 'collapse':
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, DOWN as unknown as Numeric, 0);
        T.tremble = 0.7;
        if (this.actT >= this.actDur) this.nextAgony();
        break;
      case 'stare': {
        // it lifts its head and sees: frozen, shaking, the hand hovering over the stump
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, STARE as unknown as Numeric, smooth(0, 0.5, this.actT) * (0.6 + 0.4 * w));
        T.headPitch += Math.sin(time * 19) * 0.03;
        T.handR.y += Math.sin(time * 15) * 0.02;
        T.eyeOpen = 1;
        T.tremble = 1;
        if (this.actT > 0.6 && this.actT - g <= 0.6) this.cry(lv, 'scream');
        if (this.actT >= this.actDur) this.nextAgony();
        break;
      }
      case 'fade': {
        // too weak to move: twitches, a leg that drags, the eyes closing
        const k = smooth(0, this.actDur, this.actT);
        blend(T as unknown as Numeric, DOWN as unknown as Numeric, STILL as unknown as Numeric, k);
        const twitch = Math.max(0, Math.sin(time * 2.3) * Math.sin(time * 5.1) - 0.4) * (1 - k);
        T.footL.z += twitch * 0.12;
        T.handR.y += twitch * 0.08;
        T.headYaw += twitch * 0.2;
        T.tremble = 0.4 * (1 - k);
        T.exertion = 1 - k;
        if (this.actT >= this.actDur) {
          this.setAct('dead', 99);
          this.cry(lv, 'rattle');
        }
        break;
      }
      case 'dead':
        blend(T as unknown as Numeric, STILL as unknown as Numeric, STILL as unknown as Numeric, 0);
        break;
    }
    // its voice: screams at first, then sobbing and gasping, then wet gurgles
    if (this.act !== 'fly' && this.act !== 'dead' && this.act !== 'stare') {
      this.voiceTimer -= g;
      if (this.voiceTimer <= 0) {
        const kinds: ('scream' | 'cry' | 'sob' | 'gasp' | 'gurgle')[] =
          t < 2.6 ? ['scream', 'scream', 'cry'] : t < 5 ? ['cry', 'sob', 'scream', 'gasp'] : this.act === 'fade' ? ['gasp', 'gurgle', 'gurgle'] : ['sob', 'gasp', 'gurgle', 'cry'];
        const kind = kinds[Math.floor(Math.random() * kinds.length)];
        this.voiceTimer = kind === 'scream' ? 1.2 + Math.random() * 0.4 : 0.6 + Math.random() * 0.8 + (this.act === 'fade' ? 0.8 : 0);
        this.cry(lv * (this.act === 'fade' ? 0.6 : 1), kind);
      }
    }
  }

  /** What it does next while it still can. */
  private nextAgony() {
    if (this.t > 6.8) {
      this.setAct('fade', 2.8);
      return;
    }
    const r = Math.random();
    const prev = this.act;
    let next: Act = r < 0.3 ? 'clutch' : r < 0.55 ? 'thrash' : r < 0.8 ? 'rise' : 'stare';
    if (next === prev) next = prev === 'thrash' ? 'clutch' : 'thrash';
    // the first thing it does is see what has happened to it
    if (prev === 'land') next = Math.random() < 0.5 ? 'thrash' : 'stare';
    const dur = next === 'clutch' ? 1.2 + Math.random() * 0.8 : next === 'thrash' ? 0.9 + Math.random() * 0.7 : next === 'rise' ? 1.1 + Math.random() * 0.5 : 1.3;
    this.setAct(next, dur);
  }

  private cry(level: number, kind: 'scream' | 'cry' | 'sob' | 'gasp' | 'gurgle' | 'rattle') {
    this.audio.agony(kind, level * 0.6);
  }

  /** Where the camera looks: the blast at first, then the body. */
  focus(out: Vector3) {
    const c = this.creature;
    if (!c) return out.copy(this.at);
    out.set(c.pos.x, c.pos.y + 0.3, c.pos.z);
    const k = Math.min(1, this.t / 0.6);
    return out.lerp(this.at, (1 - k) * 0.5);
  }

  /** Take it all away: back to before it happened. */
  clear() {
    for (const o of this.attached) o.parent?.remove(o);
    for (const o of this.hidden) o.visible = true;
    this.attached = [];
    this.hidden = [];
    for (const o of [...this.group.children]) this.group.remove(o);
    this.balls = [];
    this.pieces = [];
    this.pools = [];
    this.flash.strength = 0;
    this.fireGlow.strength = 0;
    this.active = false;
    this.done = false;
    this.timeScale = 1;
    this.shake = 0;
    this.fade = 0;
    this.dark = 0;
    if (this.creature) this.creature.scriptBreath = null;
  }
}
