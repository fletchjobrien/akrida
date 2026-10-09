import { Vector3 } from 'three';
import { clamp, lerp, noise1, smoothstep } from '../core/math';
import type { Creature, World } from '../character/Creature';
import { blendPose, clonePose, type HandPose, type ScriptPose } from '../character/scriptPose';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Dust } from '../world/particles';
import type { Ship } from '../world/ship';
import { ease, foot, hand, LOOK, mk, type Ease } from './WakeUp';

// --------------------------------------------------------------------- poses
// Body space: x = the creature's left, y = up, z = forward. Written for a pull
// toward its left (+x); mirrored when the door slides the other way.

const CALM = mk(LOOK, { tremble: 0, exertion: 0.3 });

/** Leaning in, hands going to the door's edge (to its right, just ahead). */
const REACH = mk(CALM, {
  pelvisPitch: 0.3,
  spinePitch: 0.1,
  neckPitch: 0.12,
  headPitch: 0.1,
  headYaw: -0.25,
  footL: foot(0.16, 0.02, 0, 0.2, 0, 0),
  footR: foot(-0.1, 0.12, 0, 0.2, 0, 0),
  exertion: 0.35,
});

/** Braced: the near hoof forward, the other planted wide on the pulling side. */
const SET = mk(REACH, {
  pelvisY: 0.63,
  pelvisPitch: 0.12,
  pelvisRoll: 0.08,
  footL: foot(0.3, -0.08, 0, 0.3, 0, 0),
  footR: foot(-0.12, 0.17, 0, 0.15, 0, 0),
  tremble: 0.3,
  exertion: 0.5,
});

/** Hauling: hips thrown back and over, twisted into it, knees bent. */
const PULL1 = mk(SET, {
  pelvisX: 0.12,
  pelvisZ: -0.12,
  pelvisY: 0.6,
  pelvisPitch: -0.12,
  pelvisYaw: 0.25,
  pelvisRoll: -0.2,
  spinePitch: -0.04,
  chestRoll: -0.1,
  neckPitch: -0.05,
  headYaw: -0.4,
  tremble: 0.9,
  exertion: 1,
});

/** A breath: easing off, still holding on. */
const REST = mk(PULL1, { pelvisX: 0.05, pelvisZ: -0.05, pelvisPitch: 0.15, pelvisRoll: 0.02, pelvisYaw: 0.1, headPitch: 0.25, neckPitch: 0.2, tremble: 0.5 });

/** Everything it has. */
const PULL2 = mk(PULL1, {
  pelvisX: 0.2,
  pelvisZ: -0.18,
  pelvisY: 0.56,
  pelvisPitch: -0.24,
  pelvisYaw: 0.35,
  pelvisRoll: -0.32,
  chestRoll: -0.16,
  headYaw: -0.5,
  headPitch: -0.1,
  footL: foot(0.42, -0.14, 0, 0.35, 0, 0),
  tremble: 1,
});

/** It gives: thrown back and sideways, arms flung out. */
const GIVE = mk(PULL2, {
  pelvisX: 0.36,
  pelvisZ: -0.3,
  pelvisY: 0.6,
  pelvisPitch: -0.3,
  pelvisRoll: -0.36,
  pelvisYaw: 0.15,
  chestRoll: -0.2,
  headYaw: -0.1,
  neckPitch: -0.3,
  handL: hand(0.4, 0.8, -0.1, 0),
  handR: hand(-0.4, 0.8, -0.1, 0),
  armPitch: -0.9,
  elbow: -0.3,
  armOut: 0.7,
  footL: foot(0.5, -0.3, 0.1, 0.3, 0, 0),
  tremble: 0.3,
});

/** The trailing hoof swings across behind to catch it. */
const STEP1 = mk(GIVE, {
  pelvisX: 0.44,
  pelvisZ: -0.38,
  pelvisPitch: -0.05,
  pelvisRoll: -0.18,
  armPitch: -0.5,
  armOut: 0.55,
  footL: foot(0.56, -0.3, 0, 0.3, 0, 0),
  footR: foot(0.18, -0.3, 0.14, 0.4, -0.3, 0),
});
const STEP1_DOWN = mk(STEP1, { footR: foot(0.32, -0.52, 0, 0.3, 0, 0), pelvisX: 0.48, pelvisZ: -0.42 });

