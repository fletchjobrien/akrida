import { Vector3 } from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import type { Creature, World } from '../character/Creature';
import { blendPose, clonePose, type ScriptPose } from '../character/scriptPose';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Tracker } from '../world/tracker';
import { ease, foot, hand, LOOK, mk, type Ease } from './WakeUp';

// --------------------------------------------------------------------- poses
// Body space: x = the creature's left, y = up, z = forward. The right hand
// (handR, -x) takes the device.

const CALM = mk(LOOK, { tremble: 0.05, exertion: 0.2 });

/** Leaning over it, eyes on it, the hand starting down. */
const BEND = mk(CALM, {
  pelvisY: 0.58,
  pelvisZ: -0.04,
  pelvisPitch: 0.5,
  spinePitch: 0.14,
  chestPitch: 0.1,
  neckPitch: 0.15,
  headPitch: 0.42,
  handR: hand(-0.08, 0.3, 0.42, 0.6),
  footL: foot(0.12, 0.1, 0, 0.25, 0, 0),
  footR: foot(-0.12, -0.06, 0, 0.25, 0, 0),
});

/** Down on one knee, the free hand on the other, the right hand on the device. */
const GRAB = mk(BEND, {
  pelvisY: 0.4,
  pelvisZ: -0.18,
  pelvisPitch: 0.52,
  spinePitch: 0.24,
  chestPitch: 0.16,
  neckPitch: 0.12,
  headPitch: 0.45,
  handL: hand(0.16, 0.4, 0.16, 0.85),
  handR: hand(-0.06, 0.06, 0.4, 1),
  footL: foot(0.13, 0.2, 0, 0.3, 0, 0),
  footR: foot(-0.12, -0.5, 0, -1.5, -1.6, 0.65),
});

/** Rising with it, the hand coming up in front. */
const RISE = mk(CALM, {
  pelvisY: 0.56,
  pelvisZ: -0.08,
  pelvisPitch: 0.4,
  spinePitch: 0.1,
  chestPitch: 0.05,
  neckPitch: 0.2,
  headPitch: 0.35,
  handL: hand(0.2, 0.5, 0.1, 0),
  handR: hand(-0.1, 0.62, 0.3, 1),
  footL: foot(0.12, 0.14, 0, 0.25, 0, 0),
  footR: foot(-0.12, -0.24, 0, 0.3, 0.1, 0),
});

/** Upright, holding it up in both hands to look at it as it wakes (as when it is held out later). */
const STUDY = mk(CALM, {
  pelvisPitch: 0.1,
  neckPitch: 0.32,
  headPitch: 0.45,
  headRoll: 0.1,
  handL: hand(0.11, 1.0, 0.33, 1),
  handR: hand(-0.11, 1.0, 0.33, 1),
  footL: foot(0.1, 0.06, 0, 0.2, 0, 0),
  footR: foot(-0.1, -0.06, 0, 0.2, 0, 0),
});
const STUDY2 = mk(STUDY, { headRoll: -0.1, headYaw: 0.1, pelvisYaw: 0.05 });

/** Carrying it: the arm down, the elbow bent a little. */
const CARRY = mk(CALM, {
  handR: hand(-0.24, 0.55, 0.1, 0),
  elbow: -0.5,
  footL: foot(0.1, 0.06, 0, 0.2, 0, 0),
  footR: foot(-0.1, -0.06, 0, 0.2, 0, 0),
});

