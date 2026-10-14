import { Euler, Matrix4, Vector2, Vector3 } from 'three';
import {
  clamp,
  damp,
  Dyn,
  DynAngle,
  lerp,
  noise1,
  saturate,
  smoothstep,
  TAU,
  unwrapNear,
  wrapAngle,
} from '../core/math';
import { CreatureRig, LEG, orient, type Skin } from './rig';
import { pushOutOfRock, type RockInfo } from '../world/rocks';
import type { ScriptPose } from './scriptPose';

export interface CreatureInput {
  /** Screen-space move intent: x right, y up. Length 0..1. */
  move: Vector2;
  sprint: boolean;
  crouch: boolean;
  /** World point to look at, or null to look ahead. */
  look: Vector3 | null;
}

export interface StepEvent {
  x: number;
  y: number;
  z: number;
  yaw: number;
  side: number;
  speed: number;
  run: number;
  crouch: number;
  scuff: boolean;
}

/** Sound cues from the stamina system. */
export type StaminaCue = 'warn' | 'warn-late' | 'exhausted';

export interface World {
  height(x: number, z: number): number;
  rocks: RockInfo[];
  /** Where slopes too steep to climb stop the creature (cliffs), if anywhere. */
  cliffs?: (x: number, z: number) => boolean;
}

/** Steeper than this (rise over run) is a cliff: it cannot be walked up. */
const CLIFF = 1.15;

const WALK_SPEED = 1.85;
const SPRINT_SPEED = 6.3;
const CROUCH_SPEED = 1.05;
/** A full stamina lasts this many seconds of sprinting. */
export const SPRINT_SECONDS = 9;
/** Stamina refills from empty in this many seconds. */
export const RECOVER_SECONDS = 13;
/** The warning comes this many seconds before stamina runs out. */
const WARN_SECONDS = 2;
const TIRED_WALK_SPEED = 1.35;
const HIP_HEIGHT = 0.7;
const WALK_HIP = 0.645;
const CROUCH_HIP = 0.45;
const BODY_RADIUS = 0.27;
/** Rocks smaller than this (footprint radius) are stepped over. */
const PEBBLE_RADIUS = 0.2;
const HOOF_RADIUS = 0.07;
const LEG_REACH = LEG.thigh + LEG.shin + LEG.cannon * 0.92;

class Foot {
  readonly pos = new Vector3();
  readonly lift = new Vector3();
  readonly target = new Vector3();
  yaw = 0;
  liftYaw = 0;
  targetYaw = 0;
  swing = false;
  idle = false;
  t = 0;
  S = 0.4;
  height = 0.08;
  idleDur = 0.22;
  prevLp = 0;
  /** Cannon tilt, radians back from vertical. */
  tilt = 0.35;
  /** Toe pitch of the hoof. */
  pitch = 0;
  /** 0..1: knee points down instead of forward (kneeling, lying). */
  poleDown = 0;
  constructor(readonly side: number, readonly offset: number) {}
}

const easeSwing = (t: number) => {
  const s = smoothstep(0.0, 1.0, t);
  return lerp(t, s, 0.75);
};

const _v = new Vector3();
const _v2 = new Vector3();
const _hip = new Vector3();
const _fet = new Vector3();
const _hock = new Vector3();
const _knee = new Vector3();
const _dir = new Vector3();
const _pole = new Vector3();
const _down = new Vector3(0, -1, 0);
const _fwd = new Vector3();
const _e = new Euler();
const _n2 = new Vector2();

export class Creature {
  readonly rig: CreatureRig;
  /** Logical ground position (x, z) and ground height (y). */
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  yaw = 0;
  private yawTarget = 0;
  private readonly yawDyn = new DynAngle(1.9, 0.85, 0);
  private yawRate = 0;

  private readonly feet: [Foot, Foot] = [new Foot(1, 0), new Foot(-1, 0.5)];
  private phase = 0;
  private gaitActive = false;
  private cadence = 0;
  private swingFrac = 0.4;
  private run = 0;
  private crouch = 0;
  private readonly crouchDyn = new Dyn(2.4, 0.62, 0);
  private lastIdleStep = 0;
  private time = 0;
  private idleTime = 0;

  private readonly groundDyn = new Dyn(5, 1, 0);
  private readonly pelvisDyn = new Dyn(5.5, 0.55, 0);
  private readonly leanDyn = new Dyn(2.6, 0.5, 0);
  private readonly bankDyn = new Dyn(2.2, 0.6, 0);
  private readonly lookYawDyn = new Dyn(2.6, 0.78, 0);
  private readonly lookPitchDyn = new Dyn(2.2, 0.8, 0);
  private readonly lookRollDyn = new Dyn(2.0, 0.7, 0);
  private readonly armDyn = [new Dyn(4.2, 0.5, 0), new Dyn(4.2, 0.5, 0)];
  private readonly elbowDyn = [new Dyn(3.5, 0.55, 0), new Dyn(3.5, 0.55, 0)];
  private readonly armOutDyn = [new Dyn(3, 0.6, 0), new Dyn(3, 0.6, 0)];
  private prevSpeed = 0;
  private accelFwd = 0;

  private breathPhase = 0;
  exertion = 0;

  /** 0..1. Sprinting drains it in SPRINT_SECONDS; it refills in RECOVER_SECONDS. */
  stamina = 1;
  /** True from running out until stamina is full again: no sprinting meanwhile. */
  exhausted = false;
  /** 0..1, how ragged the last seconds of a sprint look. */
  strain = 0;
  /** 0..1, how tired the creature looks while it recovers. */
  tired = 0;
  private warned = 0;
  /** Time to the next deep recovery breath, and its 0..1 envelope. */
  private sighTimer = 2.5;
  /** Seconds of grogginess left after a scripted wake-up. */
  private groggy = 0;
  private sighT = -1;
  readonly cues: StaminaCue[] = [];
  private blinkTimer = 2.5;
  private blinkT = -1;