/** Caught: doubled over, hands on knees, gasping. */
const CATCH = mk(STEP1_DOWN, {
  pelvisX: 0.47,
  pelvisZ: -0.42,
  pelvisY: 0.6,
  pelvisPitch: 0.5,
  pelvisRoll: 0,
  pelvisYaw: 0,
  spinePitch: 0.2,
  chestPitch: 0.12,
  chestRoll: 0,
  neckPitch: 0.1,
  headPitch: -0.2,
  headYaw: -0.2,
  handL: hand(0.6, 0.38, -0.22, 0.9),
  handR: hand(0.32, 0.38, -0.25, 0.9),
  armPitch: 0,
  armOut: 0.15,
  elbow: -0.2,
  footL: foot(0.6, -0.36, 0, 0.3, 0, 0),
  tremble: 0.6,
  exertion: 1,
});

/** Upright again, beside the open door, looking into it. */
const AFTER = mk(CALM, {
  pelvisX: 0.47,
  pelvisZ: -0.42,
  headYaw: -0.45,
  footL: foot(0.57, -0.37, 0, 0.2, 0, 0),
  footR: foot(0.37, -0.47, 0, 0.2, 0, 0),
  tremble: 0.2,
  exertion: 0.8,
});

const KEYS: { t: number; pose: ScriptPose; ease: Ease }[] = [
  { t: 0, pose: CALM, ease: 'linear' },
  { t: 0.7, pose: REACH, ease: 'inOut' },
  { t: 1.15, pose: SET, ease: 'inOut' },
  { t: 2.3, pose: PULL1, ease: 'out' },
  { t: 2.9, pose: REST, ease: 'inOut' },
  { t: 4.55, pose: PULL2, ease: 'out' },
  { t: 4.8, pose: GIVE, ease: 'out' },
  { t: 5.1, pose: STEP1, ease: 'inOut' },
  { t: 5.35, pose: STEP1_DOWN, ease: 'in' },
  { t: 6.0, pose: CATCH, ease: 'out' },
  { t: 6.8, pose: CATCH, ease: 'linear' },
  { t: 7.9, pose: AFTER, ease: 'inOut' },
];
const END = 8.3;
/** Its grip on the door: on from REACH, lost the moment the door gives. */
const grip = (t: number) => smoothstep(0.55, 1.05, t) * (1 - smoothstep(4.6, 4.72, t));
/** How far open the door is (fraction of its width) over the scene. */
function doorAt(t: number) {
  const judder = (a: number, b: number, from: number, to: number) => {
    const u = clamp((t - a) / (b - a), 0, 1);
    // stick and slip: it moves in little jerks
    const steps = Math.floor(u * 9) / 9 + smoothstep(0, 1, (u * 9) % 1) / 9;
    return lerp(from, to, steps);
  };
  if (t < 1.4) return 0.13;
  if (t < 2.4) return judder(1.4, 2.4, 0.13, 0.19);
  if (t < 3.0) return lerp(0.19, 0.18, (t - 2.4) / 0.6);
  if (t < 4.6) return judder(3.0, 4.6, 0.18, 0.31);
  return lerp(0.31, 0.97, ease('out', clamp((t - 4.6) / 0.38, 0, 1)));
}

/** Mirror a pose left for right. */
function mirror(p: ScriptPose): ScriptPose {
  const m = clonePose(p);
  m.pelvisX = -p.pelvisX;
  m.pelvisYaw = -p.pelvisYaw;
  m.pelvisRoll = -p.pelvisRoll;
  m.chestRoll = -p.chestRoll;
  m.headYaw = -p.headYaw;
  m.headRoll = -p.headRoll;
  m.handL = { ...p.handR, x: -p.handR.x };
  m.handR = { ...p.handL, x: -p.handL.x };
  m.footL = { ...p.footR, x: -p.footR.x };
  m.footR = { ...p.footL, x: -p.footL.x };
  return m;
}

