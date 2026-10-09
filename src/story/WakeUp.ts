import { Box3, Vector3 } from 'three';
import { clamp, lerp, noise1, saturate, smoothstep } from '../core/math';
import type { Creature, World } from '../character/Creature';
import { blendPose, clonePose, type FootPose, type HandPose, type ScriptPose } from '../character/scriptPose';
import type { PixelRenderer } from '../render/PixelRenderer';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Dust } from '../world/particles';
import type { Footprints } from '../world/footprints';

/**
 * The opening: the creature lies limp and half buried in the sand, the screen
 * dark and out of focus. A click brings it round: the darkness lifts, sound
 * swells in, and it struggles up onto its hooves, shedding sand.
 */

type Ease = 'linear' | 'in' | 'out' | 'inOut';

const ease = (e: Ease, u: number) => {
  switch (e) {
    case 'in':
      return u * u * u;
    case 'out':
      return 1 - (1 - u) * (1 - u) * (1 - u);
    case 'inOut':
      return u * u * u * (u * (u * 6 - 15) + 10);
    default:
      return u;
  }
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mk(base: ScriptPose, over: DeepPartial<ScriptPose>): ScriptPose {
  const p = clonePose(base);
  for (const k of Object.keys(over) as (keyof ScriptPose)[]) {
    const v = over[k];
    if (v && typeof v === 'object') Object.assign(p[k] as object, v);
    else (p as unknown as Record<string, number>)[k] = v as number;
  }
  return p;
}

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({
  x,
  z,
  lift,
  tilt,
  pitch,
  poleDown,
});

// --------------------------------------------------------------------- poses
// Body space: x = the creature's left, y = up, z = forward.

/** Face down in the sand, rolled a little onto its side, limbs where they fell. */
const LIMP: ScriptPose = {
  pelvisX: 0,
  pelvisY: 0.03,
  pelvisZ: -0.4,
  pelvisPitch: 1.5,
  pelvisYaw: -0.3,
  pelvisRoll: 0,
  spinePitch: -0.04,
  chestPitch: 0.02,
  chestRoll: -0.08,
  neckPitch: -0.2,
  headPitch: 0.05,
  headYaw: -1.2,
  headRoll: 0,
  handL: hand(0.36, 0.0, 0.42),
  handR: hand(-0.3, 0.0, -0.18),
  armPitch: 0,
  elbow: -0.2,
  armOut: 0.1,
  footL: foot(0.16, -0.86, 0.02, -1.45, -0.45, 1),
  footR: foot(-0.08, -0.82, 0.02, -1.4, -0.35, 1),
  eyeOpen: 0,
  tremble: 0,
  exertion: 0.08,
};

/** The head comes up off the sand for a moment. */
const STIR = mk(LIMP, {
  neckPitch: -0.75,
  headPitch: -0.3,
  headYaw: -0.55,
  handL: hand(0.34, 0.0, 0.36),
  eyeOpen: 1,
  tremble: 0.35,
  exertion: 0.55,
});

/** And drops back. */
const SLUMP = mk(LIMP, { neckPitch: -0.12, headYaw: -0.9, eyeOpen: 1, tremble: 0.15, exertion: 0.6 });

/** Hands drag in under the shoulders. */
const HANDS_IN = mk(SLUMP, {
  handL: hand(0.28, 0.0, 0.2),
  handR: hand(-0.28, 0.0, 0.2),
  neckPitch: 0.05,
  headYaw: -0.45,
  tremble: 0.3,
  exertion: 0.7,
});

/** Chest pushed up on shaking arms. */
const PUSH1 = mk(HANDS_IN, {
  pelvisY: 0.05,
  pelvisPitch: 1.12,
  pelvisYaw: -0.12,
  spinePitch: -0.14,
  chestPitch: -0.12,
  neckPitch: 0.4,
  headPitch: 0.25,
  headYaw: -0.15,
  tremble: 0.95,
  exertion: 0.9,
});

/** The arms give out. */
const BUCKLE = mk(PUSH1, {
  pelvisPitch: 1.38,
  spinePitch: -0.04,
  chestPitch: -0.02,
  neckPitch: 0.3,
  headPitch: 0.3,
  tremble: 1,
});

/** Second push, higher. */
const PUSH2 = mk(PUSH1, { pelvisY: 0.08, pelvisPitch: 1.0, pelvisYaw: -0.05, spinePitch: -0.16, chestPitch: -0.16, tremble: 1 });

/** On hands and knees, head hanging. */
const FOURS = mk(PUSH2, {
  pelvisY: 0.3,
  pelvisZ: -0.34,
  pelvisPitch: 1.3,
  pelvisYaw: 0,
  spinePitch: 0.04,
  chestPitch: 0.06,
  chestRoll: 0,
  neckPitch: 0.55,
  headPitch: 0.35,
  headYaw: 0,
  handL: hand(0.25, 0.0, 0.18),
  handR: hand(-0.25, 0.0, 0.18),
  footL: foot(0.14, -0.66, 0, -1.5, -1.6, 0.65),
  footR: foot(-0.12, -0.64, 0, -1.5, -1.6, 0.65),
  tremble: 0.75,
  exertion: 0.95,
});

/** The left hoof swings forward under the body. */
const STEP_L = mk(FOURS, {
  pelvisY: 0.34,
  pelvisPitch: 1.0,
  pelvisZ: -0.3,
  footL: foot(0.14, -0.2, 0.16, -0.5, -0.7, 0.3),
  tremble: 0.85,
});

/** Down on one knee, a hand braced on the other, head low. */
const KNEEL = mk(FOURS, {
  pelvisY: 0.36,
  pelvisZ: -0.22,
  pelvisPitch: 0.42,
  spinePitch: 0.16,
  chestPitch: 0.16,
  neckPitch: 0.35,
  headPitch: 0.2,
  headYaw: 0.15,
  handL: hand(0.17, 0.4, 0.12),
  handR: hand(-0.3, 0.02, -0.02, 0.85),
  footL: foot(0.13, 0.2, 0, 0.3, 0, 0),
  footR: foot(-0.12, -0.62, 0, -1.5, -1.6, 0.65),
  tremble: 0.6,
  exertion: 1,
});

/** The back hoof comes up under it. */
const STEP_R = mk(KNEEL, {
  pelvisY: 0.44,
  pelvisPitch: 0.55,
  handL: hand(0.16, 0.44, 0.14),
  handR: hand(-0.3, 0.2, 0.0, 0.3),
  footR: foot(-0.12, -0.46, 0.12, -0.3, -0.4, 0.2),
  tremble: 0.9,
});

/** Pushing up off the knee. */
const RISE = mk(STEP_R, {
  pelvisY: 0.56,
  pelvisZ: -0.06,
  pelvisPitch: 0.58,
  spinePitch: 0.14,
  chestPitch: 0.1,
  neckPitch: 0.3,
  headPitch: 0.15,
  headYaw: 0,
  handL: hand(0.15, 0.46, 0.16, 0.85),
  handR: hand(-0.3, 0.3, 0.0, 0),
  armPitch: 0.15,
  elbow: -0.25,
  armOut: 0.14,
  footL: foot(0.12, 0.14, 0, 0.25, 0, 0),
  footR: foot(-0.11, -0.3, 0, 0.35, 0.15, 0),
  tremble: 0.95,
});

/** Standing, unsteady. */
const STAND = mk(RISE, {
  pelvisY: 0.665,
  pelvisZ: 0,
  pelvisPitch: 0.22,
  spinePitch: 0.06,
  chestPitch: 0.06,
  neckPitch: 0.18,
  headPitch: 0.12,
  handL: hand(0.26, 0.6, 0.02, 0),
  handR: hand(-0.26, 0.6, 0.02, 0),
  armPitch: 0.06,
  elbow: -0.16,
  armOut: 0.12,
  footL: foot(0.1, 0.07, 0, 0.2, 0, 0),
  footR: foot(-0.1, -0.06, 0, 0.2, 0, 0),
  tremble: 0.5,
  exertion: 0.85,
});

/** Head up, taking in the desert. */
const LOOK = mk(STAND, { pelvisPitch: 0.12, spinePitch: 0.03, chestPitch: 0.03, neckPitch: 0.02, headPitch: -0.04, tremble: 0.22 });

const KEYS: { t: number; pose: ScriptPose; ease: Ease }[] = [
  { t: 0, pose: LIMP, ease: 'linear' },
  { t: 0.9, pose: LIMP, ease: 'linear' },
  { t: 2.0, pose: STIR, ease: 'out' },
  { t: 2.5, pose: STIR, ease: 'linear' },
  { t: 2.85, pose: SLUMP, ease: 'in' },
  { t: 3.8, pose: SLUMP, ease: 'linear' },
  { t: 4.7, pose: HANDS_IN, ease: 'inOut' },
  { t: 6.0, pose: PUSH1, ease: 'inOut' },
  { t: 6.35, pose: BUCKLE, ease: 'in' },
  { t: 6.9, pose: BUCKLE, ease: 'linear' },
  { t: 8.0, pose: PUSH2, ease: 'inOut' },
  { t: 9.0, pose: FOURS, ease: 'inOut' },
  { t: 9.7, pose: FOURS, ease: 'linear' },
  { t: 10.25, pose: STEP_L, ease: 'inOut' },
  { t: 10.85, pose: KNEEL, ease: 'out' },
  { t: 11.7, pose: KNEEL, ease: 'linear' },
  { t: 12.2, pose: STEP_R, ease: 'inOut' },
  { t: 12.9, pose: RISE, ease: 'inOut' },
  { t: 14.0, pose: STAND, ease: 'inOut' },
  { t: 15.0, pose: LOOK, ease: 'inOut' },
];
const END = 15.6;
/** World units of view height the opening starts framed at, before drawing back. */
const CLOSE_VIEW_HEIGHT = 5.5;

/** Sounds and moments along the way (seconds after the click). */
interface Beat {
  t: number;
  run: (w: WakeUp) => void;
}

/** How much sand still clings to the body over time. */
const DUST_KEYS: [number, number][] = [
  [0, 1],
  [4.0, 1],
  [4.7, 0.86],
  [6.0, 0.6],
  [6.35, 0.52],
  [8.0, 0.36],
  [9.0, 0.22],
  [10.85, 0.12],
  [12.9, 0.05],
  [14.0, 0],
];

const sampleCurve = (keys: [number, number][], t: number) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return lerp(v0, v1, ease('inOut', (t - t0) / (t1 - t0)));
    }
  }
  return keys[keys.length - 1][1];
};