  /** Snap the drawn body to the texel grid (provided by the renderer). */
  snap: (p: Vector3, out: Vector3) => Vector3 = (_p, out) => out.set(0, 0, 0);
  readonly events: StepEvent[] = [];
  /** 0..1 breath cycle value, exposed for sound. */
  breath = 0;
  breathRate = 0.3;

  /** 0..1 target: hold something out in both hands in front of the chest and look down at it. */
  holdOut = 0;
  /** When set and not walking, turn on the spot to face this way (radians). */
  faceYaw: number | null = null;
  /** Carrying something in the right hand: that arm swings less and its elbow bends. */
  carrying = false;
  /** How far the hold-out has come (eased toward holdOut). */
  readonly holdDyn = new Dyn(1.6, 0.95, 0);
  /** How far the carrying arm is held out, aimed where the head looks (eased). */
  readonly aimDyn = new Dyn(1.1, 0.9, 0);
  /** The way the carried thing points, on the ground (radians, like `yaw`). */
  pointYaw = 0;

  /** Set to drive the breathing from a script: the -1..1 breath and its size. */
  scriptBreath: { value: number; amp: number } | null = null;
  /** 0..1: a glance back over its shoulder at what it is looking at, even while running. */
  glance = 0;
  /** 0..1: panic. Breathing hard and fast, eyes and head darting, a shiver through the body. */
  panic = 0;
  /** True to hold the carrying arm still (the cursor is right by the body, to click what it holds). */
  aimHold = false;
  private readonly glanceDyn = new Dyn(3.2, 0.8, 0);

  constructor(world: World, x = 0, z = 0, skin?: Skin) {
    this.rig = new CreatureRig(skin);
    this.crouchDyn.reset(0);
    this.teleport(x, z, world);
  }

  /** Face a direction at once. */
  setYaw(yaw: number) {
    this.yaw = yaw;
    this.yawTarget = yaw;
    this.yawDyn.reset(yaw);
    for (const f of this.feet) f.yaw = yaw;
  }

  /** Move instantly (used for story beats and debugging). */
  teleport(x: number, z: number, world: World) {
    this.pos.set(x, 0, z);
    this.vel.set(0, 0, 0);
    this.gaitActive = false;
    // never start inside a rock
    for (let pass = 0; pass < 4; pass++) {
      for (const r of world.rocks) {
        if (r.radius >= PEBBLE_RADIUS) pushOutOfRock(r, this.pos, BODY_RADIUS, _n2);
      }
    }
    this.pos.y = world.height(this.pos.x, this.pos.z);
    this.groundDyn.reset(this.pos.y);
    this.pelvisDyn.reset(this.pos.y + HIP_HEIGHT);
    for (const f of this.feet) {
      f.swing = false;
      this.restPosition(f, this.yaw, f.pos);
      for (const r of world.rocks) pushOutOfRock(r, f.pos, HOOF_RADIUS, _n2);
      f.pos.y = world.height(f.pos.x, f.pos.z);
      f.yaw = this.yaw;
    }
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** 0..1, how hard the creature is digging in to stop. */
  get skid() {
    return saturate((-this.accelFwd - 4) / 8) * saturate((this.speed - 1) / 3);
  }

  get running() {
    return this.run;
  }

  get crouching() {
    return this.crouch;
  }

  private forward(yaw: number, out: Vector3) {
    return out.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  /** Where a foot stands at rest for the given body yaw. */
  private restPosition(f: Foot, yaw: number, out: Vector3, at = this.pos) {
    const w = LEG.hipWidth * (1 + this.crouch * 0.35);
    return out.set(at.x + Math.cos(yaw) * w * f.side, 0, at.z - Math.sin(yaw) * w * f.side);
  }

  update(dt: number, input: CreatureInput, world: World) {
    this.time += dt;
    this.events.length = 0;
    this.cues.length = 0;
    this.locomotion(dt, input, world);
    this.gait(dt, world);
    this.pose(dt, input, world);
  }

  // ---------------------------------------------------------------- movement

  private locomotion(dt: number, input: CreatureInput, world: World) {
    const moveLen = Math.min(1, input.move.length());
    const crouching = input.crouch;
    this.crouch = saturate(this.crouchDyn.update(dt, crouching ? 1 : 0));
    const sprinting = input.sprint && !crouching && moveLen > 0.1 && !this.exhausted;
    this.updateStamina(dt, sprinting);
    const maxSpeed = crouching
      ? CROUCH_SPEED
      : sprinting
        ? SPRINT_SPEED * (1 - 0.1 * this.strain)
        : lerp(WALK_SPEED, TIRED_WALK_SPEED, this.tired);

    // desired direction on the ground: screen up is world -Z
    const dx = moveLen > 0 ? input.move.x / input.move.length() : 0;
    const dz = moveLen > 0 ? -input.move.y / input.move.length() : 0;

    // slope: slower uphill, a little faster downhill
    let slopeMul = 1;
    if (moveLen > 0) {
      const h0 = world.height(this.pos.x, this.pos.z);
      const h1 = world.height(this.pos.x + dx * 0.6, this.pos.z + dz * 0.6);
      const grade = (h1 - h0) / 0.6;
      slopeMul = clamp(1 - grade * 0.55, 0.55, 1.12);
    }

    const target = maxSpeed * moveLen * slopeMul;
    const tvx = dx * target;
    const tvz = dz * target;
    const speeding = target > this.speed;
    const rate = moveLen > 0 ? (speeding ? (sprinting ? 3.2 : 6.5) : 7) : 8.5;
    this.vel.x = damp(this.vel.x, tvx, rate, dt);
    this.vel.z = damp(this.vel.z, tvz, rate, dt);

    const ox = this.pos.x;
    const oz = this.pos.z;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // a cliff: the part of the step that would climb it is taken back
    if (world.cliffs?.(this.pos.x, this.pos.z)) {
      const e = 0.2;
      const gx = (world.height(this.pos.x + e, this.pos.z) - world.height(this.pos.x - e, this.pos.z)) / (2 * e);
      const gz = (world.height(this.pos.x, this.pos.z + e) - world.height(this.pos.x, this.pos.z - e)) / (2 * e);
      const s = Math.hypot(gx, gz);
      if (s > CLIFF) {
        const nx = gx / s;
        const nz = gz / s;
        const up = (this.pos.x - ox) * nx + (this.pos.z - oz) * nz;
        if (up > 0) {
          this.pos.x -= up * nx;
          this.pos.z -= up * nz;
          const vu = this.vel.x * nx + this.vel.z * nz;
          if (vu > 0) {
            this.vel.x -= vu * nx;
            this.vel.z -= vu * nz;
          }
        }
      }
    }

    // rocks push us out; a few passes settle corners between rocks
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const r of world.rocks) {
        if (r.radius < PEBBLE_RADIUS) continue; // small stones are stepped over
        if (!pushOutOfRock(r, this.pos, BODY_RADIUS, _n2)) continue;
        moved = true;
        const vn = this.vel.x * _n2.x + this.vel.z * _n2.y;
        if (vn < 0) {
          this.vel.x -= vn * _n2.x;
          this.vel.z -= vn * _n2.y;
        }
      }
      if (!moved) break;
    }

    this.pos.y = this.groundDyn.update(dt, world.height(this.pos.x, this.pos.z));

    const speed = this.speed;
    const accel = (speed - this.prevSpeed) / Math.max(dt, 1e-4);
    this.prevSpeed = speed;
    this.accelFwd = damp(this.accelFwd, clamp(accel, -20, 20), 10, dt);

    // facing
    if (moveLen > 0.1) {
      this.yawTarget = Math.atan2(dx, dz);
    } else if (speed > 0.4) {
      this.yawTarget = Math.atan2(this.vel.x, this.vel.z);
    }
    this.idleTime = speed < 0.1 && moveLen === 0 ? this.idleTime + dt : 0;
    if (input.look && speed < 0.25 && moveLen === 0) {
      const lookYaw = Math.atan2(input.look.x - this.pos.x, input.look.z - this.pos.z);
      const dist = Math.hypot(input.look.x - this.pos.x, input.look.z - this.pos.z);
      const rel = wrapAngle(lookYaw - this.yawTarget);
      if (dist > 0.6 && Math.abs(rel) > 1.25) {
        this.yawTarget = lookYaw - Math.sign(rel) * 0.55;
      }
    }
    if (this.faceYaw !== null && moveLen === 0) this.yawTarget = this.faceYaw;
    const turnF = lerp(1.9, 2.6, this.run) * (1 - this.crouch * 0.25);
    this.yawDyn.setParams(turnF, 0.85, 0);
    const prevYaw = this.yaw;
    this.yaw = this.yawDyn.update(dt, unwrapNear(this.yaw, this.yawTarget));
    this.yawRate = damp(this.yawRate, (this.yaw - prevYaw) / Math.max(dt, 1e-4), 12, dt);
  }