const _v = new Vector3();
const _w = new Vector3();

/**
 * Hauling the jammed door open: the creature steps up, gets its hands into the
 * gap, braces and pulls, rests, pulls again with everything it has, and when
 * the door gives all at once it is thrown off balance, stumbles away, catches
 * itself doubled over, and straightens up beside the open doorway.
 */
export class DoorScene {
  active = false;
  t = 0;
  /** 0..1 how far the scene has drawn the camera in. */
  weight = 0;
  private side = 1;
  private keys: { t: number; pose: ScriptPose; ease: Ease }[] = KEYS;
  private readonly pose = clonePose(CALM);
  private readonly start = new Vector3();
  private readonly stand = new Vector3();
  private startYaw = 0;
  private yaw = 0;
  private beat = 0;
  private readonly beats: { t: number; run: () => void }[];

  constructor(
    private readonly creature: Creature,
    private readonly world: World,
    private readonly ship: Ship,
    private readonly audio: AudioEngine,
    private readonly dust: Dust,
  ) {
    const a = audio;
    this.beats = [
      { t: 0.75, run: () => a.click(0.25) },
      { t: 1.2, run: () => a.effort(0.24) },
      { t: 1.4, run: () => a.doorGrind(0.32, 1.0) },
      { t: 2.0, run: () => a.effort(0.2) },
      { t: 2.6, run: () => a.wakeGasp(0.18, false) },
      { t: 3.0, run: () => a.effort(0.3) },
      { t: 3.05, run: () => a.doorGrind(0.42, 1.55) },
      { t: 3.9, run: () => a.effort(0.32) },
      { t: 4.6, run: () => a.doorGive(0.55) },
      { t: 4.65, run: () => a.wakeGasp(0.24) },
      { t: 5.0, run: () => this.footfall(-1) },
      { t: 5.35, run: () => this.footfall(1) },
      { t: 5.5, run: () => a.scuff(0.4) },
      { t: 6.1, run: () => a.wakeGasp(0.22, true) },
    ];
  }

  /** Whether the creature, at `pos`, is close enough to take hold of the door. */
  canStart(pos: Vector3) {
    return this.ship.state === 'cracked' && Math.hypot(pos.x - this.ship.doorCenter.x, pos.z - this.ship.doorCenter.z) < 2.8;
  }

  begin() {
    if (this.active) return;
    const c = this.creature;
    const ship = this.ship;
    this.active = true;
    this.t = 0;
    this.beat = 0;
    // face the door
    this.yaw = Math.atan2(-ship.doorNormal.x, -ship.doorNormal.z);
    this.startYaw = c.yaw;
    const left = _v.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // which way the pull goes for it: toward its left (+1) or its right (-1)
    this.side = ship.slideDir.dot(left) >= 0 ? 1 : -1;
    this.keys = this.side > 0 ? KEYS : KEYS.map((k) => ({ ...k, pose: mirror(k.pose) }));
    // stand square to the door, its edge just to the right of centre (or left, mirrored)
    ship.doorEdge(0.7, _w);
    const fwd = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const ex = -0.08 * this.side;
    const ez = 0.5;
    this.stand.set(
      _w.x - Math.cos(this.yaw) * ex - fwd.x * ez,
      0,
      _w.z + Math.sin(this.yaw) * ex - fwd.z * ez,
    );
    this.start.copy(c.pos);
  }

  /** Camera focus: between the creature and the door. */
  focus(out: Vector3) {
    return out.set(
      (this.creature.pos.x + this.ship.doorCenter.x) / 2,
      this.creature.pos.y + 0.7,
      (this.creature.pos.z + this.ship.doorCenter.z) / 2,
    );
  }

