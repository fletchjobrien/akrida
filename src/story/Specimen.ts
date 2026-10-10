import { BoxGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, Object3D, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { PALETTE, rgb } from '../render/palette';
import { terrainHeight } from '../world/terrain';
import { noise1 } from '../core/math';
import type { Station } from '../world/station';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const rand = (a: number, b: number) => a + Math.random() * (b - a);

const C = (hex: number) => rgb(hex).toArray();
const FLUID = C(0x4ab8ac);
const FLUID_FADE = C(0x2a6a64);
const BILE = C(0x8a9a3a);
const BILE_FADE = C(0x4a5222);
const STEAM = C(0xe8f0ee);
const STEAM_FADE = C(0xa8b4b2);
const SAND = C(PALETTE.sandMid);
const SAND_FADE = C(PALETTE.sandLit);
const BUBBLE = C(0x9af0e8);
const BLOOD = C(0x7a1010);
const BLOOD_FADE = C(0x3a0606);
const GORE = C(0x9a5a5a);

type Phase = 'tank' | 'drain' | 'settle' | 'door' | 'wake' | 'crawl' | 'outside' | 'dead';

/** What its body is doing between hauls. */
type Act = 'reach' | 'haul' | 'slump' | 'spasm' | 'collapse' | 'push' | 'retch';

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/** How big it is drawn: its parts are modelled in a unit about a creature's size, this brings them to the tank's. */
const S = 1.25;
/** Seconds out on the sand before the drone takes it. */
export const PREY_AFTER = 18;

/** A posture of the body: angles in radians, heights in the model's units. */
type Pose = {
  hipY: number;
  roll: number;
  pitch: number;
  s1: number;
  s2: number;
  twist: number;
  neck: number;
  head: number;
  headYaw: number;
  headRoll: number;
  jaw: number;
  /** The good hand, in the chest's frame, when it is not planted. */
  hx: number;
  hy: number;
  hz: number;
  stubP: number;
  stubOut: number;
  stubEl: number;
  lThigh: number;
  lOut: number;
  lKnee: number;
  rThigh: number;
  rOut: number;
  rKnee: number;
};

const HALF = Math.PI / 2;

/** Curled tight, as it floats: spine bent double, knees to its chest, the hand at its face. */
const CURLED: Pose = {
  hipY: 0.075,
  roll: 0,
  pitch: 0,
  s1: 0.5,
  s2: 0.45,
  twist: 0.1,
  neck: 0.3,
  head: 0.3,
  headYaw: 0.2,
  headRoll: 0.25,
  jaw: 0.15,
  hx: 0.02,
  hy: -0.1,
  hz: 0.08,
  stubP: -0.9,
  stubOut: -0.2,
  stubEl: 1.2,
  lThigh: -0.9,
  lOut: 0.15,
  lKnee: 2.3,
  rThigh: -0.6,
  rOut: -0.2,
  rKnee: 2.0,
};

/** Flat on its belly, head raised a little toward where it is going, legs dragging behind. */
const PRONE: Pose = {
  hipY: 0.06,
  roll: 0,
  pitch: 0,
  s1: -0.08,
  s2: -0.12,
  twist: 0,
  neck: -0.35,
  head: 0.15,
  headYaw: 0,
  headRoll: 0.15,
  jaw: 0.25,
  hx: 0.1,
  hy: -0.06,
  hz: 0.2,
  stubP: -0.6,
  stubOut: -0.5,
  stubEl: 1.3,
  lThigh: HALF - 0.32,
  lOut: 0.18,
  lKnee: 0.22,
  rThigh: HALF - 0.28,
  rOut: -0.35,
  rKnee: 0.3,
};

/** Hauling: the back arched with the effort, the head thrust forward, mouth gaping. */
const HAUL: Pose = {
  ...PRONE,
  hipY: 0.065,
  s1: -0.32,
  s2: -0.3,
  neck: -0.55,
  head: 0.05,
  jaw: 0.65,
  headRoll: -0.1,
};

/** Spent between hauls: chest down on the floor, the head lolled over on its side. */
const SLUMP: Pose = {
  ...PRONE,
  hipY: 0.055,
  roll: 0.12,
  s1: 0.05,
  s2: 0.18,
  neck: 0.15,
  head: 0.35,
  headYaw: -0.3,
  headRoll: 0.65,
  jaw: 0.45,
};

/** A convulsion: the back bowed hard, the head thrown back, the jaw wrenched wide. */
const SPASM: Pose = {
  ...PRONE,
  hipY: 0.07,
  s1: -0.25,
  s2: -0.3,
  twist: 0.5,
  neck: -0.75,
  head: -0.4,
  headRoll: 0.4,
  jaw: 1.05,
  hx: 0.22,
  hy: 0.05,
  hz: 0.05,
  stubP: -1.6,
  stubOut: -0.9,
  stubEl: 0.3,
  lThigh: HALF - 0.7,
  lKnee: 1.2,
  rThigh: HALF - 0.1,
  rKnee: 0.1,
};

/** Fallen on its side, sprawled, the arm flung out. */
const FALLEN: Pose = {
  ...SLUMP,
  hipY: 0.075,
  roll: 0.9,
  s1: 0.25,
  s2: 0.2,
  neck: 0.35,
  head: 0.2,
  headRoll: 0.3,
  jaw: 0.6,
  hx: 0.0,
  hy: -0.1,
  hz: 0.2,
  lThigh: HALF - 0.6,
  lKnee: 1.0,
  rThigh: HALF - 0.9,
  rKnee: 1.4,
};

/** Retching: the head hung to the floor, the jaw at its widest, the back heaving. */
const RETCH: Pose = {
  ...SLUMP,
  roll: 0.05,
  hipY: 0.07,
  s1: -0.25,
  s2: 0.25,
  neck: 0.55,
  head: 0.3,
  headYaw: 0.1,
  headRoll: 0.2,
  jaw: 1.1,
};

const KEYS = Object.keys(PRONE) as (keyof Pose)[];
function mix(out: Pose, a: Pose, b: Pose, t: number) {
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

/** The parts of the body the animation drives. */
type Body = {
  root: Group;
  hips: Group;
  spine1: Group;
  spine2: Group;
  neck: Group;
  head: Group;
  jaw: Group;
  shoulder: Group;
  elbow: Group;
  hand: Group;
  claws: Object3D[];
  stub: Group;
  stubEl: Group;
  thighL: Group;
  kneeL: Group;
  thighR: Group;
  kneeR: Group;
  eye: Object3D;
  /** Where the feeding tube comes out of it. */
  navel: Object3D;
  mouth: Object3D;
  chest: Object3D;
  /** Pieces it comes apart into. */
  gibs: Object3D[];
};

const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);
/** Lengths of the good arm's bones. */
const UPPER = 0.19;
const FORE = 0.19;

type Gib = { obj: Object3D; vel: Vector3; spin: Vector3; rest: boolean; bled: boolean; bleed: number };

/**
 * The thing in the tank, let out. When the three cards are in, the reader
 * chimes, a relay clunks and pumps start: the tank drains with a deep gurgle,
 * the figure sinking with the fluid to lie curled on the tank's floor. The
 * door hisses round in a burst of steam. It uncurls in fits and drags itself
 * out on its one long arm: reach, a wet slap as the claws bite, then the haul,
 * its back bowing and its legs dragging dead behind it, and then it slumps,
 * spent, its head lolling. Between hauls it seizes, retches up fluid, falls on
 * its side and has to lever itself back over. It gurgles, whimpers and
 * shrieks. It follows the cord out through the habitat and the airlock,
 * tumbles down the steps, and hauls itself on across the sand, ploughing a
 * furrow, until the drone finds it and it comes apart.
 *
 * It is no longer much like the creature's kind: a swollen, lopsided skull with
 * one bulging milk-white eye and one sunken one, a hanging jaw of needle teeth,
 * hairless skin raw and veined, a hunched spine of knobs, a distended belly,
 * one long clawed arm and one withered stub, and the feeding tube still in it.
 */
export class Specimen {
  phase: Phase = 'tank';
  t = 0;
  /** Seconds it has been out on the sand. */
  outside = 0;
  readonly group = new Group();
  private body!: Body;
  private readonly pos = new Vector3();
  private yaw = 0;
  private vy = 0;
  private path: Vector3[] = [];
  private seg = 0;
  private act: Act = 'reach';
  private actT = 0;
  private actDur = 0.5;
  private voiceTimer = 1.2;
  private trailAt = new Vector3();
  private readonly pose: Pose = { ...CURLED };
  private readonly from: Pose = { ...CURLED };
  private readonly handAt = new Vector3();
  private readonly handFrom = new Vector3();
  private readonly handTo = new Vector3();
  private plant = 0;
  private haulFrom = new Vector3();
  private haulLen = 0;
  private shake = 0;
  private readonly tube: { p: Vector3; prev: Vector3; mesh: Mesh }[] = [];
  private readonly gibs: Gib[] = [];
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();
  private readonly q = new Quaternion();
  private readonly marks: Mesh[] = [];
  private readonly wetMat = toonMaterial({ dark: 0x1a3432, mid: 0x24484a, light: 0x2e5a58, litAt: 0.6, outline: 0, highlight: 0 });
  private readonly furrowMat = toonMaterial({ dark: PALETTE.sandDeep, mid: PALETTE.sandShade, light: PALETTE.sandMid, litAt: 0.6, outline: 0, highlight: 0 });
  private readonly bloodMat = toonMaterial({ dark: 0x2a0404, mid: 0x420808, light: 0x5a0e0e, litAt: 0.6, outline: 0, highlight: 0.5 });
  private readonly bileMat = toonMaterial({ dark: 0x2e3412, mid: 0x46501c, light: 0x5e6a26, litAt: 0.6, outline: 0, highlight: 0.6 });
  private readonly M = {
    skin: toonMaterial({ dark: 0x5a3a3e, mid: 0x8a5e5e, light: 0xb4867c, litAt: 0.5, outline: 0.6, highlight: 0.75 }),
    sac: toonMaterial({ dark: 0x3e2438, mid: 0x5e3a52, light: 0x845a6c, litAt: 0.5, outline: 0.5, highlight: 0.9 }),
    vein: toonMaterial({ dark: 0x2a1424, mid: 0x401e38, light: 0x542a48, litAt: 0.5, outline: 0, highlight: 0 }),
    knob: toonMaterial({ dark: 0x7a6660, mid: 0xa49084, light: 0xc8b6a4, litAt: 0.5, outline: 0.5, highlight: 0.5 }),
    eye: toonMaterial({ dark: 0x8a9488, mid: 0xc4ccbc, light: 0xe8eee0, litAt: 0.4, outline: 0.4, highlight: 1 }),
    pupil: toonMaterial({ dark: 0x0e0c0c, mid: 0x1a1414, light: 0x2a2020, litAt: 0.5, outline: 0, highlight: 0.8 }),
    mouth: toonMaterial({ dark: 0x200606, mid: 0x340c0c, light: 0x481212, litAt: 0.5, outline: 0, highlight: 0.6 }),
    teeth: toonMaterial({ dark: 0x8a8068, mid: 0xb8ae90, light: 0xd8d0b0, litAt: 0.5, outline: 0, highlight: 0.4 }),
    claw: toonMaterial({ dark: 0x2a2220, mid: 0x4a3c36, light: 0x6a5a50, litAt: 0.5, outline: 0.5, highlight: 0.6 }),
    tube: toonMaterial({ dark: 0x4a5a58, mid: 0x7a8e8a, light: 0xa8bcb8, litAt: 0.5, outline: 0.4, highlight: 0.8 }),
  };

  constructor(
    private readonly station: Station,
    private readonly audio: AudioEngine,
    private readonly dust: Dust,
  ) {
    const I = station.interior.root;
    // its way out: from the tank, back along the cord, out of the airlock and a long way on over the sand
    const local: [number, number][] = [
      [8.1, 0.1],
      [7.5, 0.28],
      [6.6, 0.2],
      [5.7, 0.2],
      [4.6, 0.35],
      [3.3, 0.2],
      [2.5, -0.1],
      [1.4, 0.55],
      [0.95, 1.15],
      [0.9, 1.8],
      [0.9, 2.55],
      [0.85, 3.3],
      [0.4, 4.3],
      [-0.4, 5.4],
      [-1.3, 6.6],
      [-2.2, 7.8],
      [-3.0, 9.0],
      [-3.6, 10.3],
      [-4.4, 11.5],
      [-5.0, 12.8],
      [-5.9, 14.0],
    ];
    this.path = local.map(([x, z]) => I.localToWorld(new Vector3(x, 0, z)));
    this.reset();
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }

  get alive() {
    return this.phase !== 'dead' && this.phase !== 'tank';
  }

  get started() {
    return this.phase !== 'tank';
  }

  /** Where it is, once it is out of the tank (null before, and once it is in pieces). */
  get at(): Vector3 | null {
    return this.alive ? this.pos : null;
  }

  /** Where its chest is (for the drone, and for looking at it). */
  chest(out: Vector3) {
    if (this.phase === 'tank') return out.copy(this.station.interior.tank.at);
    return this.body.chest.getWorldPosition(out);
  }

  /** Back as it was: floating in a full tank behind a shut door, every trace of it gone. */
  reset() {
    for (const g of this.gibs) g.obj.removeFromParent();
    this.gibs.length = 0;
    for (const m of this.marks) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.marks.length = 0;
    for (const s of this.tube) s.mesh.removeFromParent();
    this.tube.length = 0;
    if (this.body) this.body.root.removeFromParent();
    const tank = this.station.interior.tank;
    tank.level = 1;
    tank.liquid.visible = true;
    tank.liquid.scale.y = 1.47;
    tank.doorPanel.rotation.y = 0;
    tank.floating = true;
    tank.figure.visible = true;
    this.phase = 'tank';
    this.t = 0;
    this.outside = 0;
    this.seg = 0;
    this.vy = 0;
    this.plant = 0;
    this.shake = 0;
    this.body = this.build();
    // curled in the fluid, nose down, turning slowly with the figure's tether
    const r = this.body.root;
    r.position.set(0, -0.12, -0.04);
    r.rotation.set(-0.5, 0, 0.35, 'YXZ');
    tank.figure.add(r);
    Object.assign(this.pose, CURLED);
    this.apply(0, 0);
    this.makeTube();
  }

  /** The ground under it: the tank's floor, the deck, the airlock's threshold and steps, or the sand. */
  private ground(x: number, z: number) {
    const interior = this.station.interior;
    const tank = interior.tank.at;
    if (Math.hypot(x - tank.x, z - tank.z) < 0.44) return tank.y;
    const l = interior.root.worldToLocal(this.tmp3.set(x, 0, z));
    const base = interior.root.localToWorld(new Vector3(0, 0, 0)).y;
    if (Math.abs(l.x - 0.9) < 0.6 && l.z > 1.4) {
      if (l.z < 2.36) return base + 0.85;
      if (l.z < 2.71) return base + 0.325;
      if (l.z < 3.01) return base + 0.155;
    }
    this.tmp3.set(x, 0, z);
    if (interior.contains(this.tmp3)) return interior.floorY;
    return terrainHeight(x, z);
  }

  /** The three cards are in: let it out. */
  begin() {
    if (this.phase !== 'tank') return;
    this.phase = 'drain';
    this.t = 0;
    this.audio.releaseChime(0.5);
    this.audio.tankDrain(0.5, 4.2);
  }

  /** The drone has it: it bursts, and what is left of it is flung across the sand. */
  kill(dir?: Vector3) {
    if (this.phase === 'dead') return;
    this.phase = 'dead';
    const b = this.body;
    b.root.updateMatrixWorld(true);
    const at = this.chest(new Vector3());
    const d = dir ? this.tmp.set(dir.x, 0, dir.z) : this.tmp.set(0, 0, 0);
    if (d.lengthSq() > 0.001) d.normalize();
    for (const part of b.gibs) {
      this.group.attach(part);
      const out = part.getWorldPosition(this.tmp2).sub(at);
      out.y = Math.max(0, out.y);
      if (out.lengthSq() < 1e-4) out.set(Math.random() - 0.5, 0.2, Math.random() - 0.5);
      out.normalize();
      const vel = new Vector3()
        .copy(out)
        .multiplyScalar(rand(2.5, 6))
        .addScaledVector(d, rand(1, 3))
        .add(new Vector3((Math.random() - 0.5) * 2, rand(2.5, 6), (Math.random() - 0.5) * 2));
      const spin = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30);
      this.gibs.push({ obj: part, vel, spin, rest: false, bled: false, bleed: rand(1.5, 3.5) });
    }
    b.root.removeFromParent();
    // the tube whips away too
    for (const s of this.tube) {
      s.prev.copy(s.p).addScaledVector(this.tmp2.set(Math.random() - 0.5, -0.6 - Math.random(), Math.random() - 0.5), 0.06);
    }
    // a burst of blood and flesh, and fluid from what it was full of
    for (let i = 0; i < 110; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 6.5);
      const k = Math.random();
      this.dust.spawn(at.x, at.y, at.z, Math.cos(a) * s + d.x * 2, rand(1, 6), Math.sin(a) * s + d.z * 2, rand(0.6, 1.6), k < 0.15 ? GORE : k < 0.3 ? BILE : BLOOD, k < 0.15 ? 2 : 1, {
        g: 11,
        drag: 0.4,
        windK: 0,
        c2: k < 0.3 && k >= 0.15 ? BILE_FADE : BLOOD_FADE,
      });
    }
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.1, 1.6);
      this.splat(at.x + Math.cos(a) * r, at.z + Math.sin(a) * r, rand(0.12, 0.35), Math.random() < 0.3 ? this.bileMat : this.bloodMat);
    }
    this.splat(at.x, at.z, 0.6, this.bloodMat);
    this.audio.specimenSlap(0.6, 0, false, true);
  }

  update(dt: number, time: number, listener: Vector3) {
    if (this.phase === 'dead') {
      this.updateGibs(dt);
      this.updateTube(dt, 9);
      return;
    }
    if (this.phase === 'tank') {
      // asleep in the fluid, its fingers and its jaw working now and then
      const tw = Math.max(0, noise1(time * 0.4, 3) - 0.3) * 2;
      this.pose.jaw = CURLED.jaw + tw * 0.25 + Math.sin(time * 1.3) * 0.05;
      this.pose.headYaw = CURLED.headYaw + Math.sin(time * 0.3) * 0.15;
      this.pose.stubEl = CURLED.stubEl + Math.sin(time * 7) * 0.2 * tw;
      this.pose.lKnee = CURLED.lKnee + Math.sin(time * 0.5) * 0.1;
      this.apply(time, 0);
      this.updateTube(dt, -0.4);
      return;
    }
    this.t += dt;
    const tank = this.station.interior.tank;
    const level = (d: number) => 1 / (1 + (d * d) / 16);
    if (this.phase === 'drain') {
      // the fluid sinks away, swirling, the figure sinking with it
      tank.level = 1 - smooth(0.3, 3.6, this.t);
      tank.liquid.visible = tank.level > 0.01;
      tank.liquid.scale.y = Math.max(0.001, 1.47 * tank.level);
      if (Math.random() < 0.7) {
        const a = time * 6 + Math.random();
        const r = 0.1 + Math.random() * 0.25;
        const y = tank.at.y + 0.05 + Math.random() * 1.4 * tank.level;
        this.dust.spawn(tank.at.x + Math.cos(a) * r, y, tank.at.z + Math.sin(a) * r, -Math.sin(a) * 0.4, -0.3, Math.cos(a) * 0.4, 0.5, BUBBLE, 1, { g: 1, drag: 1, windK: 0 });
      }
      // it stirs as the fluid leaves it
      if (this.t > 2.4) this.pose.jaw = CURLED.jaw + Math.max(0, Math.sin(this.t * 5)) * 0.6;
      this.apply(time, 0.2);
      this.updateTube(dt, -0.4 * tank.level + 9 * (1 - tank.level));
      if (this.t > 3.8) {
        this.phase = 'settle';
        this.t = 0;
        this.spawn();
        this.audio.specimenSlap(0.4 * level(listener.distanceTo(tank.at)), 0, true);
        this.audio.specimenVoice('gurgle', 0.55 * level(listener.distanceTo(tank.at)), 0);
      }
      return;
    }
    if (this.phase === 'settle') {
      // lying curled on the tank's floor, heaving for breath, shaking
      mix(this.pose, CURLED, CURLED, 0);
      this.pose.roll = 1.25;
      this.pose.hipY = 0.09;
      this.pose.jaw = 0.4 + Math.max(0, Math.sin(this.t * 6)) * 0.5;
      this.shake = 0.5 + Math.max(0, Math.sin(this.t * 3)) * 0.5;
      if (this.t > 1.4) {
        this.phase = 'door';
        this.t = 0;
        this.audio.tankHiss(0.5 * level(listener.distanceTo(tank.at)));
      }
    } else if (this.phase === 'door') {
      // the door slides round the tank in a gust of steam
      const k = smooth(0.15, 1.0, this.t);
      tank.doorPanel.rotation.y = k * (Math.PI / 2);
      if (this.t < 0.9) {
        for (let i = 0; i < 4; i++) {
          const up = Math.random() * 1.5;
          this.dust.spawn(tank.door.x, tank.door.y + up, tank.door.z, tank.out.x * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.3, tank.out.z * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.3, 1 + Math.random() * 0.8, STEAM, 2, {
            g: -0.4,
            drag: 1.6,
            windK: 0,
            c2: STEAM_FADE,
            soft: true,
          });
        }
      }
      // the cold air hits it: a hard jerk
      if (this.t > 0.3 && this.t - dt <= 0.3) {
        this.shake = 1.6;
        this.audio.specimenVoice('shriek', 0.45 * level(listener.distanceTo(this.pos)), 0);
      }
      this.shake = Math.max(0.5, this.shake - dt * 1.5);
      if (this.t > 1.4) {
        this.phase = 'wake';
        this.t = 0;
      }
    } else if (this.phase === 'wake') {
      // uncurling in fits: it rolls onto its belly, a leg kicks, the head comes up toward the way out
      const k = smooth(0, 1.6, this.t);
      const fit = Math.max(0, Math.sin(this.t * 9) * Math.sin(this.t * 2.3));
      const curled = { ...CURLED, roll: 1.25, hipY: 0.09 };
      mix(this.pose, curled, PRONE, k);
      this.pose.s1 += -fit * 0.4;
      this.pose.neck += -fit * 0.5;
      this.pose.jaw += fit * 0.6;
      this.shake = 0.7 + fit;
      if (this.t > 1.8) {
        this.phase = 'crawl';
        this.t = 0;
        this.seg = 1;
        this.startReach();
      }
    } else {
      this.crawl(dt, time, listener);
    }
    // it never stops making some sound
    this.voiceTimer -= dt;
    if (this.voiceTimer <= 0 && this.act !== 'retch') {
      const out = this.phase === 'outside';
      this.voiceTimer = rand(0.8, 2.0) * (out ? 1.2 : 1);
      const kinds = out ? (['gurgle', 'whimper', 'whimper', 'rattle', 'mewl', 'gasp'] as const) : (['gurgle', 'whimper', 'mewl', 'gasp', 'rattle'] as const);
      this.audio.specimenVoice(kinds[Math.floor(Math.random() * kinds.length)], 0.45 * level(listener.distanceTo(this.pos)), this.pan(listener));
    }
    this.apply(time, this.shake, dt);
    this.updateTube(dt, 9);
    this.drip(dt);
  }

  private pan(listener: Vector3) {
    return Math.max(-0.8, Math.min(0.8, (this.pos.x - listener.x) / 6));
  }

  /** How worn out it is: hauls slow and shorten and it has fits more often the longer it is on the sand. */
  private get fatigue() {
    return Math.min(1, this.outside / 14);
  }

  private nextAct(act: Act, dur: number) {
    Object.assign(this.from, this.pose);
    this.act = act;
    this.actT = 0;
    this.actDur = dur;
  }

  /** The long arm swings out ahead for a new grip. */
  private startReach() {
    const b = this.body;
    b.root.updateMatrixWorld(true);
    b.hand.getWorldPosition(this.handFrom);
    this.handAt.copy(this.handFrom);
    // a little to the arm's side of straight ahead, a bit toward where it is going
    const target = this.path[Math.min(this.seg, this.path.length - 1)];
    let want = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    let dy = want - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    want = this.yaw + Math.max(-0.5, Math.min(0.5, dy));
    b.shoulder.getWorldPosition(this.tmp);
    const reach = (0.34 - this.fatigue * 0.06) * S * rand(0.9, 1.05);
    this.handTo.set(this.tmp.x + Math.sin(want) * reach + Math.cos(want) * 0.02, 0, this.tmp.z + Math.cos(want) * reach - Math.sin(want) * 0.02);
    this.handTo.y = this.ground(this.handTo.x, this.handTo.z) + 0.01;
    const inside = this.phase === 'crawl';
    this.nextAct('reach', (inside ? 0.22 : 0.3) * (1 + this.fatigue * 0.4) * rand(0.85, 1.2));
    if (this.plant < 0.01) this.plant = 0.001;
  }

  /** Dragging itself along: reach, slap, haul, slump; and between, its fits. */
  private crawl(dt: number, time: number, listener: Vector3) {
    const out = this.phase === 'outside';
    if (out) this.outside += dt;
    const f = this.fatigue;
    const lv = 1 / (1 + listener.distanceToSquared(this.pos) / 16);
    const pan = this.pan(listener);
    const metal = !out;
    this.actT += dt;
    const k = Math.min(1, this.actT / this.actDur);
    this.shake = 0.35 + f * 0.4;
    const b = this.body;
    switch (this.act) {
      case 'reach': {
        // the arm comes over in an arc and the claws smack down
        mix(this.pose, this.from, PRONE, smooth(0, 0.6, k));
        this.pose.headYaw += Math.sin(k * Math.PI) * 0.2;
        this.plant = Math.min(1, this.plant + dt * 6);
        const e = smooth(0, 1, k);
        this.handAt.lerpVectors(this.handFrom, this.handTo, e);
        this.handAt.y += Math.sin(e * Math.PI) * 0.13 * S;
        this.pose.stubP = PRONE.stubP + Math.sin(k * Math.PI * 3) * 0.4;
        if (k >= 1) {
          this.audio.specimenSlap(0.35 * lv, pan, metal, Math.random() < 0.15);
          this.dust.spawn(this.handTo.x, this.handTo.y + 0.02, this.handTo.z, 0, 0.4, 0, 0.35, out ? SAND : FLUID, 1, { g: 6, drag: 1, windK: 0, c2: out ? SAND_FADE : FLUID_FADE });
          b.root.updateMatrixWorld(true);
          b.shoulder.getWorldPosition(this.tmp);
          this.haulFrom.copy(this.pos);
          this.haulLen = Math.max(0, Math.hypot(this.handTo.x - this.tmp.x, this.handTo.z - this.tmp.z) - 0.06 * S);
          this.nextAct('haul', (out ? 0.42 : 0.3) * (1 + f * 0.4) * rand(0.9, 1.2));
          this.audio.specimenDrag(0.3 * lv, pan, metal);
        }
        break;
      }
      case 'haul': {
        // the hand holds; the body is dragged up to it in a lurch, the back bowing with the effort
        const bow = Math.sin(k * Math.PI);
        mix(this.pose, PRONE, HAUL, bow);
        this.pose.jaw += Math.sin(k * 20) * 0.08 * bow;
        this.handAt.copy(this.handTo);
        // where the body should be: hauled along the line to the hand
        const e = k < 0.15 ? 0 : smooth(0.15, 0.9, k);
        const dx = this.handTo.x - this.haulFrom.x;
        const dz = this.handTo.z - this.haulFrom.z;
        const dl = Math.hypot(dx, dz) || 1;
        const want = this.tmp.set(this.haulFrom.x + (dx / dl) * this.haulLen * e, 0, this.haulFrom.z + (dz / dl) * this.haulLen * e);
        this.pos.x = want.x;
        this.pos.z = want.z;
        // turned toward the hand as it comes
        let dy = Math.atan2(dx, dz) - this.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.yaw += dy * Math.min(1, dt * 3);
        if (k >= 1) this.nextAct('slump', (out ? 0.22 : 0.08) * (1 + f) * rand(0.7, 1.4));
        break;
      }
      case 'slump': {
        mix(this.pose, this.from, SLUMP, smooth(0, 0.5, k) * (out ? 1 : 0.6));
        // heaving for breath
        this.pose.s2 += Math.sin(this.actT * 7) * 0.06;
        this.pose.jaw += Math.max(0, Math.sin(this.actT * 7)) * 0.2;
        if (k >= 1) {
          // a fit now and then, more often as it tires
          const r = Math.random();
          const fits = (out ? 0.14 : 0.05) + f * 0.12;
          if (r < fits * 0.4) {
            this.nextAct('spasm', rand(0.6, 1.0));
            this.audio.specimenVoice(Math.random() < 0.6 ? 'shriek' : 'gurgle', 0.5 * lv, pan);
            this.audio.specimenSlap(0.3 * lv, pan, metal, true);
          } else if (r < fits * 0.7) {
            this.nextAct('collapse', rand(1.0, 1.8));
            this.audio.specimenSlap(0.45 * lv, pan, metal);
            this.audio.specimenVoice('whimper', 0.45 * lv, pan);
          } else if (r < fits) {
            this.nextAct('retch', 1.5);
            this.audio.specimenVoice('retch', 0.55 * lv, pan);
          } else this.startReach();
        }
        break;
      }
      case 'spasm': {
        // it seizes: bowed, rigid, thrashing, the bad arm clawing at the air
        const s = Math.sin(k * Math.PI);
        mix(this.pose, this.from, SPASM, smooth(0, 0.15, k) * (1 - smooth(0.75, 1, k)));
        const j = noise1(time * 22, 1);
        this.pose.roll += j * 0.35 * s;
        this.pose.twist += noise1(time * 16, 9) * 0.6 * s;
        this.pose.lThigh += noise1(time * 18, 2) * 0.6 * s;
        this.pose.rThigh += noise1(time * 15, 4) * 0.5 * s;
        this.pose.lKnee += noise1(time * 20, 5) * 0.8 * s;
        this.pose.hx += noise1(time * 14, 6) * 0.08 * s;
        this.pose.hz += noise1(time * 13, 7) * 0.08 * s;
        this.pose.headYaw += noise1(time * 25, 8) * 0.5 * s;
        this.plant = Math.max(0, this.plant - dt * 6);
        this.shake = 1.8 * s;
        if (k >= 1) this.startReach();
        break;
      }
      case 'collapse': {
        // the arm gives and it flops onto its side, shaking, its legs twitching
        mix(this.pose, this.from, FALLEN, smooth(0, 0.18, k));
        this.pose.lKnee += Math.max(0, noise1(time * 9, 2)) * 0.6;
        this.pose.jaw += Math.sin(this.actT * 11) * 0.15;
        this.plant = Math.max(0, this.plant - dt * 8);
        this.shake = 0.9;
        if (k >= 1) {
          // the hand finds the floor beside it, to lever against
          b.shoulder.getWorldPosition(this.tmp);
          const fx = Math.sin(this.yaw);
          const fz = Math.cos(this.yaw);
          this.handTo.set(this.tmp.x + fx * 0.1 + fz * 0.08, 0, this.tmp.z + fz * 0.1 - fx * 0.08);
          this.handTo.y = this.ground(this.handTo.x, this.handTo.z) + 0.01;
          this.handAt.copy(this.handTo);
          this.nextAct('push', 0.9);
          this.audio.specimenVoice('gasp', 0.45 * lv, pan);
        }
        break;
      }
      case 'push': {
        // levering itself back over on its one arm, wobbling, nearly falling back
        const e = smooth(0, 1, k);
        mix(this.pose, FALLEN, HAUL, e);
        this.pose.roll += Math.sin(k * Math.PI * 3) * 0.25 * (1 - e);
        this.plant = Math.min(1, this.plant + dt * 5);
        this.handAt.copy(this.handTo);
        this.shake = 1.3;
        if (k >= 1) {
          this.audio.specimenSlap(0.3 * lv, pan, metal, true);
          this.startReach();
        }
        break;
      }
      case 'retch': {
        // its back pumps twice, then fluid comes up out of it in a gush
        mix(this.pose, this.from, RETCH, smooth(0, 0.2, k) * (1 - smooth(0.85, 1, k)));
        const heave = this.actT < 0.7 ? Math.max(0, Math.sin(this.actT * Math.PI * 3)) : 0;
        this.pose.s1 -= heave * 0.35;
        this.pose.s2 += heave * 0.25;
        this.pose.jaw -= heave * 0.4;
        this.plant = Math.max(0, this.plant - dt * 4);
        if (this.actT > 0.7 && this.actT < 1.15) {
          b.mouth.getWorldPosition(this.tmp);
          const fx = Math.sin(this.yaw);
          const fz = Math.cos(this.yaw);
          for (let i = 0; i < 3; i++) {
            this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, fx * rand(0.3, 1.2) + (Math.random() - 0.5) * 0.4, rand(-0.2, 0.6), fz * rand(0.3, 1.2) + (Math.random() - 0.5) * 0.4, rand(0.5, 1), Math.random() < 0.6 ? BILE : FLUID, 1, {
              g: 9,
              drag: 0.3,
              windK: 0,
              c2: BILE_FADE,
            });
          }
          if (this.actT - dt <= 0.75) this.splat(this.tmp.x + fx * 0.12, this.tmp.z + fz * 0.12, 0.16, this.bileMat);
        }
        if (k >= 1) this.startReach();
        break;
      }
    }
    // keep on the path
    const target = this.path[Math.min(this.seg, this.path.length - 1)];
    if (Math.hypot(target.x - this.pos.x, target.z - this.pos.z) < 0.3 && this.seg < this.path.length - 1) this.seg++;
    // the trail it leaves: wet on the deck, a furrow in the sand
    if (this.pos.distanceTo(this.trailAt) > 0.14) {
      this.trailAt.copy(this.pos);
      const inside = this.station.interior.contains(this.pos);
      const g = this.ground(this.pos.x, this.pos.z);
      const m = new Mesh(new BoxGeometry(inside ? 0.16 : 0.2, 0.006, 0.18), inside || !out ? this.wetMat : this.furrowMat);
      m.position.set(this.pos.x + (Math.random() - 0.5) * 0.04, g + 0.006 + (this.marks.length % 7) * 0.0004, this.pos.z + (Math.random() - 0.5) * 0.04);
      m.rotation.y = this.yaw + (Math.random() - 0.5) * 0.3;
      this.group.add(m);
      this.marks.push(m);
      if (out) {
        this.dust.spawn(this.pos.x, g + 0.03, this.pos.z, (Math.random() - 0.5) * 0.4, 0.2, (Math.random() - 0.5) * 0.4, 0.5, SAND, 1, { g: 2, drag: 2, windK: 0.3, c2: SAND_FADE, soft: true });
      }
    }
    // out of the airlock and onto the sand
    if (!out && this.seg >= 12) {
      this.phase = 'outside';
      this.outside = 0;
    }
  }

  /** A wet stain where it fell or bled or retched. */
  private splat(x: number, z: number, r: number, mat: Material) {
    const m = new Mesh(new CylinderGeometry(r, r, 0.006, 7), mat);
    m.position.set(x, this.ground(x, z) + 0.008 + (this.marks.length % 9) * 0.0004, z);
    m.scale.set(rand(0.7, 1.3), 1, rand(0.6, 1.1));
    m.rotation.y = Math.random() * Math.PI;
    this.group.add(m);
    this.marks.push(m);
  }

  /** It drips, always. */
  private drip(_dt: number) {
    const out = this.phase === 'outside';
    if (Math.random() < (out ? 0.12 : 0.45)) {
      this.dust.spawn(this.pos.x + (Math.random() - 0.5) * 0.2, this.pos.y + 0.12, this.pos.z + (Math.random() - 0.5) * 0.2, 0, -0.2, 0, 0.4, FLUID, 1, { g: 9, drag: 0.2, windK: 0, c2: FLUID_FADE });
    }
    if (Math.random() < 0.05) {
      this.body.mouth.getWorldPosition(this.tmp);
      this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, 0, -0.1, 0, 0.6, BILE, 1, { g: 6, drag: 0.4, windK: 0, c2: BILE_FADE });
    }
  }

  /** Let go of the tank's figure: it lies curled on the tank's floor. */
  private spawn() {
    const tank = this.station.interior.tank;
    tank.figure.visible = false;
    tank.floating = false;
    this.yaw = Math.atan2(tank.out.x, tank.out.z);
    this.pos.set(tank.at.x, tank.at.y, tank.at.z);
    this.group.add(this.body.root);
    this.body.root.position.copy(this.pos);
    this.body.root.rotation.set(0, this.yaw, 0, 'YXZ');
    this.trailAt.copy(this.pos);
    this.splat(tank.at.x, tank.at.z, 0.3, this.wetMat);
  }

  /**
   * Put the body in its pose: the root on the ground (falling when the
   * ground drops away, as down the airlock's steps), its joints set from the
   * pose with a fine, pained shaking over everything, and the long arm reaching
   * for its planted hand.
   */
  private apply(time: number, shake: number, dt = 1 / 60) {
    const b = this.body;
    const p = this.pose;
    if (this.phase !== 'tank' && this.phase !== 'drain') {
      const g = this.ground(this.pos.x, this.pos.z);
      if (this.pos.y > g + 0.03) {
        this.vy -= 9.8 * dt;
        this.pos.y = Math.max(g, this.pos.y + this.vy * dt);
        if (this.pos.y <= g) {
          // it lands in a wet heap
          this.audio.specimenSlap(0.5 / (1 + this.vy * this.vy * 0.01), 0, true, true);
          this.vy = 0;
          if (this.act === 'reach' || this.act === 'haul' || this.act === 'slump') this.nextAct('collapse', rand(0.8, 1.3));
        }
      } else {
        this.vy = 0;
        this.pos.y += (g - this.pos.y) * 0.5;
      }
      b.root.position.copy(this.pos);
      // tipped with the slope under it
      const fx = Math.sin(this.yaw) * 0.25;
      const fz = Math.cos(this.yaw) * 0.25;
      const slope = Math.atan2(this.ground(this.pos.x - fx, this.pos.z - fz) - this.ground(this.pos.x + fx, this.pos.z + fz), 0.5);
      b.root.rotation.set(Math.max(-0.5, Math.min(0.5, slope)) + p.pitch, this.yaw, p.roll, 'YXZ');
      b.root.scale.setScalar(S);
    } else b.root.scale.setScalar(S * 0.95);
    const n = (r: number, s: number) => (shake > 0 ? noise1(time * r, s) * shake : 0);
    b.hips.position.y = p.hipY;
    b.spine1.rotation.set(p.s1 + n(17, 1) * 0.06, p.twist * 0.5 + n(13, 2) * 0.05, n(19, 3) * 0.04);
    b.spine2.rotation.set(p.s2 + n(21, 4) * 0.07, p.twist * 0.5, n(15, 5) * 0.05);
    b.neck.rotation.set(p.neck + n(23, 6) * 0.1, p.headYaw * 0.5, 0);
    b.head.rotation.set(p.head + n(29, 7) * 0.12, p.headYaw * 0.5 + n(11, 8) * 0.08, p.headRoll + n(27, 9) * 0.1);
    b.jaw.rotation.x = Math.max(0, p.jaw + n(31, 10) * 0.15);
    b.stub.rotation.set(p.stubP + n(25, 11) * 0.3, 0, p.stubOut);
    b.stubEl.rotation.x = p.stubEl + n(33, 12) * 0.4;
    b.thighL.rotation.set(p.lThigh + n(9, 13) * 0.08, 0, p.lOut);
    b.kneeL.rotation.x = p.lKnee + n(14, 14) * 0.1;
    b.thighR.rotation.set(p.rThigh + n(8, 15) * 0.06, 0.4, p.rOut);
    b.kneeR.rotation.x = p.rKnee;
    for (const [i, c] of b.claws.entries()) c.rotation.x = 0.5 + this.plant * 0.5 + n(37, 20 + i) * 0.4;
    // the eye rolls
    b.eye.rotation.set(n(5, 30) * 0.6, n(6, 31) * 0.8, 0);
    // the long arm: to its pose's hand, or to the planted one
    b.root.updateMatrixWorld(true);
    const local = this.tmp.set(p.hx, p.hy, p.hz);
    if (this.plant > 0.001) {
      const w = b.spine2.worldToLocal(this.tmp2.copy(this.handAt));
      local.lerp(w, this.plant);
    }
    this.ik(local);
  }

  /** Bend the long arm so its hand reaches `target` (in the chest's frame), the elbow out and up like a broken thing's. */
  private ik(target: Vector3) {
    const b = this.body;
    const s = b.shoulder.position;
    const v = this.tmp3.copy(target).sub(s);
    const d = Math.max(0.03, Math.min(UPPER + FORE - 0.002, v.length()));
    v.normalize();
    const ca = Math.max(-1, Math.min(1, (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d)));
    const sa = Math.sqrt(1 - ca * ca);
    const pole = this.tmp2.set(1, 0.9, -0.3);
    pole.addScaledVector(v, -pole.dot(v)).normalize();
    const elbowDir = new Vector3().copy(v).multiplyScalar(ca).addScaledVector(pole, sa).normalize();
    b.shoulder.quaternion.setFromUnitVectors(DOWN, elbowDir);
    // the forearm, from the elbow to the hand, in the upper arm's frame
    const e = new Vector3().copy(s).addScaledVector(elbowDir, UPPER);
    const hand = new Vector3().copy(s).addScaledVector(v, d);
    const fore = hand.sub(e).normalize().applyQuaternion(this.q.copy(b.shoulder.quaternion).invert());
    b.elbow.quaternion.setFromUnitVectors(DOWN, fore);
  }

  /** The feeding tube: a rope of segments hanging from its belly, dragging behind it. `g` is its weight (less than nothing in the fluid). */
  private makeTube() {
    this.body.root.updateMatrixWorld(true);
    const a = this.body.navel.getWorldPosition(new Vector3());
    for (let i = 0; i < 9; i++) {
      const mesh = new Mesh(faceted(new CylinderGeometry(0.014, 0.014, 1, 5)), this.M.tube);
      mesh.layers.enable(SHADOW_LAYER);
      this.group.add(mesh);
      const p = new Vector3(a.x, a.y - i * 0.05, a.z);
      this.tube.push({ p, prev: p.clone(), mesh });
    }
  }

  private updateTube(dt: number, g: number) {
    if (!this.tube.length) return;
    const LEN = 0.055;
    const anchored = this.phase !== 'dead';
    if (anchored) this.body.navel.getWorldPosition(this.tube[0].p);
    const step = Math.min(dt, 1 / 30);
    for (let i = anchored ? 1 : 0; i < this.tube.length; i++) {
      const s = this.tube[i];
      const vx = (s.p.x - s.prev.x) * 0.96;
      const vy = (s.p.y - s.prev.y) * 0.96;
      const vz = (s.p.z - s.prev.z) * 0.96;
      s.prev.copy(s.p);
      s.p.x += vx;
      s.p.y += vy - g * step * step;
      s.p.z += vz;
      const floor = this.phase === 'tank' || this.phase === 'drain' ? this.station.interior.tank.at.y : this.ground(s.p.x, s.p.z);
      if (s.p.y < floor + 0.014) {
        s.p.y = floor + 0.014;
        // it drags: the floor holds it back
        s.prev.x += (s.p.x - s.prev.x) * 0.5;
        s.prev.z += (s.p.z - s.prev.z) * 0.5;
      }
    }
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < this.tube.length; i++) {
        const a = this.tube[i - 1].p;
        const c = this.tube[i].p;
        const d = this.tmp.copy(c).sub(a);
        const l = d.length() || 1e-4;
        const k = (l - LEN) / l;
        if (anchored && i === 1) c.addScaledVector(d, -k);
        else {
          a.addScaledVector(d, k * 0.5);
          c.addScaledVector(d, -k * 0.5);
        }
      }
    }
    for (let i = 0; i < this.tube.length; i++) {
      const s = this.tube[i];
      const n = this.tube[Math.min(i + 1, this.tube.length - 1)];
      const a = i + 1 < this.tube.length ? s.p : this.tube[i - 1].p;
      const c = i + 1 < this.tube.length ? n.p : s.p;
      const d = this.tmp.copy(c).sub(a);
      const l = d.length();
      s.mesh.visible = i + 1 < this.tube.length && l > 0.001;
      if (!s.mesh.visible) continue;
      s.mesh.position.copy(a).addScaledVector(d, 0.5);
      s.mesh.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / l));
      s.mesh.scale.set(S, l + 0.01, S);
    }
  }

  /** The pieces flying, tumbling, bouncing and bleeding where they lie. */
  private updateGibs(dt: number) {
    for (const g of this.gibs) {
      if (g.rest) {
        if (g.bleed > 0) {
          g.bleed -= dt;
          if (Math.random() < 0.2) this.dust.spawn(g.obj.position.x, g.obj.position.y + 0.02, g.obj.position.z, (Math.random() - 0.5) * 0.3, 0.3, (Math.random() - 0.5) * 0.3, 0.5, BLOOD, 1, { g: 8, drag: 0.4, windK: 0 });
        }
        continue;
      }
      g.vel.y -= 9.8 * dt;
      g.obj.position.addScaledVector(g.vel, dt);
      g.obj.rotation.x += g.spin.x * dt;
      g.obj.rotation.y += g.spin.y * dt;
      g.obj.rotation.z += g.spin.z * dt;
      if (Math.random() < 0.5) this.dust.spawn(g.obj.position.x, g.obj.position.y, g.obj.position.z, g.vel.x * 0.1, g.vel.y * 0.1, g.vel.z * 0.1, 0.6, BLOOD, 1, { g: 9, drag: 0.4, windK: 0, c2: BLOOD_FADE });
      const floor = this.ground(g.obj.position.x, g.obj.position.z) + 0.02;
      if (g.obj.position.y < floor) {
        g.obj.position.y = floor;
        if (!g.bled) {
          g.bled = true;
          this.splat(g.obj.position.x, g.obj.position.z, rand(0.08, 0.18), this.bloodMat);
        }
        g.vel.y = -g.vel.y * 0.3;
        g.vel.x *= 0.5;
        g.vel.z *= 0.5;
        g.spin.multiplyScalar(0.5);
        if (Math.abs(g.vel.y) < 0.6 && Math.hypot(g.vel.x, g.vel.z) < 0.4) g.rest = true;
      }
    }
  }

  /** Model the body: every part a faceted block or lump in its raw, wet colours. */
  private build(): Body {
    const M = this.M;
    const gibs: Object3D[] = [];
    const add = (parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      const m = new Mesh(faceted(geo), mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.layers.enable(SHADOW_LAYER);
      parent.add(m);
      return m;
    };
    const lump = (parent: Object3D, r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, mat: Material = M.skin, detail = 0) =>
      add(parent, new IcosahedronGeometry(r, detail), mat, x, y, z, sx, sy, sz);
    const box = (parent: Object3D, w: number, h: number, d: number, mat: Material, x: number, y: number, z: number) => add(parent, new BoxGeometry(w, h, d), mat, x, y, z);
    const group = (parent: Object3D, x: number, y: number, z: number) => {
      const g = new Group();
      g.position.set(x, y, z);
      parent.add(g);
      return g;
    };
    const root = new Group();
    root.rotation.order = 'YXZ';
    const hips = group(root, 0, 0.06, 0);
    // the pelvis, lopsided, and the swollen belly sagging under it
    lump(hips, 0.062, 0, 0.005, -0.01, 1.15, 0.75, 1, M.skin);
    const belly = lump(hips, 0.07, 0.012, -0.022, 0.055, 1, 0.75, 1.15, M.sac, 1);
    box(belly, 0.008, 0.008, 0.1, M.vein, 0.03, -0.035, 0).rotation.y = 0.4;
    box(belly, 0.008, 0.008, 0.08, M.vein, -0.03, -0.03, 0.01).rotation.y = -0.6;
    const navel = group(belly, 0.0, -0.05, -0.02);
    gibs.push(belly);
    // the legs: thin, wasted, dragged behind it; the right one shorter and twisted out
    const leg = (side: number, thigh: number, shin: number) => {
      const t = group(hips, side * 0.045, -0.01, -0.03);
      box(t, 0.036, thigh, 0.036, M.skin, 0, -thigh / 2, 0);
      lump(t, 0.022, 0, -thigh, 0, 1, 1, 1, M.knob);
      const k = group(t, 0, -thigh, 0);
      box(k, 0.026, shin, 0.026, M.skin, 0, -shin / 2, 0);
      // a clubbed foot, its toes fused
      const foot = box(k, 0.034, 0.02, 0.05, M.skin, 0, -shin, 0.015);
      foot.rotation.x = 0.4;
      gibs.push(k, t);
      return [t, k] as const;
    };
    const [thighL, kneeL] = leg(1, 0.14, 0.13);
    const [thighR, kneeR] = leg(-1, 0.1, 0.09);
    // the spine: two bends, a ridge of knobs down it, the ribs showing through
    const spine1 = group(hips, 0, 0.012, 0.035);
    lump(spine1, 0.06, 0, 0.005, 0.06, 1, 0.78, 1.25);
    for (const z of [0.02, 0.06, 0.1]) lump(spine1, 0.016, 0, 0.05, z, 1, 1, 1, M.knob);
    gibs.push(spine1);
    const spine2 = group(spine1, 0, 0.01, 0.11);
    const chest = lump(spine2, 0.075, -0.01, 0.012, 0.055, 1.15, 0.82, 1, M.skin, 1);
    for (const z of [0.0, 0.04, 0.08]) lump(spine2, 0.018, 0.005, 0.072, z, 1, 1, 1, M.knob);
    // a hump of growth on its back, off to one side
    lump(spine2, 0.045, -0.04, 0.06, 0.02, 1, 0.8, 1.1, M.sac);
    for (const [z, side] of [
      [0.03, 1],
      [0.065, 1],
      [0.03, -1],
      [0.065, -1],
    ]) {
      const r = box(spine2, 0.008, 0.06, 0.01, M.knob, side * 0.082, 0.0, z);
      r.rotation.z = side * -0.3;
    }
    box(spine2, 0.006, 0.006, 0.09, M.vein, 0.05, 0.05, 0.05).rotation.y = 0.3;
    gibs.push(spine2);
    // the long arm, on its left: bony, the elbow a knot, a hand of three long claws
    const shoulder = group(spine2, 0.075, -0.005, 0.085);
    lump(shoulder, 0.028, 0, 0, 0, 1, 1, 1, M.skin);
    box(shoulder, 0.03, UPPER, 0.03, M.skin, 0, -UPPER / 2, 0);
    const elbow = group(shoulder, 0, -UPPER, 0);
    lump(elbow, 0.022, 0, 0, 0, 1, 1, 1, M.knob);
    box(elbow, 0.024, FORE, 0.024, M.skin, 0, -FORE / 2, 0);
    const hand = group(elbow, 0, -FORE, 0);
    box(hand, 0.04, 0.03, 0.022, M.skin, 0, -0.012, 0);
    const claws: Object3D[] = [];
    for (const [x, len] of [
      [-0.016, 0.07],
      [0.0, 0.085],
      [0.016, 0.065],
    ]) {
      const c = group(hand, x, -0.025, 0);
      box(c, 0.008, len, 0.008, M.claw, 0, -len / 2, 0);
      claws.push(c);
    }
    gibs.push(elbow, shoulder);
    // the other arm withered to a stub with two nubs of fingers
    const stub = group(spine2, -0.07, -0.01, 0.075);
    box(stub, 0.022, 0.06, 0.022, M.skin, 0, -0.03, 0);
    const stubEl = group(stub, 0, -0.06, 0);
    box(stubEl, 0.018, 0.04, 0.018, M.skin, 0, -0.02, 0);
    box(stubEl, 0.006, 0.02, 0.006, M.claw, 0.006, -0.045, 0);
    box(stubEl, 0.006, 0.016, 0.006, M.claw, -0.005, -0.043, 0);
    gibs.push(stub);
    // the neck, thin, and the great head lolling on it
    const neck = group(spine2, 0, 0.03, 0.115);
    box(neck, 0.045, 0.04, 0.07, M.skin, 0, 0, 0.03);
    gibs.push(neck);
    const head = group(neck, 0, 0.0, 0.065);
    // the skull: too big, bulged on one side, the veins standing out on it
    lump(head, 0.1, 0.012, 0.045, 0.06, 1.05, 0.9, 1.0, M.skin, 1);
    lump(head, 0.06, -0.06, 0.09, 0.03, 1.1, 1, 1, M.skin, 1);
    lump(head, 0.03, 0.06, 0.1, 0.0, 1, 1, 1, M.sac);
    for (const [x, y, z, ry, rz] of [
      [0.04, 0.13, 0.04, 0.3, 0.6],
      [-0.03, 0.135, 0.07, -0.4, -0.5],
      [-0.08, 0.1, 0.0, 0.9, 0.2],
    ]) {
      const v = box(head, 0.008, 0.008, 0.08, M.vein, x, y, z);
      v.rotation.set(0, ry, rz);
    }
    // one eye bulging, milk-white, the other a sunken black slit
    const eye = group(head, 0.05, 0.045, 0.135);
    lump(eye, 0.032, 0, 0, 0, 1, 1, 0.9, M.eye, 1);
    box(eye, 0.012, 0.012, 0.006, M.pupil, 0.004, -0.004, 0.03);
    box(head, 0.03, 0.008, 0.01, M.pupil, -0.04, 0.05, 0.145).rotation.z = 0.3;
    lump(head, 0.02, -0.04, 0.065, 0.135, 1.4, 0.6, 0.6, M.skin);
    // the mouth: a dark hole with needle teeth, the jaw hanging off it
    box(head, 0.07, 0.02, 0.02, M.mouth, 0.005, 0.0, 0.14);
    for (const x of [-0.025, -0.008, 0.01, 0.027]) box(head, 0.006, 0.018, 0.006, M.teeth, x, -0.005, 0.145);
    const jaw = group(head, 0, -0.005, 0.085);
    box(jaw, 0.075, 0.022, 0.07, M.skin, 0.004, -0.015, 0.035);
    box(jaw, 0.06, 0.006, 0.05, M.mouth, 0.004, -0.002, 0.04);
    for (const x of [-0.022, -0.004, 0.016]) box(jaw, 0.006, 0.016, 0.006, M.teeth, x, 0.002, 0.065);
    const mouth = group(head, 0, -0.02, 0.15);
    gibs.push(head);
    // it comes apart from its ends inward, so each piece takes what is still on it
    gibs.sort((a, b) => depth(b) - depth(a));
    return { root, hips, spine1, spine2, neck, head, jaw, shoulder, elbow, hand, claws, stub, stubEl, thighL, kneeL, thighR, kneeR, eye, navel, mouth, chest, gibs: [...gibs, hips] };
  }
}

function depth(o: Object3D) {
  let d = 0;
  for (let p = o.parent; p; p = p.parent) d++;
  return d;
}