  // ----------------------------------------------------------------- stamina

  private updateStamina(dt: number, sprinting: boolean) {
    if (sprinting && this.speed > 0.5) this.stamina -= dt / SPRINT_SECONDS;
    else if (!sprinting) this.stamina += dt / RECOVER_SECONDS;
    this.stamina = saturate(this.stamina);

    if (!this.exhausted && this.stamina <= 0) {
      this.exhausted = true;
      this.cues.push('exhausted');
    } else if (this.exhausted && this.stamina >= 1) {
      this.exhausted = false;
    }

    // a faint wheeze two seconds before running out, and another near the end
    const left = this.stamina * SPRINT_SECONDS;
    if (sprinting && !this.exhausted) {
      if (this.warned === 0 && left < WARN_SECONDS) {
        this.warned = 1;
        this.cues.push('warn');
      } else if (this.warned === 1 && left < 0.9) {
        this.warned = 2;
        this.cues.push('warn-late');
      }
    }
    if (left > WARN_SECONDS + 0.5) this.warned = 0;

    const strainTarget = sprinting && !this.exhausted ? smoothstep(WARN_SECONDS, 0, left) : 0;
    this.strain = damp(this.strain, strainTarget, strainTarget > this.strain ? 4 : 2, dt);
    // tired through the recovery, easing off over its last few seconds
    let tiredTarget = this.exhausted ? 1 - smoothstep(0.72, 1, this.stamina) : 0;
    if (this.groggy > 0) {
      this.groggy -= dt;
      tiredTarget = Math.max(tiredTarget, 0.6 * smoothstep(0, 2.5, this.groggy));
    }
    this.tired = damp(this.tired, tiredTarget, 2.5, dt);
  }

  // -------------------------------------------------------------------- gait

  private gait(dt: number, world: World) {
    const speed = this.speed;
    this.run = smoothstep(2.7, 4.8, speed);
    const crouch = this.crouch;
    const walkCad = 1.1 + 0.42 * speed;
    const runCad = 1.5 + 0.17 * speed;
    this.cadence = lerp(walkCad, runCad, this.run) * (1 - crouch * 0.12) * (1 - this.tired * 0.12);
    this.swingFrac = lerp(0.38, 0.62, this.run);

    const wasActive = this.gaitActive;
    if (this.gaitActive && speed < 0.07) this.gaitActive = false;
    else if (!this.gaitActive && speed > 0.14) this.gaitActive = true;

    if (this.gaitActive && !wasActive) this.restartGait();

    const phaseSwing = this.feet.some((f) => f.swing && !f.idle);
    if (this.gaitActive || phaseSwing) {
      const cad = this.gaitActive ? this.cadence : Math.max(this.cadence, 1.8);
      this.phase = (this.phase + cad * dt) % 1;
    }

    for (const f of this.feet) {
      const lp = (this.phase + f.offset) % 1;
      if (!f.swing) {
        if (this.gaitActive && lp < f.prevLp) this.beginSwing(f, false);
      }
      if (f.swing && !f.idle) {
        const wrapped = lp < f.prevLp && f.t > 0.5;
        f.t = wrapped ? 1 : Math.min(1, lp / f.S);
      } else if (f.swing && f.idle) {
        f.t = Math.min(1, f.t + dt / f.idleDur);
      }
      f.prevLp = lp;
      if (f.swing) {
        this.updateSwing(f, world);
        if (f.t >= 1) this.land(f, world);
      }
    }

    // idle balance steps: keep feet under the body when standing and turning
    if (!this.gaitActive && !this.feet.some((f) => f.swing)) {
      let worst: Foot | null = null;
      let worstErr = 0;
      for (const f of this.feet) {
        this.restPosition(f, this.yaw, _v);
        const err = Math.hypot(f.pos.x - _v.x, f.pos.z - _v.z) + Math.abs(wrapAngle(f.yaw - this.yaw)) * 0.12;
        if (err > worstErr) {
          worstErr = err;
          worst = f;
        }
      }
      const threshold = this.idleTime > 0.35 ? 0.075 : 0.16;
      if (worst && worstErr > threshold && this.time - this.lastIdleStep > 0.12) {
        this.beginSwing(worst, true);
      }
    }
  }

