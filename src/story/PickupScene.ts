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
  pelvisY: 0.33,
  pelvisZ: -0.06,
  pelvisPitch: 0.78,
  spinePitch: 0.3,
  chestPitch: 0.22,
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

/** Up again, the device in the right hand in front of its chest, the left coming over to brush it off. */
const LIFTED = mk(CALM, {
  pelvisPitch: 0.16,
  neckPitch: 0.3,
  headPitch: 0.42,
  headRoll: -0.06,
  handL: hand(0.06, 0.86, 0.34, 1),
  handR: hand(-0.08, 0.84, 0.3, 1),
  footL: foot(0.1, 0.06, 0, 0.2, 0, 0),
  footR: foot(-0.1, -0.06, 0, 0.2, 0, 0),
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
  { t: 1.05, pose: GRAB, ease: 'inOut' },
  { t: 1.55, pose: GRAB, ease: 'linear' },
  { t: 2.3, pose: RISE, ease: 'inOut' },
  { t: 2.6, pose: LIFTED, ease: 'out' },
  { t: 3.35, pose: LIFTED, ease: 'linear' },
  { t: 3.75, pose: STUDY, ease: 'inOut' },
  { t: 4.6, pose: STUDY2, ease: 'inOut' },
  { t: 5.2, pose: STUDY2, ease: 'linear' },
  { t: 6.0, pose: CARRY, ease: 'inOut' },
];
/** After that: just scooped up. */
const AGAIN: Key[] = [
  { t: 0, pose: CALM, ease: 'linear' },
  { t: 0.4, pose: BEND, ease: 'inOut' },
  { t: 0.85, pose: GRAB, ease: 'inOut' },
  { t: 1.2, pose: GRAB, ease: 'linear' },
  { t: 1.8, pose: RISE, ease: 'inOut' },
  { t: 2.45, pose: CARRY, ease: 'inOut' },
];

/** The beats of each version: when the hoof touches it, closes on it, and the rest. */
interface Beats {
  touch: number;
  grab: number;
  /** Stepping back clear of the hull as it rises. */
  back: [number, number];
  /** Turning to the camera (first time). */
  turn: [number, number];
  /** The left hand brushing the sand off (first time). */
  brush: [number, number];
  /** Held up in both hands (first time): in from, in to, out from, out to. */
  inspect: [number, number, number, number];
  wake: number;
}
const FIRST_BEATS: Beats = {
  touch: 1.12,
  grab: 1.32,
  back: [1.6, 2.45],
  turn: [1.95, 2.85],
  brush: [2.55, 3.35],
  inspect: [3.3, 3.75, 5.2, 5.75],
  wake: 3.7,
};
const AGAIN_BEATS: Beats = {
  touch: 0.84,
  grab: 0.98,
  back: [1.1, 1.85],
  turn: [-1, -1],
  brush: [-1, -1],
  inspect: [-1, -1, -1, -1],
  wake: -1,
};
/** How far in front of it to kneel (the knee lands a little short of it). */
export const PICK_REACH = 0.34;

const _v = new Vector3();

/**
 * Picking the tracker up: the creature steps up to it, bends, sinks onto one
 * knee and takes it in its right hand, and rises. The first time, it lifts it
 * to its chest, brushes the sand off it, and holds it up in both hands as it
 * wakes.
 */
export class PickupScene {
  active = false;
  t = 0;
  /** 0..1 how far the scene has drawn the camera in. */
  weight = 0;
  private keys: Key[] = FIRST;
  private beats: Beats = FIRST_BEATS;
  private end = 6;
  private first = true;
  private grabbed = false;
  private touched = false;
  private stroke = 0;
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
    this.touched = false;
    this.stroke = 0;
    this.first = !this.tracker.awake;
    this.keys = this.first ? FIRST : AGAIN;
    this.beats = this.first ? FIRST_BEATS : AGAIN_BEATS;
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
    const k = this.first ? smoothstep(2.0, 2.8, this.t) * (1 - smoothstep(5.2, 6.0, this.t)) : 0;
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
    const B = this.beats;
    const out = smoothstep(B.back[0], B.back[1], t);
    c.pos.x += this.back.x * out;
    c.pos.z += this.back.z * out;
    let yaw = this.startYaw + dy * k;
    if (this.first) {
      // rising, it turns round to look at what it has found
      let ds = this.studyYaw - this.yaw;
      ds = Math.atan2(Math.sin(ds), Math.cos(ds));
      yaw += ds * ease('inOut', smoothstep(B.turn[0], B.turn[1], t));
      const [i0, i1, o0, o1] = B.inspect;
      this.tracker.inspect = smoothstep(i0, i1, t) * (1 - smoothstep(o0, o1, t));
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

    // The right hand: it reaches out over the device, comes down and touches it
    // (it shifts a little), closes on it, and lifts it slowly as if weighing it,
    // straight up off the ground, before easing into the keyed pose.
    const h = P.handR;
    const touch = B.touch;
    const ga = B.grab;
    if (!this.grabbed) {
      this.tracker.grabPoint(this.grab);
      this.toBody(this.grab, this.hold);
      // over it first, then down onto it
      this.hold.y += 0.11 * (1 - smoothstep(touch - 0.3, touch, t));
    }
    const lift = 0.17 * ease('inOut', smoothstep(ga + 0.05, ga + 0.7, t));
    const reach = smoothstep(0.15, touch - 0.1, t) * (1 - smoothstep(ga + 0.45, ga + 1.0, t));
    if (reach > 0) {
      h.x = lerp(h.x, this.hold.x, reach);
      h.y = lerp(h.y, this.hold.y + lift, reach);
      h.z = lerp(h.z, this.hold.z, reach);
      h.ik = lerp(h.ik, 1, reach);
    }
    if (!this.touched && t >= touch) {
      this.touched = true;
      this.tracker.nudge(Math.sin(c.yaw) * 0.012, Math.cos(c.yaw) * 0.012);
    }
    if (!this.grabbed && t >= ga) {
      this.grabbed = true;
      // pose the hand where it is now, so the device is taken from exactly there
      c.updateScripted(0, P, this.world);
      this.tracker.take(c);
      c.carrying = true;
      this.audio.effort(0.08);
    }

    // the first time, the left hand brushes the sand off its face: two strokes across it
    if (B.brush[0] >= 0) {
      const [b0, b1] = B.brush;
      const w = smoothstep(b0 - 0.1, b0 + 0.1, t) * (1 - smoothstep(b1 - 0.1, b1 + 0.1, t));
      if (w > 0) {
        const u = clamp((t - b0) / (b1 - b0), 0, 1);
        this.toBody(this.tracker.position, this.dev);
        const sweep = Math.sin(u * Math.PI * 4);
        const L = P.handL;
        L.x = lerp(L.x, this.dev.x + 0.045 + 0.075 * sweep, w);
        L.y = lerp(L.y, this.dev.y + 0.03 + 0.02 * Math.abs(sweep), w);
        L.z = lerp(L.z, this.dev.z + 0.05, w);
        L.ik = lerp(L.ik, 1, w);
        const n = Math.floor(u * 4);
        if (n > this.stroke && n <= 4) {
          this.stroke = n;
          this.tracker.sandPuff(4);
          this.audio.scuff(0.035);
        }
      }
    }
    if (B.wake >= 0 && t >= B.wake && t - dt < B.wake) this.tracker.wake();

    c.updateScripted(dt, P, this.world);
    if (t >= end) this.finish();
  }

  private readonly dev = new Vector3();

  /** A world point to body space (x its left, y above the ground under it, z ahead). */
  private toBody(w: Vector3, out: Vector3) {
    const c = this.creature;
    const cy = Math.cos(c.yaw);
    const sy = Math.sin(c.yaw);
    const dx = w.x - c.pos.x;
    const dz = w.z - c.pos.z;
    return out.set(dx * cy - dz * sy, w.y - this.world.height(w.x, w.z), dx * sy + dz * cy);
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
