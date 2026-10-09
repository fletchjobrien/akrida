import { Euler, Vector2, Vector3 } from 'three';
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
import { CreatureRig, LEG, orient } from './rig';
import type { RockInfo } from '../world/rocks';

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

export interface World {
  height(x: number, z: number): number;
  rocks: RockInfo[];
}

const WALK_SPEED = 1.85;
const SPRINT_SPEED = 6.3;
const CROUCH_SPEED = 1.05;
const HIP_HEIGHT = 0.7;
const WALK_HIP = 0.645;
const CROUCH_HIP = 0.47;
const BODY_RADIUS = 0.22;
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
const _fwd = new Vector3();
const _e = new Euler();

export class Creature {
  readonly rig = new CreatureRig();
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
  private blinkTimer = 2.5;
  private blinkT = -1;

  /** Snap the drawn body to the texel grid (provided by the renderer). */
  snap: (p: Vector3, out: Vector3) => Vector3 = (_p, out) => out.set(0, 0, 0);
  readonly events: StepEvent[] = [];
  /** 0..1 breath cycle value, exposed for sound. */
  breath = 0;
  breathRate = 0.3;

  constructor(world: World, x = 0, z = 0) {
    this.pos.set(x, world.height(x, z), z);
    this.groundDyn.reset(this.pos.y);
    this.pelvisDyn.reset(this.pos.y + HIP_HEIGHT);
    this.crouchDyn.reset(0);
    for (const f of this.feet) {
      this.restPosition(f, this.yaw, f.pos);
      f.pos.y = world.height(f.pos.x, f.pos.z);
      f.yaw = this.yaw;
    }
  }

  /** Move instantly (used for story beats and debugging). */
  teleport(x: number, z: number, world: World) {
    this.pos.set(x, world.height(x, z), z);
    this.vel.set(0, 0, 0);
    this.groundDyn.reset(this.pos.y);
    this.pelvisDyn.reset(this.pos.y + HIP_HEIGHT);
    this.gaitActive = false;
    for (const f of this.feet) {
      f.swing = false;
      this.restPosition(f, this.yaw, f.pos);
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
    this.locomotion(dt, input, world);
    this.gait(dt, world);
    this.pose(dt, input, world);
  }

  // ---------------------------------------------------------------- movement

  private locomotion(dt: number, input: CreatureInput, world: World) {
    const moveLen = Math.min(1, input.move.length());
    const crouching = input.crouch;
    this.crouch = saturate(this.crouchDyn.update(dt, crouching ? 1 : 0));
    const sprinting = input.sprint && !crouching && moveLen > 0.1;
    const maxSpeed = crouching ? CROUCH_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED;

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

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // rocks push us out
    for (const r of world.rocks) {
      const ox = this.pos.x - r.x;
      const oz = this.pos.z - r.z;
      const min = r.radius + BODY_RADIUS;
      const d2 = ox * ox + oz * oz;
      if (d2 < min * min && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const nx = ox / d;
        const nz = oz / d;
        this.pos.x = r.x + nx * min;
        this.pos.z = r.z + nz * min;
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn < 0) {
          this.vel.x -= vn * nx;
          this.vel.z -= vn * nz;
        }
      }
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
    const turnF = lerp(1.9, 2.6, this.run) * (1 - this.crouch * 0.25);
    this.yawDyn.setParams(turnF, 0.85, 0);
    const prevYaw = this.yaw;
    this.yaw = this.yawDyn.update(dt, unwrapNear(this.yaw, this.yawTarget));
    this.yawRate = damp(this.yawRate, (this.yaw - prevYaw) / Math.max(dt, 1e-4), 12, dt);
  }

  // -------------------------------------------------------------------- gait

  private gait(dt: number, world: World) {
    const speed = this.speed;
    this.run = smoothstep(2.7, 4.8, speed);
    const crouch = this.crouch;
    const walkCad = 1.1 + 0.42 * speed;
    const runCad = 1.5 + 0.17 * speed;
    this.cadence = lerp(walkCad, runCad, this.run) * (1 - crouch * 0.12);
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
      f.height = lerp(0.07, 0.15, this.run) * (1 - crouch * 0.35) * lerp(0.5, 1, saturate(this.speed / 1.2));
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
    this.pelvisDyn.yd -= (0.12 + speed * 0.07) * (1 - this.crouch * 0.5);
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
    this.breathRate = lerp(0.27, 1.25, this.exertion) + run * 0.3;
    this.breathPhase = (this.breathPhase + dt * this.breathRate) % 1;
    const breath = Math.sin(this.breathPhase * TAU);
    this.breath = breath;
    const breathAmp = lerp(0.6, 1.6, this.exertion);

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkT = 0;
      this.blinkTimer = 1.8 + Math.random() * 4.5;
      if (Math.random() < 0.18) this.blinkTimer = 0.28;
    }
    let eyeScale = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      eyeScale = this.blinkT < 0.11 ? 0.15 : 1;
      if (this.blinkT > 0.11) this.blinkT = -1;
    }
    rig.eye.scale.set(1, eyeScale, 1);

    // ---- pelvis height
    const hipBase = lerp(lerp(HIP_HEIGHT, WALK_HIP, moving), CROUCH_HIP, crouch);
    const cyc = Math.cos(2 * TAU * (phase - midL));
    const bobAmp = lerp(0.024, 0.055, run) * moving * (1 - crouch * 0.5);
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
      speed * 0.035 + run * 0.13 + clamp(this.accelFwd, -7, 7) * 0.02 + crouch * 0.27 + clamp(slopeAhead, -0.5, 0.6) * 0.25;
    const lean = this.leanDyn.update(dt, leanTarget);
    const bank = this.bankDyn.update(dt, clamp(-this.yawRate * speed * 0.045, -0.35, 0.35));