  private restartGait() {
    const swinging = this.feet.find((f) => f.swing);
    if (swinging) {
      // hand an in-progress balance step over to the gait cycle
      this.phase = (swinging.t * this.swingFrac - swinging.offset + 1) % 1;
      swinging.idle = false;
      swinging.S = this.swingFrac;
    } else {
      // the foot further behind steps first
      const vx = this.vel.x;
      const vz = this.vel.z;
      const a = (this.feet[0].pos.x - this.pos.x) * vx + (this.feet[0].pos.z - this.pos.z) * vz;
      const b = (this.feet[1].pos.x - this.pos.x) * vx + (this.feet[1].pos.z - this.pos.z) * vz;
      const first = a < b ? this.feet[0] : this.feet[1];
      this.phase = (1 - first.offset - 0.002 + 1) % 1;
    }
    for (const f of this.feet) f.prevLp = (this.phase + f.offset) % 1;
  }

  private beginSwing(f: Foot, idle: boolean) {
    f.swing = true;
    f.idle = idle;
    f.t = 0;
    f.S = this.swingFrac;
    f.lift.copy(f.pos);
    f.liftYaw = f.yaw;
    const crouch = this.crouch;
    if (idle) {
      f.idleDur = 0.2 + crouch * 0.08;
      f.height = 0.055 * (1 - crouch * 0.3);
      this.lastIdleStep = this.time;
    } else {
      // tired hooves barely leave the sand
      f.height =
        lerp(0.07, 0.15, this.run) * (1 - crouch * 0.35) * lerp(0.5, 1, saturate(this.speed / 1.2)) * (1 - this.tired * 0.45);
    }
  }

  private computeTarget(f: Foot, world: World) {
    if (f.idle) {
      this.restPosition(f, this.yaw, f.target);
      f.targetYaw = this.yaw;
    } else {
      const cad = Math.max(this.cadence, 0.6);
      const remain = (1 - f.t) * (f.S / cad);
      const stance = (1 - this.swingFrac) / cad;
      const landYaw = this.yaw + clamp(wrapAngle(this.yawTarget - this.yaw), -0.7, 0.7) * 0.6;
      _v2.copy(this.pos).addScaledVector(this.vel, remain + stance * 0.5);
      this.restPosition(f, landYaw, f.target, _v2);
      f.targetYaw = landYaw;
    }
    // never plant a hoof inside a rock
    for (let pass = 0; pass < 2; pass++) {
      for (const r of world.rocks) pushOutOfRock(r, f.target, HOOF_RADIUS, _n2);
    }
    f.target.y = world.height(f.target.x, f.target.z);
  }

  private updateSwing(f: Foot, world: World) {
    this.computeTarget(f, world);
    const t = f.t;
    const e = easeSwing(t);
    const x = lerp(f.lift.x, f.target.x, e);
    const z = lerp(f.lift.z, f.target.z, e);
    const base = Math.max(lerp(f.lift.y, f.target.y, e), world.height(x, z));
    const arc = Math.sin(Math.PI * Math.pow(t, 0.8));
    f.pos.set(x, base + arc * f.height, z);
    // a running hoof kicks up and back early in the swing
    if (!f.idle && this.run > 0) {
      const k = Math.sin(Math.PI * t) * (1 - t) * this.run;
      this.forward(this.yaw, _fwd);
      f.pos.addScaledVector(_fwd, -k * 0.32);
      f.pos.y += k * 0.2;
    }
    const yd = wrapAngle(f.targetYaw - f.liftYaw);
    f.yaw = f.liftYaw + yd * e;
  }

  private land(f: Foot, world: World) {
    f.swing = false;
    f.t = 0;
    f.pos.copy(f.target);
    f.pos.y = world.height(f.pos.x, f.pos.z);
    f.yaw = f.targetYaw;
    const speed = this.speed;
    // weight of the landing drops the pelvis a little
    this.pelvisDyn.yd -= (0.12 + speed * 0.07) * (1 - this.crouch * 0.5) * (1 + this.strain * 0.5 + this.tired * 0.3);
    this.events.push({
      x: f.pos.x,
      y: f.pos.y,
      z: f.pos.z,
      yaw: f.yaw,
      side: f.side,
      speed,
      run: this.run,
      crouch: this.crouch,
      scuff: f.idle,
    });
  }

  // -------------------------------------------------------------------- pose