  private footfall(side: number) {
    const c = this.creature;
    this.dust.kick(c.pos.x, c.pos.y, c.pos.z, -this.ship.doorNormal.x * 0, 0, 3, 0.5);
    this.audio.thud(0.16 + 0.04 * side);
  }

  update(dt: number) {
    if (!this.active) {
      this.weight = Math.max(0, this.weight - dt * 0.8);
      return;
    }
    this.t += dt;
    const t = this.t;
    const c = this.creature;
    this.weight = smoothstep(0, 0.8, t) * (1 - smoothstep(END - 0.6, END + 0.6, t));

    // walk the last little way into place and turn to face the door
    const k = smoothstep(0, 0.7, t);
    c.pos.x = lerp(this.start.x, this.stand.x, k);
    c.pos.z = lerp(this.start.z, this.stand.z, k);
    let dy = this.yaw - this.startYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    c.setYaw(this.startYaw + dy * k);

    // the door moves as it is hauled
    this.ship.doorOpen = doorAt(t);
    if (t >= 4.6 && t - dt < 4.6) this.ship.state = 'open';

    // sample the pose
    const keys = this.keys;
    let i = 1;
    while (i < keys.length && keys[i].t < t) i++;
    const P = this.pose;
    if (i >= keys.length) blendPose(P, keys[keys.length - 1].pose, keys[keys.length - 1].pose, 0);
    else {
      const a = keys[i - 1];
      const b = keys[i];
      blendPose(P, a.pose, b.pose, ease(b.ease, clamp((t - a.t) / (b.t - a.t), 0, 1)));
    }

    // hands: locked onto the door's edge while it holds on, moving with it
    const g = grip(t);
    if (g > 0) {
      // the hand on the pulling side grips higher
      const hi = this.side > 0 ? P.handL : P.handR;
      const lo = this.side > 0 ? P.handR : P.handL;
      this.gripTo(hi, 0.86, g);
      this.gripTo(lo, 0.62, g);
    }
    // straining makes everything shake harder in bursts
    if (t > 1.2 && t < 4.6) P.tremble = Math.min(1, P.tremble + 0.25 * Math.max(0, noise1(t * 3, 17)));

    c.updateScripted(dt, P, this.world);

    while (this.beat < this.beats.length && t >= this.beats[this.beat].t) this.beats[this.beat++].run();

    if (t >= END) this.finish();
  }

  /** Blend a hand toward a point on the door's edge, `y` above the ground. */
  private gripTo(h: HandPose, y: number, g: number) {
    const c = this.creature;
    this.ship.doorEdge(y, _w);
    // just inside the gap
    _w.addScaledVector(this.ship.doorNormal, -0.04);
    const cy = Math.cos(c.yaw);
    const sy = Math.sin(c.yaw);
    const dx = _w.x - c.pos.x;
    const dz = _w.z - c.pos.z;
    const bx = dx * cy - dz * sy;
    const bz = dx * sy + dz * cy;
    const by = _w.y - this.world.height(_w.x, _w.z);
    h.x = lerp(h.x, bx, g);
    h.y = lerp(h.y, by, g);
    h.z = lerp(h.z, bz, g);
    h.ik = lerp(h.ik, 1, g);
  }

  /** Hand control back: move its ground position to where its body ended up. */
  private finish() {
    const c = this.creature;
    const P = this.pose;
    const ox = P.pelvisX;
    const oz = P.pelvisZ;
    const cy = Math.cos(c.yaw);
    const sy = Math.sin(c.yaw);
    c.pos.x += ox * cy + oz * sy;
    c.pos.z += -ox * sy + oz * cy;
    P.pelvisX = 0;
    P.pelvisZ = 0;
    for (const f of [P.footL, P.footR]) {
      f.x -= ox;
      f.z -= oz;
    }
    for (const h of [P.handL, P.handR]) {
      h.x -= ox;
      h.z -= oz;
    }
    c.updateScripted(0, P, this.world);
    c.releaseScript(0);
    this.active = false;
    this.ship.doorOpen = 0.97;
    this.ship.state = 'open';
  }
}