const _p = new Vector3();
const _box = new Box3();

export class WakeUp {
  state: 'waiting' | 'waking' | 'done' = 'waiting';
  /** Seconds since the click. */
  t = 0;
  private waited = 0;
  private readonly pose = clonePose(LIMP);
  private nextBeat = 0;
  private prevDust = 1;
  private readonly beats: Beat[];
  private grainDebt = 0;

  constructor(
    private readonly creature: Creature,
    private readonly world: World,
    private readonly pr: PixelRenderer,
    readonly audio: AudioEngine,
    private readonly dust: Dust,
    private readonly footprints: Footprints,
    private readonly clock: () => number,
  ) {
    this.creature.rig.dust.value = 1;
    // felt more than heard: the heartbeat skips the fade-in, so it stays low
    const heart = (t: number, level: number): Beat => ({ t, run: (w) => w.audio.heartbeat(level * 0.3) });
    this.beats = [
      heart(0.25, 0.9),
      heart(1.35, 0.85),
      { t: 1.55, run: (w) => w.audio.wakeGasp(0.26) },
      heart(2.4, 0.8),
      { t: 2.8, run: (w) => w.audio.thud(0.24) },
      heart(3.4, 0.7),
      { t: 4.0, run: (w) => w.audio.sandPour(0.22, 1.25) },
      heart(4.3, 0.65),
      { t: 4.7, run: (w) => w.audio.thud(0.176) },
      { t: 4.75, run: (w) => w.audio.thud(0.144) },
      { t: 4.9, run: (w) => w.audio.effort(0.21) },
      heart(5.1, 0.6),
      { t: 5.2, run: (w) => w.hollow() },
      { t: 5.4, run: (w) => w.audio.sandPour(0.3, 1) },
      heart(5.85, 0.55),
      { t: 6.3, run: (w) => w.audio.thud(0.304) },
      { t: 6.35, run: (w) => w.audio.wakeGasp(0.16, false) },
      { t: 6.4, run: (w) => w.audio.sandPour(0.26, 1.1) },
      heart(6.55, 0.5),
      { t: 7.0, run: (w) => w.audio.effort(0.255) },
      heart(7.2, 0.4),
      { t: 7.5, run: (w) => w.audio.sandPour(0.36, 0.9) },
      heart(7.85, 0.3),
      { t: 8.5, run: (w) => w.audio.sandPour(0.3, 1) },
      { t: 8.95, run: (w) => w.audio.thud(0.208) },
      heart(8.5, 0.2),
      { t: 10.2, run: (w) => w.audio.effort(0.165) },
      { t: 10.85, run: (w) => w.audio.thud(0.224) },
      { t: 11.0, run: (w) => w.audio.sandPour(0.18, 1.2) },
      { t: 12.0, run: (w) => w.audio.effort(0.225) },
      { t: 12.9, run: (w) => w.audio.thud(0.2) },
      { t: 13.2, run: (w) => w.audio.sandPour(0.14, 1.3) },
      { t: 14.0, run: (w) => w.audio.thud(0.16) },
      { t: 14.6, run: (w) => w.audio.wakeGasp(0.12) },
    ];
  }