  private pose(dt: number, input: CreatureInput, world: World) {
    const rig = this.rig;
    const speed = this.speed;
    const run = this.run;
    const crouch = this.crouch;
    const moving = saturate(speed / 1.2);
    const S = this.swingFrac;
    const phase = this.phase;
    const midL = S + (1 - S) / 2;
    const t = this.time;

    // exertion, breathing, blinking
    if (run > 0.5) this.exertion = Math.min(1, this.exertion + dt * 0.09 * run);
    else this.exertion = Math.max(0, this.exertion - dt * (speed < 0.2 ? 0.06 : 0.035));
    // out of breath: pant hard, slowing as stamina comes back
    const tired = this.tired;
    const strain = this.strain;
    const recovery = this.exhausted ? this.stamina : 1;
    this.exertion = Math.max(this.exertion, strain * 0.9, tired * lerp(1, 0.45, recovery), this.panic * 0.85);
    this.breathRate = lerp(0.27, 1.25, this.exertion) + run * 0.3;
    this.breathPhase = (this.breathPhase + dt * this.breathRate) % 1;
    const breath = Math.sin(this.breathPhase * TAU);
    this.breath = breath;
    const breathAmp = lerp(0.6, 1.6, this.exertion) * (1 + tired * 0.6);
    // tired standing: bent over, hands on thighs, straightening as breath returns
    const tiredIdle = tired * (1 - moving);
    const tiredWalk = tired * moving;
    // now and then a slow, deep breath: straighten a little, lift the head, sink back
    let sigh = 0;
    if (tiredIdle > 0.3) {
      this.sighTimer -= dt;
      if (this.sighTimer <= 0 && this.sighT < 0) {
        this.sighT = 0;
        this.sighTimer = 3.2 + Math.random() * 2.5;
      }
    }
    if (this.sighT >= 0) {
      this.sighT += dt;
      const st = this.sighT;
      sigh = st < 0.7 ? smoothstep(0, 0.7, st) : 1 - smoothstep(0.7, 1.8, st);
      if (st > 1.8) this.sighT = -1;
    }
    sigh *= tiredIdle;
    const bendOver = tiredIdle * lerp(0.95, 0.3, recovery) * (1 - sigh * 0.3);

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkT = 0;
      this.blinkTimer = 1.8 + Math.random() * 4.5;
      if (Math.random() < 0.18) this.blinkTimer = 0.28;
    }
    let eyeScale = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const blinkLen = 0.11 + tired * 0.14;
      eyeScale = this.blinkT < blinkLen ? 0.15 : 1;
      if (this.blinkT > blinkLen) this.blinkT = -1;
    }
    rig.eye.scale.set(1, eyeScale, 1);

    // ---- pelvis height
    const hipBase = lerp(lerp(HIP_HEIGHT, WALK_HIP, moving), CROUCH_HIP, crouch) - tiredIdle * 0.1 - tiredWalk * 0.02;
    const cyc = Math.cos(2 * TAU * (phase - midL));
    const bobAmp =
      lerp(0.024, 0.055, run) * moving * (1 - crouch * 0.5) * (1 + strain * 0.45 + tiredWalk * 0.35);
    const bob = cyc * bobAmp * (1 - 2 * run);
    const idleBob = (1 - moving) * breath * 0.006 * breathAmp;
    let pelvisY = this.pos.y + hipBase + bob + idleBob - run * 0.03;
    // keep planted feet within reach
    for (const f of this.feet) {
      if (f.swing) continue;
      const hx = this.pos.x - f.pos.x;
      const hz = this.pos.z - f.pos.z;
      const horiz = Math.max(0, Math.hypot(hx, hz) - 0.05);
      const reach = LEG_REACH + LEG.hoof;
      const maxY = f.pos.y + Math.sqrt(Math.max(0.01, reach * reach - horiz * horiz)) - 0.02;
      if (pelvisY > maxY) pelvisY = lerp(pelvisY, maxY, 0.8);
    }
    const py = this.pelvisDyn.update(dt, pelvisY);

    // ---- body orientation
    const slopeAhead =
      speed > 0.2
        ? (world.height(this.pos.x + (this.vel.x / speed) * 0.5, this.pos.z + (this.vel.z / speed) * 0.5) - this.pos.y) / 0.5
        : 0;
    const leanTarget =
      speed * 0.035 +
      run * 0.13 +
      clamp(this.accelFwd, -7, 7) * 0.02 +
      crouch * 0.5 +
      clamp(slopeAhead, -0.5, 0.6) * 0.25 +
      strain * 0.12 +
      tiredWalk * 0.16 +
      bendOver;
    const lean = this.leanDyn.update(dt, leanTarget);
    const bank = this.bankDyn.update(dt, clamp(-this.yawRate * speed * 0.045, -0.35, 0.35));

    const waddle = 1 + tiredWalk * 0.9;
    const sway = Math.cos(TAU * (phase - midL)) * 0.032 * moving * (1 - run * 0.7) * waddle;
    const idleSway = (1 - moving) * noise1(t * 0.23, 3) * 0.018;
    const twist = -Math.cos(TAU * (phase - S / 2)) * lerp(0.16, 0.24, run) * moving;
    const roll = Math.cos(TAU * (phase - midL)) * 0.06 * moving * (1 - run * 0.5) * waddle + idleSway * 1.2;
    // bent over, the whole torso heaves with each breath
    const heave = tiredIdle * breath * 0.045 * breathAmp;

    const delta = this.snap(this.pos, _v);
    rig.body.position.set(this.pos.x + delta.x, 0, this.pos.z + delta.z);
    rig.body.rotation.set(0, this.yaw, 0);

    // pelvis sits back to balance the forward bend of a crouch
    rig.pelvis.position.set(sway + idleSway, py, -crouch * 0.07 - tiredIdle * 0.09);
    rig.pelvis.rotation.set(lean * 0.55 - heave, twist, roll + bank, 'YXZ');
    rig.spine.rotation.set(lean * 0.25 + breath * 0.012 * breathAmp, -twist * 0.6, -roll * 0.5, 'YXZ');

    // ---- look
    let lookYaw = 0;
    let lookPitch = 0.12;
    let lookRoll = 0;
    if (input.look) {
      const lx = input.look.x - this.pos.x;
      const lz = input.look.z - this.pos.z;
      const dist = Math.hypot(lx, lz);
      if (dist > 0.35) {
        const rel = wrapAngle(Math.atan2(lx, lz) - this.yaw);
        const gl = saturate(this.glanceDyn.update(dt, this.glance));
        const limit = lerp(lerp(1.35, 0.85, moving), 2.1, gl);
        const behind = lerp(1 - smoothstep(1.6, 2.3, Math.abs(rel)), 1, gl);
        lookYaw = clamp(rel, -limit, limit) * (moving > 0.5 ? behind : 1);
        const eyeY = this.pos.y + 1.3;
        lookPitch = clamp(Math.atan2(eyeY - input.look.y, dist), -0.25, 0.5);
        lookRoll = -lookYaw * lerp(0.12, 0.45, moving);
      }
    }
    lookYaw += noise1(t * 0.31, 7) * 0.05 * (1 - moving);
    // panic: the head darts this way and that, never settling
    lookYaw += (noise1(t * 2.3, 31) * 0.35 + noise1(t * 7.1, 37) * 0.12) * this.panic;
    lookPitch += noise1(t * 3.1, 41) * 0.12 * this.panic;
    lookPitch += noise1(t * 0.27, 11) * 0.03 * (1 - moving);
    lookYaw *= 1 - tired * 0.35;
    lookPitch += strain * 0.15 + tiredWalk * 0.32 + tiredIdle * 0.35 - sigh * 0.45;
    // holding something out: eyes down on it, whatever else is going on
    const hold = saturate(this.holdDyn.update(dt, this.holdOut));
    lookPitch = lerp(lookPitch, 0.78, hold);
    lookYaw = lerp(lookYaw, 0, hold);
    lookRoll = lerp(lookRoll, 0, hold);
    const ly = this.lookYawDyn.update(dt, lookYaw);
    // carrying: the right arm held out a little, pointing where the head turns
    // (it can swing out to its right further than across its body)
    const aim = saturate(this.aimDyn.update(dt, this.carrying && !this.aimHold ? 1 - 0.6 * run : 0)) * (1 - hold);
    const aimRel = clamp(ly * 0.85, -1.35, 0.55);
    this.pointYaw = this.yaw + aimRel * aim;
    const lp = this.lookPitchDyn.update(dt, lookPitch);
    const lr = this.lookRollDyn.update(dt, clamp(lookRoll, -0.4, 0.4));

    const chestLean = lean * 0.2 - crouch * 0.05;
    // a shiver of fear runs through it
    const shiver = this.panic * (noise1(t * 23, 51) * 0.03 + noise1(t * 41, 53) * 0.015);
    rig.chest.rotation.set(chestLean - breath * 0.015 * breathAmp + shiver, -twist * 0.9 + ly * (0.2 + 0.25 * this.glance), -roll * 0.4 - bank * 0.3 + shiver, 'YXZ');
    const bs = breath * 0.022 * breathAmp;
    rig.chestMesh.scale.set(1 + bs * 0.6, 1 + bs * 0.4, 1 + bs);
    rig.neck.rotation.set(-lean * 0.35 + lp * 0.25, ly * 0.3 + twist * 0.3, lr * 0.3, 'YXZ');
    // head stays level against bob and lean
    const headBob = -cyc * bobAmp * 0.8;
    // a straining head stops holding level and lolls with each stride
    const loll = strain * Math.sin(TAU * phase * 2);
    rig.head.rotation.set(
      lp * 0.6 - lean * 0.45 - chestLean + headBob * (1 - strain) + strain * cyc * 0.09 + heave * 0.5,
      ly * 0.5 + twist * 0.2,
      lr * 0.7 - roll * 0.5 - bank * 0.5 + loll * 0.13,
      'YXZ',
    );

    // ---- arms
    for (let i = 0; i < 2; i++) {
      const arm = rig.arms[i];
      const side = i === 0 ? 1 : -1;
      const legPhase = i === 0 ? 0 : 0.5;
      // straining arms stop pumping and flail lower; tired arms hang limp
      const holding = this.carrying && i === 1;
      const swingAmp = lerp(0.3, 0.95, run) * moving * (1 - strain * 0.35 - tiredWalk * 0.65) * (holding ? 0.55 : 1);
      const swing = Math.cos(TAU * (phase - legPhase - S)) * swingAmp;
      let target =
        swing -
        crouch * 0.35 +
        clamp(this.accelFwd, -6, 6) * 0.02 +
        lean * 0.4 +
        (1 - moving) * breath * 0.02 +
        tiredWalk * 0.1;
      // bent over: arms reach down and back to brace the hands on the knees
      target = lerp(target, -lean + 0.45 * saturate(lean / 0.6), tiredIdle);
      const a = this.armDyn[i].update(dt, target);
      let elbowTarget =
        -(0.18 * (1 - tired * 0.6) + run * 1.05 * (1 - strain * 0.4) + crouch * 0.5) -
        Math.max(0, -swing) * 0.5 * (0.4 + run) +
        noise1(t * 0.4, 20 + i) * 0.04;
      elbowTarget = lerp(elbowTarget, -0.22, tiredIdle) - (holding ? 0.4 : 0);
      const el = this.elbowDyn[i].update(dt, elbowTarget);
      const out = this.armOutDyn[i].update(
        dt,
        0.08 + run * 0.12 + crouch * 0.1 + Math.abs(bank) * 0.5 + strain * 0.14 + tiredIdle * 0.12,
      );
      let ra = a;
      let ry = 0;
      let rb = side * out + side * breath * 0.01;
      let re = el;
      if (holding && aim > 0.001) {
        // out ahead and a little down, toward where it looks, elbow a touch bent
        const down = 0.6;
        _v.set(Math.sin(aimRel) * Math.cos(down), -Math.sin(down), Math.cos(aimRel) * Math.cos(down))
          .multiplyScalar(0.39)
          .add(arm.shoulder.position);
        solveArm(arm.shoulder.position, _v, side, _arm);
        ra = lerp(ra, _arm.a, aim);
        ry = _arm.y * aim;
        rb = lerp(rb, _arm.b, aim);
        re = lerp(re, _arm.e, aim);
      }
      arm.shoulder.rotation.set(ra, ry, rb, 'YXZ');
      // shoulders slump when tired and rise with each panting breath
      arm.shoulder.position.y = 0.235 + breath * 0.006 * breathAmp - tired * 0.015 + tiredIdle * breath * 0.01;
      arm.elbow.rotation.set(re, 0, -side * 0.05, 'YXZ');
      if (hold > 0.001) {
        // both hands brought together in front of the chest, cradling what they hold
        _v.set(side * 0.11, 0.13, 0.3);
        solveArm(arm.shoulder.position, _v, side, _arm);
        arm.shoulder.rotation.set(lerp(ra, _arm.a, hold), lerp(ry, _arm.y, hold), lerp(rb, _arm.b, hold), 'YXZ');
        arm.elbow.rotation.set(lerp(re, _arm.e, hold), 0, -side * 0.05 * (1 - hold), 'YXZ');
      }
    }

    // ---- legs (IK, in world space)
    for (const f of this.feet) {
      // cannon tilt and hoof pitch through the swing
      const swingT = f.swing ? f.t : 0;
      const curl = f.swing ? Math.sin(Math.PI * Math.min(1, swingT * 1.15)) : 0;
      const tiltTarget = 0.2 + crouch * 0.35 + curl * (f.idle ? 0.25 : lerp(0.55, 1.1, run));
      f.tilt = damp(f.tilt, tiltTarget, 30, dt);
      f.pitch = damp(f.pitch, f.swing ? -curl * lerp(0.5, 0.9, run) : 0, 30, dt);
      f.poleDown = 0;
    }
    this.solveLegs();
  }

  /** Place both legs between the hips and the hooves (two-bone IK plus the cannon). */
  private solveLegs() {
    const rig = this.rig;
    rig.root.updateMatrixWorld(true);
    this.forward(this.yaw, _fwd);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const leg = rig.legs[i];
      _hip.set(LEG.hipWidth * f.side, -0.04, 0);
      // into the rig's own frame, where the hooves are: the same as the world for the
      // player, but not for a rig carried in something else (the specimen's tank)
      rig.root.worldToLocal(rig.pelvis.localToWorld(_hip));

      const fy = f.yaw;
      const ffx = Math.sin(fy);
      const ffz = Math.cos(fy);
      _fet.copy(f.pos);
      _fet.y += LEG.hoof;
      _dir.set(-ffx * Math.sin(f.tilt), Math.cos(f.tilt), -ffz * Math.sin(f.tilt));
      _hock.copy(_fet).addScaledVector(_dir, LEG.cannon);

      // knee points forward and slightly out (or down into the sand when kneeling or lying)
      _pole.set(ffx + _fwd.x, 0, ffz + _fwd.z).normalize();
      _pole.x += Math.cos(this.yaw) * f.side * 0.25;
      _pole.z -= Math.sin(this.yaw) * f.side * 0.25;
      _pole.y = 0.1;
      // (a negative poleDown points the knee up, for lying on the back)
      if (f.poleDown !== 0) _pole.lerp(_down, f.poleDown);

      const reached = solveTwoBone(_hip, _hock, LEG.thigh, LEG.shin, _pole, _knee);
      if (!reached) {
        // leg fully extended, the hoof hangs from the hock
        _fet.copy(_hock).addScaledVector(_dir, -LEG.cannon);
      }
      orient(leg.thigh.obj, _hip, _knee, _fwd);
      orient(leg.shin.obj, _knee, _hock, _fwd);
      _v2.set(ffx, 0, ffz);
      orient(leg.cannon.obj, _hock, _fet, _v2);

      leg.hoof.position.copy(_fet);
      leg.hoof.position.y -= LEG.hoof;
      _e.set(f.pitch, fy, 0, 'YXZ');
      leg.hoof.quaternion.setFromEuler(_e);
    }
  }

  // ------------------------------------------------------------- scripting

  private bodyToWorld(x: number, z: number, out: Vector3) {
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    return out.set(this.pos.x + x * c + z * sn, 0, this.pos.z - x * sn + z * c);
  }

  /** Pose the whole body from a script instead of the controls (cutscenes). */
  updateScripted(dt: number, P: ScriptPose, world: World) {
    this.time += dt;
    this.pointYaw = this.yaw;
    this.aimDyn.reset(0);
    this.events.length = 0;
    this.cues.length = 0;
    this.vel.set(0, 0, 0);
    this.gaitActive = false;
    const rig = this.rig;
    const t = this.time;
    this.pos.y = this.groundDyn.update(dt, world.height(this.pos.x, this.pos.z));

    this.exertion = Math.max(P.exertion, this.exertion - dt * 0.05);
    this.breathRate = lerp(0.2, 1.25, this.exertion);
    this.breathPhase = (this.breathPhase + dt * this.breathRate) % 1;
    const breath = this.scriptBreath ? this.scriptBreath.value : Math.sin(this.breathPhase * TAU);
    this.breath = breath;
    const amp = this.scriptBreath ? this.scriptBreath.amp : lerp(0.3, 1.8, this.exertion);

    // exhausted muscles shake: two octaves of noise per joint
    const tr = P.tremble;
    const shake = (k: number) => (noise1(t * 11 + k * 7.3, k) * 0.65 + noise1(t * 23 + k * 3.1, k + 40) * 0.35) * tr;

    const delta = this.snap(this.pos, _v);
    rig.body.position.set(this.pos.x + delta.x, 0, this.pos.z + delta.z);
    rig.body.rotation.set(0, this.yaw, 0);
    rig.pelvis.position.set(P.pelvisX + shake(1) * 0.006, this.pos.y + P.pelvisY + shake(2) * 0.012, P.pelvisZ);
    // XYZ: the yaw turns the body about its own spine, so a lying body rolls onto its side
    rig.pelvis.rotation.set(P.pelvisPitch + shake(3) * 0.025, P.pelvisYaw, P.pelvisRoll + shake(4) * 0.03, 'XYZ');
    rig.spine.rotation.set(P.spinePitch + breath * 0.018 * amp, 0, 0, 'YXZ');
    rig.chest.rotation.set(P.chestPitch - breath * 0.012 * amp + shake(5) * 0.03, 0, P.chestRoll + shake(6) * 0.035, 'YXZ');
    const bs = breath * 0.022 * amp;
    rig.chestMesh.scale.set(1 + bs * 0.6, 1 + bs * 0.4, 1 + bs);
    rig.neck.rotation.set(P.neckPitch, P.headYaw * 0.4, 0, 'YXZ');
    rig.head.rotation.set(P.headPitch + shake(7) * 0.05, P.headYaw * 0.6, P.headRoll + shake(8) * 0.04, 'YXZ');
    rig.eye.scale.set(1, Math.max(0.15, P.eyeOpen), 1);
    rig.eye.visible = P.eyeOpen > 0.1;
    for (const arm of rig.arms) arm.shoulder.position.y = 0.235 + breath * 0.008 * amp;
    rig.root.updateMatrixWorld(true);

    // arms: reach planted hands with IK, or hang by the FK angles
    for (let i = 0; i < 2; i++) {
      const arm = rig.arms[i];
      const side = i === 0 ? 1 : -1;
      const h = i === 0 ? P.handL : P.handR;
      let a = P.armPitch;
      let b = side * P.armOut;
      let e = P.elbow;
      let tw = 0;
      if (h.ik > 0) {
        this.bodyToWorld(h.x, h.z, _v);
        _v.y = world.height(_v.x, _v.z) + h.y;
        rig.chest.worldToLocal(_v);
        solveArm(arm.shoulder.position, _v, side, _arm);
        a = lerp(a, _arm.a, h.ik);
        tw = _arm.y * h.ik;
        b = lerp(b, _arm.b, h.ik);
        e = lerp(e, _arm.e, h.ik);
      }
      arm.shoulder.rotation.set(a, tw, b, 'YXZ');
      arm.elbow.rotation.set(e + shake(9 + i) * 0.06, 0, -side * 0.05, 'YXZ');
    }

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const fp = i === 0 ? P.footL : P.footR;
      this.bodyToWorld(fp.x, fp.z, f.pos);
      f.pos.y = world.height(f.pos.x, f.pos.z) + fp.lift;
      f.yaw = this.yaw;
      f.tilt = fp.tilt;
      f.pitch = fp.pitch;
      f.poleDown = fp.poleDown;
      f.swing = false;
    }
    this.solveLegs();
  }

  /** Hand control back after a script, carrying on smoothly from the scripted pose. */
  releaseScript(groggySeconds = 0) {
    const rig = this.rig;
    rig.eye.visible = true;
    this.pelvisDyn.reset(rig.pelvis.position.y);
    this.leanDyn.reset(rig.pelvis.rotation.x / 0.55);
    for (let i = 0; i < 2; i++) {
      this.armDyn[i].reset(rig.arms[i].shoulder.rotation.x);
      this.elbowDyn[i].reset(rig.arms[i].elbow.rotation.x);
      this.armOutDyn[i].reset(Math.abs(rig.arms[i].shoulder.rotation.z));
    }
    for (const f of this.feet) {
      f.swing = false;
      f.poleDown = 0;
      f.pos.y = Math.min(f.pos.y, this.pos.y + 0.02);
    }
    this.gaitActive = false;
    this.idleTime = 0;
    this.groggy = groggySeconds;
    this.tired = Math.max(this.tired, groggySeconds > 0 ? 0.6 : 0);
  }

  /** World position of the head, for the camera and sounds. */
  headPosition(out: Vector3) {
    return this.rig.head.getWorldPosition(out);
  }
}