type Key = { t: number; pose: ScriptPose; ease: Ease };
/** The first time: picked up, lifted to the face and looked at as it wakes. */
const FIRST: Key[] = [
  { t: 0, pose: CALM, ease: 'linear' },
  { t: 0.5, pose: BEND, ease: 'inOut' },
  { t: 1.0, pose: GRAB, ease: 'inOut' },
  { t: 1.25, pose: GRAB, ease: 'linear' },
  { t: 1.85, pose: RISE, ease: 'inOut' },
  { t: 2.4, pose: STUDY, ease: 'out' },
  { t: 3.3, pose: STUDY2, ease: 'inOut' },
  { t: 3.9, pose: STUDY2, ease: 'linear' },
  { t: 4.6, pose: CARRY, ease: 'inOut' },
];
/** After that: just scooped up. */
const AGAIN: Key[] = [
  { t: 0, pose: CALM, ease: 'linear' },
  { t: 0.4, pose: BEND, ease: 'inOut' },
  { t: 0.8, pose: GRAB, ease: 'inOut' },
  { t: 0.95, pose: GRAB, ease: 'linear' },
  { t: 1.45, pose: RISE, ease: 'inOut' },
  { t: 2.0, pose: CARRY, ease: 'inOut' },
];
/** When the hand closes on it. */
const GRAB_AT = { first: 1.08, again: 0.86 };
/** How far in front of it to kneel (the knee lands a little short of it). */
export const PICK_REACH = 0.42;

const _v = new Vector3();

/**
 * Picking the tracker up: the creature steps up to it, bends, sinks onto one
 * knee and takes it in its right hand, and rises. The first time, it lifts it
 * to its face and turns it over as the device wakes up in its hand.
 */
export class PickupScene {
  active = false;
  t = 0;
  /** 0..1 how far the scene has drawn the camera in. */
  weight = 0;
  private keys: Key[] = FIRST;
  private grabAt = GRAB_AT.first;
  private end = 4.6;
  private first = true;
  private grabbed = false;
  private readonly pose = clonePose(CALM);
  private readonly start = new Vector3();
  private readonly stand = new Vector3();
  private readonly grab = new Vector3();
  /** Where the hand closes on it, in body space. */
  private readonly hold = new Vector3();
  /** The step back from the kneeling place to where it can stand clear. */
  private readonly back = new Vector3();
  /** Where to walk to before the scene starts. */
  approachPoint(from: Vector3, out: Vector3) {
    this.standPoint(from, out);
    return out.add(this.back);
  }

  private startYaw = 0;
  private yaw = 0;
  /** The first time it turns to the camera (three-quarter on) to look at it. */
  private studyYaw = 0;

  constructor(
    private readonly creature: Creature,
    private readonly world: World,
    private readonly tracker: Tracker,
    private readonly audio: AudioEngine,
  ) {}

  /**
   * Where to kneel to take it, and the way to face (radians), from `from`. In
   * the doorway that is closer to the hull than it can walk, so it walks to a
   * point a step out (`approachPoint`) and the scene takes it the rest.
   */
  standPoint(from: Vector3, out: Vector3) {
    const tr = this.tracker;
    tr.grabPoint(this.grab);
    this.back.set(0, 0, 0);
    if (tr.inDoorway) this.back.copy(tr.doorFacing).multiplyScalar(-0.32);
    if (tr.inDoorway) {
      // in the ship's doorway: from beside the door, so the camera sees it side on
      _v.copy(tr.doorFacing).multiplyScalar(0.5).addScaledVector(tr.doorAlong, -0.87).normalize();
    } else {
      _v.set(this.grab.x - from.x, 0, this.grab.z - from.z);
      if (_v.lengthSq() < 1e-6) _v.set(Math.sin(this.creature.yaw), 0, Math.cos(this.creature.yaw));
      _v.normalize();
    }
    out.set(this.grab.x - _v.x * PICK_REACH, 0, this.grab.z - _v.z * PICK_REACH);
    out.y = this.world.height(out.x, out.z);
    return Math.atan2(_v.x, _v.z);
  }

