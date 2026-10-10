import { Vector3 } from 'three';
import { clamp, lerp, smoothstep } from '../core/math';
import type { Creature, World } from '../character/Creature';
import { blendPose, clonePose, type HandPose, type ScriptPose } from '../character/scriptPose';
import type { AudioEngine } from '../audio/AudioEngine';
import type { CrashSite } from '../world/crashSite';
import { ease, foot, hand, LOOK, mk, type Ease } from './WakeUp';

// --------------------------------------------------------------------- poses
// Body space: x = the creature's left, y = up, z = forward. Both hands brace
// on the hatchway's rim (placed each frame); the poses only say how firmly.

const CALM = mk(LOOK, { tremble: 0.05, exertion: 0.15 });

/** A step up to it, leaning in, the hands coming up to the rim. */
const STEP = mk(CALM, {
  pelvisPitch: 0.25,
  spinePitch: 0.08,
  neckPitch: 0.15,
  headPitch: 0.25,
  handL: hand(0.2, 0.7, 0.35, 0.5),
  handR: hand(-0.2, 0.7, 0.35, 0.5),
  footL: foot(0.12, 0.14, 0, 0.25, 0, 0),
  footR: foot(-0.1, -0.04, 0, 0.25, 0, 0),
});

/** Braced on the rim, leaning right over, head down in the hatchway. */
const LEAN = mk(STEP, {
  pelvisY: 0.6,
  pelvisZ: -0.04,
  pelvisPitch: 0.5,
  spinePitch: 0.25,
  chestPitch: 0.18,
  neckPitch: 0.3,
  headPitch: 0.45,
  handL: hand(0.2, 0.7, 0.35, 1),
  handR: hand(-0.2, 0.7, 0.35, 1),
  footL: foot(0.12, 0.2, 0, 0.3, 0, 0),
  footR: foot(-0.11, -0.12, 0, 0.35, 0.1, 0),
});
/** Looking round inside: one way, the other, then down into the bottom of it. */
const LOOK_A = mk(LEAN, { headYaw: 0.6, headRoll: -0.12, neckPitch: 0.26, chestRoll: 0.04 });
const LOOK_B = mk(LEAN, { headYaw: -0.62, headRoll: 0.12, neckPitch: 0.26, chestRoll: -0.04 });
const LOOK_C = mk(LEAN, { headYaw: 0.08, headPitch: 0.62, neckPitch: 0.38, pelvisPitch: 0.54 });

/** Pulled back out, upright, hands down. */
const BACK = mk(CALM, {
  pelvisPitch: 0.14,
  neckPitch: 0.1,
  headPitch: 0.12,
  footL: foot(0.1, 0.06, 0, 0.2, 0, 0),
  footR: foot(-0.1, -0.08, 0, 0.2, 0, 0),
});
/** A slow tilt of the head at what it saw (or didn't). */
const TILT = mk(BACK, { headRoll: 0.4, headYaw: 0.18, neckPitch: 0.04, headPitch: 0.06 });

type Key = { t: number; pose: ScriptPose; ease: Ease };
const KEYS: Key[] = [
  { t: 0, pose: CALM, ease: 'linear' },
  { t: 0.55, pose: STEP, ease: 'inOut' },
  { t: 1.15, pose: LEAN, ease: 'inOut' },
  { t: 1.9, pose: LOOK_A, ease: 'inOut' },
  { t: 2.15, pose: LOOK_A, ease: 'linear' },
  { t: 2.85, pose: LOOK_B, ease: 'inOut' },
  { t: 3.05, pose: LOOK_B, ease: 'linear' },
  { t: 3.55, pose: LOOK_C, ease: 'inOut' },
  { t: 3.95, pose: LOOK_C, ease: 'linear' },
  { t: 4.6, pose: BACK, ease: 'inOut' },
  { t: 5.25, pose: TILT, ease: 'out' },
  { t: 6.1, pose: TILT, ease: 'linear' },
  { t: 6.7, pose: CALM, ease: 'inOut' },
];
const END = 6.7;
/** How far from the hatchway's middle (on the ground) it stands to lean in, and the step back out. */
const PEEK_REACH = 0.86;
const STEP_OUT = 0.45;

const _v = new Vector3();
const _w = new Vector3();

/**
 * Looking into an escape pod: the creature steps up beside the open hatchway,
 * braces both hands on its rim and leans right in. It looks round inside, one
 * way and the other, then down into it, pulls back out, and tilts its head.
 */
export class PeekScene {
  active = false;
  t = 0;
  /** 0..1 how far the scene has drawn the camera in. */
  weight = 0;
  private site: CrashSite | null = null;
  private readonly hatch = { center: new Vector3(), normal: new Vector3(), axis: new Vector3(), across: new Vector3() };
  private readonly pose = clonePose(CALM);
  private readonly start = new Vector3();
  private readonly stand = new Vector3();
  private readonly out = new Vector3();
  private startYaw = 0;
  private yaw = 0;
  private braced = false;
  private sighed = false;

  constructor(
    private readonly creature: Creature,
    private readonly world: World,
    private readonly audio: AudioEngine,
  ) {}