    const sway = Math.cos(TAU * (phase - midL)) * 0.032 * moving * (1 - run * 0.7);
    const idleSway = (1 - moving) * noise1(t * 0.23, 3) * 0.018;
    const twist = -Math.cos(TAU * (phase - S / 2)) * lerp(0.16, 0.24, run) * moving;
    const roll = Math.cos(TAU * (phase - midL)) * 0.06 * moving * (1 - run * 0.5) + idleSway * 1.2;

    const delta = this.snap(this.pos, _v);
    rig.body.position.set(this.pos.x + delta.x, 0, this.pos.z + delta.z);
    rig.body.rotation.set(0, this.yaw, 0);

    rig.pelvis.position.set(sway + idleSway, py, -crouch * 0.03);
    rig.pelvis.rotation.set(lean * 0.55, twist, roll + bank, 'YXZ');
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
        const limit = lerp(1.35, 0.85, moving);
        const behind = 1 - smoothstep(1.6, 2.3, Math.abs(rel));
        lookYaw = clamp(rel, -limit, limit) * (moving > 0.5 ? behind : 1);
        const eyeY = this.pos.y + 1.3;
        lookPitch = clamp(Math.atan2(eyeY - input.look.y, dist), -0.25, 0.5);
        lookRoll = -lookYaw * lerp(0.12, 0.45, moving);
      }
    }
    lookYaw += noise1(t * 0.31, 7) * 0.05 * (1 - moving);
    lookPitch += noise1(t * 0.27, 11) * 0.03 * (1 - moving);
    const ly = this.lookYawDyn.update(dt, lookYaw);
    const lp = this.lookPitchDyn.update(dt, lookPitch);
    const lr = this.lookRollDyn.update(dt, clamp(lookRoll, -0.4, 0.4));

    const chestLean = lean * 0.2 - crouch * 0.05;
    rig.chest.rotation.set(chestLean - breath * 0.015 * breathAmp, -twist * 0.9 + ly * 0.2, -roll * 0.4 - bank * 0.3, 'YXZ');
    const bs = breath * 0.022 * breathAmp;
    rig.chestMesh.scale.set(1 + bs * 0.6, 1 + bs * 0.4, 1 + bs);
    rig.neck.rotation.set(-lean * 0.35 + lp * 0.25, ly * 0.3 + twist * 0.3, lr * 0.3, 'YXZ');
    // head stays level against bob and lean
    const headBob = -cyc * bobAmp * 0.8;
    rig.head.rotation.set(
      lp * 0.6 - lean * 0.45 - chestLean + headBob,
      ly * 0.5 + twist * 0.2,
      lr * 0.7 - roll * 0.5 - bank * 0.5,
      'YXZ',
    );

    // ---- arms
    for (let i = 0; i < 2; i++) {
      const arm = rig.arms[i];
      const side = i === 0 ? 1 : -1;
      const legPhase = i === 0 ? 0 : 0.5;
      const swing = Math.cos(TAU * (phase - legPhase - S)) * lerp(0.3, 0.95, run) * moving;
      const target =
        swing - crouch * 0.35 + clamp(this.accelFwd, -6, 6) * 0.02 + lean * 0.4 + (1 - moving) * breath * 0.02;
      const a = this.armDyn[i].update(dt, target);
      const elbowTarget =
        -(0.18 + run * 1.05 + crouch * 0.5) - Math.max(0, -swing) * 0.5 * (0.4 + run) + noise1(t * 0.4, 20 + i) * 0.04;
      const el = this.elbowDyn[i].update(dt, elbowTarget);
      const out = this.armOutDyn[i].update(dt, 0.08 + run * 0.12 + crouch * 0.1 + Math.abs(bank) * 0.5);
      arm.shoulder.rotation.set(a, 0, side * out + side * breath * 0.01, 'YXZ');
      arm.shoulder.position.y = 0.235 + breath * 0.006 * breathAmp;
      arm.elbow.rotation.set(el, 0, -side * 0.05, 'YXZ');
    }

    // ---- legs (IK, in world space)
    rig.root.updateMatrixWorld(true);
    this.forward(this.yaw, _fwd);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const leg = rig.legs[i];
      _hip.set(LEG.hipWidth * f.side, -0.04, 0);
      rig.pelvis.localToWorld(_hip);

      // cannon tilt and hoof pitch through the swing
      const swingT = f.swing ? f.t : 0;
      const curl = f.swing ? Math.sin(Math.PI * Math.min(1, swingT * 1.15)) : 0;
      const tiltTarget = 0.2 + crouch * 0.35 + curl * (f.idle ? 0.25 : lerp(0.55, 1.1, run));
      f.tilt = damp(f.tilt, tiltTarget, 30, dt);
      f.pitch = damp(f.pitch, f.swing ? -curl * lerp(0.5, 0.9, run) : 0, 30, dt);

      const fy = f.yaw;
      const ffx = Math.sin(fy);
      const ffz = Math.cos(fy);
      _fet.copy(f.pos);
      _fet.y += LEG.hoof;
      _dir.set(-ffx * Math.sin(f.tilt), Math.cos(f.tilt), -ffz * Math.sin(f.tilt));
      _hock.copy(_fet).addScaledVector(_dir, LEG.cannon);

      // knee points forward and slightly out
      _pole.set(ffx + _fwd.x, 0, ffz + _fwd.z).normalize();
      _pole.x += Math.cos(this.yaw) * f.side * 0.25;
      _pole.z -= Math.sin(this.yaw) * f.side * 0.25;
      _pole.y = 0.1;

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

  /** World position of the head, for the camera and sounds. */
  headPosition(out: Vector3) {
    return this.rig.head.getWorldPosition(out);
  }
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