  get active() {
    return this.state !== 'done';
  }

  /** The click: start the sound and begin coming round. */
  begin() {
    if (this.state !== 'waiting') return;
    this.state = 'waking';
    this.t = 0;
    this.audio.start();
    this.audio.wakeUp(9);
  }

  /** Jump past the opening (debug and ?skipintro). */
  skip() {
    this.state = 'done';
    this.creature.rig.dust.value = 0;
    this.pr.zoomMul = 1;
  }

  update(dt: number) {
    const c = this.creature;
    if (this.state === 'waiting') {
      this.waited += dt;
      blendPose(this.pose, LIMP, LIMP, 0);
      // barely breathing
      this.pose.exertion = 0.04;
      c.updateScripted(dt, this.pose, this.world);
      this.screen(-1);
      return;
    }
    if (this.state !== 'waking') return;

    this.t += dt;
    const t = this.t;
    this.samplePose(t);
    this.overlay(t);
    c.updateScripted(dt, this.pose, this.world);

    while (this.nextBeat < this.beats.length && this.beats[this.nextBeat].t <= t) {
      this.beats[this.nextBeat].run(this);
      this.nextBeat++;
    }
    this.shedSand(dt, t);
    this.screen(t);

    if (t >= END) {
      this.state = 'done';
      this.pr.zoomMul = 1;
      c.rig.dust.value = 0;
      c.releaseScript(4);
    }
  }