  /**
   * Where to stand to lean in (beside the hatchway, so the camera sees it side
   * on), and the way to face; `out` gets the step back out to where it can
   * walk to (the pod's outline keeps it from walking right up).
   */
  private standPoint(site: CrashSite, from: Vector3, out: Vector3) {
    const h = site.hatchway(this.hatch);
    const nx = h.normal.x;
    const nz = h.normal.z;
    const nl = Math.hypot(nx, nz) || 1;
    const ax = h.axis.x;
    const az = h.axis.z;
    const al = Math.hypot(ax, az) || 1;
    // come at it from the end of the pod nearer the creature
    const side = (from.x - h.center.x) * ax + (from.z - h.center.z) * az >= 0 ? 1 : -1;
    _v.set((-nx / nl) * 0.55 - (side * ax * 0.83) / al, 0, (-nz / nl) * 0.55 - (side * az * 0.83) / al).normalize();
    out.set(h.center.x - _v.x * PEEK_REACH, 0, h.center.z - _v.z * PEEK_REACH);
    out.y = this.world.height(out.x, out.z);
    this.out.set((nx / nl) * STEP_OUT, 0, (nz / nl) * STEP_OUT);
    return Math.atan2(_v.x, _v.z);
  }

  /** Where to walk to before the scene starts: a step out from where it leans in. */
  approachPoint(site: CrashSite, from: Vector3, out: Vector3) {
    this.standPoint(site, from, out);
    return out.add(this.out);
  }

  begin(site: CrashSite) {
    if (this.active) return;
    const c = this.creature;
    this.site = site;
    this.active = true;
    this.t = 0;
    this.braced = false;
    this.sighed = false;
    this.yaw = this.standPoint(site, c.pos, this.stand);
    this.startYaw = c.yaw;
    this.start.copy(c.pos);
  }

  /** Camera focus: between the creature and the hatchway, a little low. */
  focus(out: Vector3) {
    const c = this.creature;
    const h = this.hatch.center;
    return out.set(lerp(c.pos.x, h.x, 0.45), lerp(c.pos.y + 0.6, h.y, 0.4), lerp(c.pos.z, h.z, 0.45));
  }

  update(dt: number) {
    if (!this.active || !this.site) {
      this.weight = Math.max(0, this.weight - dt * 1.2);
      return;
    }
    this.t += dt;
    const t = this.t;
    const c = this.creature;
    this.weight = smoothstep(0, 0.8, t) * (1 - smoothstep(END - 0.9, END + 0.3, t));

    // up to the hatchway as it leans in, and back out a step as it pulls away
    const inn = smoothstep(0.1, 1.0, t) * (1 - smoothstep(4.0, 4.9, t));
    const toStand = smoothstep(0, 1.0, t);
    c.pos.x = lerp(this.start.x, this.stand.x, toStand) + this.out.x * (1 - inn) * toStand;
    c.pos.z = lerp(this.start.z, this.stand.z, toStand) + this.out.z * (1 - inn) * toStand;
    let dy = this.yaw - this.startYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    c.setYaw(this.startYaw + dy * smoothstep(0, 0.7, t));

    // sample the pose
    let i = 1;
    while (i < KEYS.length && KEYS[i].t < t) i++;
    const P = this.pose;
    if (i >= KEYS.length) blendPose(P, CALM, CALM, 0);
    else {
      const a = KEYS[i - 1];
      const b = KEYS[i];
      blendPose(P, a.pose, b.pose, ease(b.ease, clamp((t - a.t) / (b.t - a.t), 0, 1)));
    }

    // the hands go to the rim either side of the opening
    const h = this.site.hatchway(this.hatch);
    this.rim(h.center, h.across, h.normal, 0.3, P.handL, P.handR);

    if (!this.braced && t > 1.05) {
      this.braced = true;
      this.audio.click(0.12);
      this.audio.thud(0.05);
    }
    if (!this.sighed && t > 4.95) {
      this.sighed = true;
      this.audio.wakeGasp(0.06, false);
    }

    c.updateScripted(dt, P, this.world);
    if (t >= END) this.finish();
  }

  /** Put the hands on the rim, `w` either side of the middle across the opening (left hand on the left). */
  private rim(center: Vector3, across: Vector3, normal: Vector3, w: number, L: HandPose, R: HandPose) {
    const c = this.creature;
    const cy = Math.cos(c.yaw);
    const sy = Math.sin(c.yaw);
    const pts = [1, -1].map((sgn) => {
      _w.copy(center).addScaledVector(across, sgn * w).addScaledVector(normal, 0.04);
      const dx = _w.x - c.pos.x;
      const dz = _w.z - c.pos.z;
      return { x: dx * cy - dz * sy, y: _w.y - this.world.height(_w.x, _w.z), z: dx * sy + dz * cy };
    });
    pts.sort((a, b) => b.x - a.x);
    for (const [hnd, p] of [
      [L, pts[0]],
      [R, pts[1]],
    ] as const) {
      hnd.x = p.x;
      hnd.y = p.y;
      hnd.z = p.z;
    }
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
    this.active = false;
    this.site = null;
  }
}