const ARM_UPPER = 0.22;
const ARM_FORE = 0.225;
const _arm = { a: 0, y: 0, b: 0, e: 0 };
const _elbow = new Vector3();
const _armPole = new Vector3();
const _tgt = new Vector3();
const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _am = new Matrix4();
const _ae = new Euler();

/**
 * Arm IK in the chest's space. The elbow points back toward the hips and a
 * little out (as in a push-up). Writes the shoulder Euler angles (YXZ) and the
 * elbow bend (negative folds the forearm forward).
 */
export function solveArm(
  shoulder: Vector3,
  target: Vector3,
  side: number,
  out: { a: number; y: number; b: number; e: number },
) {
  _tgt.copy(target);
  _armPole.set(side * 0.6, -0.7, -0.4).normalize();
  solveTwoBone(shoulder, _tgt, ARM_UPPER, ARM_FORE, _armPole, _elbow);
  // shoulder frame: -Y along the upper arm, +Z toward where the forearm folds
  _ay.subVectors(shoulder, _elbow).normalize();
  _az.subVectors(_tgt, _elbow).normalize();
  const cosBend = clamp(-_ay.dot(_az), -1, 1);
  _az.addScaledVector(_ay, -_ay.dot(_az));
  if (_az.lengthSq() < 1e-8) _az.copy(_armPole).multiplyScalar(-1).addScaledVector(_ay, -_ay.dot(_armPole) * -1);
  if (_az.lengthSq() < 1e-8) _az.set(0, 0, 1).addScaledVector(_ay, -_ay.z);
  _az.normalize();
  _ax.crossVectors(_ay, _az);
  _am.makeBasis(_ax, _ay, _az);
  _ae.setFromRotationMatrix(_am, 'YXZ');
  out.a = _ae.x;
  out.y = _ae.y;
  out.b = _ae.z;
  out.e = -Math.acos(cosBend);
}

/**
 * Two-bone IK. Moves `end` toward the reachable sphere and writes the joint
 * position to `joint`. Returns false if the target was out of reach.
 */
function solveTwoBone(root: Vector3, end: Vector3, l1: number, l2: number, pole: Vector3, joint: Vector3) {
  _v.subVectors(end, root);
  let d = _v.length();
  const maxD = l1 + l2 - 1e-4;
  const minD = Math.abs(l1 - l2) + 1e-3;
  let reached = true;
  if (d > maxD) {
    d = maxD;
    reached = false;
  }
  if (d < minD) d = minD;
  _v.normalize();
  if (!reached) end.copy(root).addScaledVector(_v, d);
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _v2.copy(pole).addScaledVector(_v, -_v.dot(pole));
  if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, 1);
  _v2.normalize();
  joint.copy(root).addScaledVector(_v, cosA * l1).addScaledVector(_v2, sinA * l1);
  return reached;
}