  private samplePose(t: number) {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].t <= t) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const u = saturate((t - a.t) / (b.t - a.t));
    blendPose(this.pose, a.pose, b.pose, ease(b.ease, u));
  }

  /** Small things on top of the key poses: the eye, glances, the last look around. */
  private overlay(t: number) {
    const p = this.pose;
    // the eye flutters open as it comes to, and squeezes shut when the head falls
    if (t < 1.6) {
      const flick = [0.95, 1.1, 1.22, 1.33, 1.45];
      let open = 0;
      for (let k = 0; k < flick.length; k++) if (t > flick[k]) open = k % 2 === 0 ? 1 : 0.3;
      p.eyeOpen = open;
    } else if (t > 2.75 && t < 3.25) p.eyeOpen = 0.15;
    // a glance around once standing
    if (t > 14.2) {
      const k = smoothstep(14.2, 14.8, t);
      p.headYaw += Math.sin((t - 14.2) * 2.1) * 0.55 * k;
      p.neckPitch -= 0.08 * k;
    }
    // small trembling sways while upright and unsteady
    if (t > 12.9) p.pelvisRoll += noise1(t * 1.7, 5) * 0.05 * (1 - smoothstep(14, END, t));
  }

  /** The hollow the body leaves in the sand, revealed as it rises. */
  hollow() {
    const c = this.creature;
    const yaw = c.yaw;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const at = (x: number, z: number, w: number, l: number) => {
      const wx = c.pos.x + x * cs + z * sn;
      const wz = c.pos.z - x * sn + z * cs;
      this.footprints.addHollow(wx, this.world.height(wx, wz), wz, yaw, this.clock(), w, l);
    };
    at(0, -0.05, 0.42, 0.72); // torso
    at(-0.05, 0.45, 0.36, 0.3); // head
    at(0.04, -0.72, 0.3, 0.6); // legs
    at(0.34, 0.3, 0.12, 0.34); // left arm
    at(-0.3, -0.2, 0.12, 0.32); // right arm
  }

  /** Sand slides off as the coat thins: emit grains from random points on the body. */
  private shedSand(dt: number, t: number) {
    const rig = this.creature.rig;
    const coat = sampleCurve(DUST_KEYS, t);
    rig.dust.value = coat;
    const lost = Math.max(0, this.prevDust - coat);
    this.prevDust = coat;
    this.grainDebt += lost * 1400 + (coat > 0.02 && t > 4 ? dt * 25 : 0);
    const parts = rig.parts;
    while (this.grainDebt >= 1) {
      this.grainDebt -= 1;
      const m = parts[Math.floor(Math.random() * parts.length)];
      m.geometry.computeBoundingBox();
      _box.copy(m.geometry.boundingBox!);
      _p.set(
        lerp(_box.min.x, _box.max.x, Math.random()),
        lerp(_box.min.y, _box.max.y, Math.random()),
        lerp(_box.min.z, _box.max.z, Math.random()),
      );
      m.localToWorld(_p);
      const ground = this.world.height(_p.x, _p.z);
      if (_p.y < ground + 0.01) continue;
      this.dust.emit(
        _p.x,
        _p.y,
        _p.z,
        (Math.random() - 0.5) * 0.5,
        Math.random() * 0.35,
        (Math.random() - 0.5) * 0.5,
        0.5 + Math.random() * 0.6,
        Math.random() < 0.35,
      );
    }
  }

  /** Darkness, blur, colour and vignette. t < 0 is the limp state before the click. */
  private screen(t: number) {
    const pr = this.pr;
    const w = this.waited;
    // close on the body at first, drawing back as it stands
    const close = Math.max(1, pr.baseViewHeight / CLOSE_VIEW_HEIGHT);
    pr.zoomMul = lerp(close, 1, t < 0 ? 0 : smoothstep(5.5, 14.5, t));
    if (t < 0) {
      // slow, faint pulse: still alive in there
      const pulse = Math.sin(w * 0.9) * 0.5 + 0.5;
      pr.dark = 0.86 - pulse * 0.05;
      pr.blur = 4.5 + pulse * 0.8;
      pr.ghost = 0;
      pr.desat = 0.75;
      pr.vignette = 1;
      return;
    }
    const pulse = Math.sin(t * 2.6) * 0.5 + 0.5;
    let dark = sampleCurve(
      [
        [0, 0.86],
        [1.5, 0.55],
        [4, 0.3],
        [7, 0.1],
        [10, 0],
      ],
      t,
    );
    // the world dims again as the head falls back
    dark += 0.25 * smoothstep(2.6, 2.85, t) * (1 - smoothstep(2.9, 3.6, t));
    pr.dark = clamp(dark + pulse * 0.04 * (1 - smoothstep(4, 8, t)), 0, 1);
    // focus pulls in and out before it holds
    const blur = sampleCurve(
      [
        [0, 5],
        [1.5, 3.2],
        [5, 1.6],
        [8.5, 0.7],
        [11, 0],
      ],
      t,
    );
    pr.blur = Math.max(0, blur * (1 + Math.sin(t * 1.7) * 0.3));
    // double vision while straining to push up
    pr.ghost = 2.2 * smoothstep(4.6, 5.6, t) * (1 - smoothstep(8, 9.5, t)) * (0.6 + 0.4 * Math.sin(t * 3.1));
    pr.desat = 0.75 * (1 - smoothstep(0.5, 9, t));
    pr.vignette = 1 - smoothstep(1, 12.5, t);
  }

  /** The cursor appears slowly as the creature gets up. */
  get cursorAlpha() {
    if (this.state === 'waiting') return 0;
    if (this.state === 'done') return 1;
    return smoothstep(7.5, 14.5, this.t);
  }

  /** Where the camera looks: low over the body, rising with it. */
  focus(out: Vector3) {
    const c = this.creature;
    const up = this.state === 'waking' ? smoothstep(4, 14, this.t) : 0;
    const fwd = lerp(0.1, 0, up);
    out.set(c.pos.x + Math.sin(c.yaw) * fwd, c.pos.y + lerp(0.2, 0.6, up), c.pos.z + Math.cos(c.yaw) * fwd);
    return out;
  }
}