  begin() {
    if (this.active) return;
    const c = this.creature;
    this.active = true;
    this.t = 0;
    this.grabbed = false;
    this.first = !this.tracker.awake;
    this.keys = this.first ? FIRST : AGAIN;
    this.grabAt = this.first ? GRAB_AT.first : GRAB_AT.again;
    this.end = this.keys[this.keys.length - 1].t;
    this.yaw = this.standPoint(c.pos, this.stand);
    this.startYaw = c.yaw;
    this.start.copy(c.pos);
    const near = (a: number) => Math.abs(Math.atan2(Math.sin(a - this.yaw), Math.cos(a - this.yaw)));
    this.studyYaw = near(0.5) < near(-0.5) ? 0.5 : -0.5;
    this.audio.effort(0.05);
  }

  /** Camera focus: on the creature, low, toward the device. */
  focus(out: Vector3) {
    const c = this.creature;
    const p = this.tracker.position;
    const k = this.first ? smoothstep(1.6, 2.4, this.t) * (1 - smoothstep(3.9, 4.6, this.t)) : 0;
    return out.set(lerp(c.pos.x, p.x, 0.4), c.pos.y + lerp(0.45, 0.8, k), lerp(c.pos.z, p.z, 0.4));
  }

  update(dt: number) {
    if (!this.active) {
      this.weight = Math.max(0, this.weight - dt * 1.2);
      return;
    }
    this.t += dt;
    const t = this.t;
    const c = this.creature;
    const end = this.end;
    this.weight = smoothstep(0, 0.6, t) * (1 - smoothstep(end - 0.5, end + 0.3, t));

    // the last little way into place, turning to face it
    const k = smoothstep(0, 0.5, t);
    c.pos.x = lerp(this.start.x, this.stand.x, k);
    c.pos.z = lerp(this.start.z, this.stand.z, k);
    let dy = this.yaw - this.startYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    // and the step back out clear of the hull as it rises
    const out = smoothstep(this.first ? 1.45 : 0.95, this.first ? 2.35 : 1.7, t);
    c.pos.x += this.back.x * out;
    c.pos.z += this.back.z * out;
    let yaw = this.startYaw + dy * k;
    if (this.first) {
      // rising, it turns round to look at what it has found
      let ds = this.studyYaw - this.yaw;
      ds = Math.atan2(Math.sin(ds), Math.cos(ds));
      yaw += ds * ease('inOut', smoothstep(1.45, 2.35, t));
      this.tracker.inspect = smoothstep(1.85, 2.3, t) * (1 - smoothstep(3.85, 4.35, t));
    }
    c.setYaw(yaw);

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

    // the right hand goes to the device, and once it has it, eases into the keyed pose
    const h = P.handR;
    const ga = this.grabAt;
    if (!this.grabbed) {
      const cy = Math.cos(c.yaw);
      const sy = Math.sin(c.yaw);
      const g = this.grab;
      const dx = g.x - c.pos.x;
      const dz = g.z - c.pos.z;
      // over it first, then down onto it
      const over = 0.12 * (1 - smoothstep(ga - 0.35, ga - 0.05, t));
      this.hold.set(dx * cy - dz * sy, g.y - this.world.height(g.x, g.z) + over, dx * sy + dz * cy);
    }
    const reach = smoothstep(0.15, ga - 0.1, t) * (1 - smoothstep(ga + 0.05, ga + 0.55, t));
    if (reach > 0) {
      h.x = lerp(h.x, this.hold.x, reach);
      h.y = lerp(h.y, this.hold.y, reach);
      h.z = lerp(h.z, this.hold.z, reach);
      h.ik = lerp(h.ik, 1, reach);
    }
    if (!this.grabbed && t >= this.grabAt) {
      this.grabbed = true;
      this.tracker.take();
      c.carrying = true;
      this.audio.effort(0.08);
    }
    if (this.first && t >= 2.25 && t - dt < 2.25) this.tracker.wake();

    c.updateScripted(dt, P, this.world);
    if (t >= end) this.finish();
  }

  /** Hand control back: its ground position moves to where its body ended up. */
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
    c.updateScripted(0, P, this.world);
    c.releaseScript(0);
    this.tracker.inspect = 0;
    this.active = false;
  }
}
