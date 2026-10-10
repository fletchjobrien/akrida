import { BoxGeometry, Euler, Mesh, Vector3, type ShaderMaterial } from 'three';
import { clamp, Dyn, lerp, noise1, rng, saturate, smoothstep } from '../core/math';
import { Creature, type World } from '../character/Creature';
import { LEG, orient, type Skin } from '../character/rig';
import { clonePose, type FootPose, type HandPose, type ScriptPose } from '../character/scriptPose';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { footprintOf, type Rocks } from '../world/rocks';
import { terrainHeight } from '../world/terrain';
import type { StainMap } from '../world/stains';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';
import { TUNE } from './tune';

/** Same kind as the player, in a husky grey blue. */
export const STRANGER_SKIN: Skin = {
  fur: [0x3a4b61, 0x5a7591, 0x7490ac],
  belly: [0x86a0b6, 0xa8c0d4, 0xc0d4e3],
  hoof: [0x222c3b, 0x3a4b61],
  eye: 0xd8f0ff,
};

/** The eye's glow, quantised to a few palette steps: out, dim, faint, bright. */
const EYE_STEPS = [rgb(0x1e2a36), rgb(0x6a9cc4), rgb(0xa8dcff), rgb(0xeefaff)];

const SAND = rgb(0xe4c987).toArray();

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({
  x,
  z,
  lift,
  tilt,
  pitch,
  poleDown,
});

/**
 * On its back, head toward body -z, legs toward +z. Body space: x = its left,
 * y = up, z = toward its feet.
 */
const LYING: ScriptPose = {
  pelvisX: 0,
  pelvisY: 0.1,
  pelvisZ: 0,
  pelvisPitch: -1.5,
  pelvisYaw: 0,
  pelvisRoll: 0,
  spinePitch: 0.02,
  chestPitch: 0.03,
  chestRoll: 0,
  neckPitch: 0,
  headPitch: 0,
  headYaw: 0,
  headRoll: 0,
  handL: hand(0.42, 0.0, -0.28),
  handR: hand(-0.2, 0.1, -0.3),
  armPitch: 0,
  elbow: -0.3,
  armOut: 0.3,
  footL: foot(0.3, 0.6, 0, 0.3, 0, -1),
  footR: foot(-0.17, 0.46, 0, 0.25, 0.1, -1),
  eyeOpen: 0.7,
  tremble: 0.2,
  exertion: 0,
};

/** Timeline of the encounter (seconds from the click). */
const E = {
  /** Head lifts toward the player. */
  lift: 0.3,
  /** The gargled cry. */
  cry: 0.9,
  cryEnd: 3.3,
  /** A deep, rattling breath in before the tune. */
  inhale: 3.35,
  /** The three notes. */
  notes: [3.95, 5.05, 6.15],
  noteLen: 0.95,
  /** The head sinks back. */
  sink: 7.2,
  /** Control returns. */
  end: 8.0,
};

/** How close the player must be to reach the stranger, and how close it first notices them. */
const REACH_RANGE = 2.7;
const SIGHT_RANGE = 8.5;

const _v = new Vector3();
const _w = new Vector3();
const _hip = new Vector3();
const _knee = new Vector3();
const _hock = new Vector3();
const _fet = new Vector3();
const _e = new Euler();

/**
 * The survivor of the second pod: one of the player's own kind, blue skinned,
 * lying where it finally stopped crawling. It is dying: a wound in its belly,
 * one leg broken, its chest heaving and its eye guttering. When it first sees
 * the player it reaches out. Clicking it up close plays the encounter: a
 * gargled cry, then a raspy three-note tune (TUNE).
 */
export class Stranger {
  readonly creature: Creature;
  /** Ground position of the body's centre (between pelvis and chest). */
  readonly center = new Vector3();
  /** Head direction on the ground (unit x, z). */
  readonly axis: { x: number; z: number };
  /** Set for one frame when it first sees the player. */
  justSeen = false;
  seen = false;
  distance = Infinity;
  /** 0..1: how far the encounter has taken over the camera and sound. */
  weight = 0;
  /** Seconds into the encounter, or -1. */
  private enc = -1;
  private encCount = 0;
  private notePlayed = 0;
  private cried = false;
  private inhaled = false;

  private readonly pose = clonePose(LYING);
  private readonly eyeMat: ShaderMaterial;
  private readonly glowMat: ShaderMaterial;
  private readonly breath = { value: -0.3, amp: 2.4 };
  private readonly breathDyn = new Dyn(3.2, 0.7, 0);
  private breathState: 'in' | 'hold' | 'out' | 'pause' = 'pause';
  private breathTimer = 0.8;
  private eyeDrop = 0;
  private eyeDropTimer = 2;
  private readonly lookYaw = new Dyn(0.7, 1, 0);
  private readonly lookPitch = new Dyn(0.7, 1, 0);
  private readonly roll = new Dyn(0.5, 1, 0);
  private readonly reach = new Dyn(0.9, 0.9, 0);
  private reachT = -1;
  private time = 0;
  private struggleTimer = 4;
  private struggle = 0;
  private landed = true;
  private readonly yaw: number;

  constructor(
    private readonly world: World,
    x: number,
    z: number,
    axis: { x: number; z: number },
    rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    snap: (p: Vector3, out: Vector3) => Vector3,
  ) {
    this.axis = axis;
    this.creature = new Creature(world, x, z, STRANGER_SKIN);
    // body forward (+z) points at the feet, away from where the head lies
    this.yaw = Math.atan2(-axis.x, -axis.z);
    this.creature.setYaw(this.yaw);
    this.creature.pos.set(x, terrainHeight(x, z), z);
    this.creature.snap = snap;
    this.creature.scriptBreath = this.breath;
    const rig = this.creature.rig;
    rig.dust.value = 0.1;
    this.eyeMat = rig.eye.material as ShaderMaterial;
    this.center.set(x + axis.x * 0.3, 0, z + axis.z * 0.3);

    // the wound: a dark tear across the belly, wet at its lip, a faint glow deep inside
    const woundMat = toonMaterial({ dark: 0x141821, mid: 0x1c222e, light: 0x2a3342, litAt: 0.6, outline: 0, highlight: 0 });
    const bloodMat = toonMaterial({ dark: 0x2c3846, mid: 0x3e4f62, light: 0x566a80, litAt: 0.6, outline: 0, highlight: 0 });
    this.glowMat = toonMaterial({ dark: 0x3e5a73, mid: 0x3e5a73, light: 0x3e5a73, unlit: true, outline: 0, highlight: 0 });
    const part = (w: number, h: number, d: number, x: number, y: number, z: number, mat: ShaderMaterial) => {
      const m = new Mesh(new BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.layers.enable(SHADOW_LAYER);
      m.frustumCulled = false;
      rig.spine.add(m);
      return m;
    };
    part(0.12, 0.07, 0.03, 0.02, 0.085, 0.104, woundMat);
    part(0.035, 0.03, 0.02, 0.03, 0.085, 0.112, this.glowMat);
    part(0.06, 0.03, 0.025, -0.03, 0.125, 0.108, bloodMat);
    part(0.03, 0.12, 0.03, 0.115, 0.045, 0.085, bloodMat); // run down the flank
    part(0.025, 0.06, 0.03, -0.1, 0.03, 0.09, bloodMat);

    // pose it (a few frames, so the hands find their marks) so its outline can block the player
    const away = new Vector3(x + 100, 0, z + 100);
    for (let i = 0; i < 4; i++) this.update(1 / 60, away);
    rig.root.updateMatrixWorld(true);
    rocks.addStatic(footprintOf(rig.root, 0.3));
  }

  /** Body coordinates (x = its left, z = toward its feet) to world, on the ground. */
  bodyToWorld(bx: number, bz: number, out: Vector3) {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const p = this.creature.pos;
    out.set(p.x + bx * c + bz * s, 0, p.z - bx * s + bz * c);
    out.y = terrainHeight(out.x, out.z);
    return out;
  }

  /** World to a hand target in body space (height above the ground under it). */
  private toBody(w: Vector3, out: HandPose) {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const dx = w.x - this.creature.pos.x;
    const dz = w.z - this.creature.pos.z;
    out.x = dx * c - dz * s;
    out.z = dx * s + dz * c;
    out.y = w.y - terrainHeight(w.x, w.z);
  }

  /** Where the head is, for the player to look at. */
  headPosition(out: Vector3) {
    return this.creature.rig.head.getWorldPosition(out);
  }

  /** True while the encounter holds the player still. */
  get busy() {
    return this.enc >= 0 && this.enc < E.end;
  }

  /** Whether a click at `mouse` (on the ground) from a player at `player` reaches the stranger. */
  canInteract(player: Vector3, mouse: Vector3 | null) {
    if (this.busy || !mouse) return false;
    if (Math.hypot(player.x - this.center.x, player.z - this.center.z) > REACH_RANGE) return false;
    return Math.hypot(mouse.x - this.center.x, mouse.z - this.center.z) < 0.95;
  }

  /** Start the encounter: the cry, then the tune. */
  interact() {
    if (this.busy) return;
    this.enc = 0;
    this.encCount++;
    this.notePlayed = 0;
    this.cried = false;
    this.inhaled = false;
  }

  /** Camera focus during the encounter: between the two of them, a little low. */
  focus(player: Vector3, out: Vector3) {
    this.headPosition(_v);
    return out.set((player.x + _v.x) / 2, (player.y + _v.y) / 2 + 0.25, (player.z + _v.z) / 2);
  }

  update(dt: number, player: Vector3) {
    this.time += dt;
    const t = this.time;
    this.justSeen = false;
    const d = Math.hypot(player.x - this.center.x, player.z - this.center.z);
    this.distance = d;
    if (!this.seen && d < SIGHT_RANGE) {
      this.seen = true;
      this.justSeen = true;
      this.reachT = 0;
    }

    // ---- encounter clock
    let enc = -1;
    if (this.enc >= 0) {
      this.enc += dt;
      enc = this.enc;
      if (enc > E.end + 2) this.enc = -1;
    }
    const inEnc = enc >= 0 && enc < E.end;
    const w = enc < 0 ? 0 : enc < E.end ? smoothstep(0, 1.3, enc) : 1 - smoothstep(E.end, E.end + 1.4, enc);
    this.weight = w;

    // ---- sound placement
    const level = d < 40 ? 1.4 / (1 + (d / 3.5) * (d / 3.5)) : 0;
    this.audio.setStranger(level, clamp((this.center.x - player.x) / 7, -0.8, 0.8), 1 - smoothstep(2, 20, d));

    if (d > 45 && t > 0.2) return;

    const crying = inEnc && enc > E.cry && enc < E.cryEnd;
    const singing = inEnc && enc > E.notes[0] - 0.05 && enc < E.notes[2] + E.noteLen;
    const noteAmt = this.noteEnvelope(enc);

    // ---- encounter sounds
    if (inEnc) {
      if (!this.cried && enc >= E.cry) {
        this.cried = true;
        this.audio.strangerGargle(this.encCount > 1 ? 0.7 : 0.9);
      }
      if (!this.inhaled && enc >= E.inhale) {
        this.inhaled = true;
        this.audio.strangerBreath(0.55, true);
      }
      while (this.notePlayed < 3 && enc >= E.notes[this.notePlayed]) {
        this.audio.strangerNote(TUNE[this.notePlayed], 0.9);
        this.notePlayed++;
      }
    }

    // ---- breathing: agonal, a heaving gasp then a long ragged pause
    this.updateBreath(dt, enc, inEnc, crying, singing);

    // ---- the eye gutters: dim, flickering, dropping out; it flares with each note
    this.eyeDropTimer -= dt;
    if (this.eyeDropTimer <= 0) {
      this.eyeDrop = 0.05 + Math.random() * 0.14;
      this.eyeDropTimer = crying ? 0.08 + Math.random() * 0.3 : 0.6 + Math.random() * 3.2;
    }
    this.eyeDrop -= dt;
    const inhale = Math.max(0, this.breath.value);
    let eye = 0.5 + 0.16 * inhale + 0.12 * noise1(t * 3.3, 5) + 0.08 * noise1(t * 17, 9);
    if (this.seen && d < SIGHT_RANGE * 1.4) eye += 0.08;
    if (inEnc) eye = lerp(eye, 0.7 + 0.14 * noise1(t * 9, 3), smoothstep(E.lift, E.cry, enc) * (1 - smoothstep(E.sink, E.end, enc)));
    if (crying) eye += (Math.random() - 0.5) * 0.5;
    eye = Math.max(eye, noteAmt);
    if (this.eyeDrop > 0) eye *= 0.15;
    const step = eye < 0.17 ? 0 : eye < 0.47 ? 1 : eye < 0.8 ? 2 : 3;
    const col = EYE_STEPS[step];
    for (const k of ['uDark', 'uMid', 'uLight'] as const) (this.eyeMat.uniforms[k].value as Vector3).copy(col);
    (this.glowMat.uniforms.uLight.value as Vector3).copy(EYE_STEPS[Math.max(0, step - 1)]);

    // ---- where it looks: at the player once seen and near, else lolling
    const P = this.pose;
    this.headPosition(_v);
    let wantYaw = 0.55 + 0.15 * noise1(t * 0.13, 21);
    let wantPitch = 0.05 * noise1(t * 0.1, 22);
    // it lies rolled a little toward the viewer (+z), so its front shows
    // (its left points along (cos yaw, -sin yaw) on the ground; rolling + turns its front that way)
    const toView = -Math.sin(this.yaw) >= 0 ? 1 : -1;
    let wantRoll = 0.3 * toView;
    const watching = this.seen && d < 14;
    if (watching) {
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      const dx = player.x - _v.x;
      const dz = player.z - _v.z;
      const bx = dx * c - dz * s; // to its left
      const bz = dx * s + dz * c; // toward its feet
      const up = player.y + 0.9 - _v.y;
      wantRoll = clamp(0.15 * toView + bx * 0.12, -0.4, 0.4);
      wantYaw = clamp(Math.atan2(bx, Math.max(0.3, up)), -1.3, 1.3) - wantRoll;
      wantPitch = clamp(Math.atan2(bz, Math.hypot(bx, up)) * 0.6, -0.25, 0.5);
    }
    if (inEnc) {
      const lift = smoothstep(E.lift, E.cry, enc) * (1 - smoothstep(E.sink, E.end, enc));
      wantPitch += 0.25 * lift + 0.08 * noteAmt;
    }
    P.pelvisYaw = this.roll.update(dt, wantRoll);
    P.headYaw = this.lookYaw.update(dt, wantYaw);
    const pitch = this.lookPitch.update(dt, wantPitch);
    P.neckPitch = pitch * 0.55;
    P.headPitch = pitch * 0.45 - inhale * 0.12;
    P.headRoll = crying ? noise1(t * 14, 31) * 0.12 : noise1(t * 0.7, 32) * 0.03;
    // gasping arches the back a little; crying racks the whole body
    P.spinePitch = LYING.spinePitch - inhale * 0.06 + (crying ? noise1(t * 9, 33) * 0.05 : 0);
    P.chestPitch = LYING.chestPitch - inhale * 0.05 + pitch * 0.15;
    P.pelvisY = LYING.pelvisY + (crying ? Math.abs(noise1(t * 7, 34)) * 0.015 : 0);

    // ---- now and then it struggles: a shudder, the good leg pushing at the sand
    this.struggleTimer -= dt;
    if (this.struggleTimer <= 0 && !inEnc) {
      this.struggleTimer = 4 + Math.random() * 6;
      this.struggle = 1;
    }
    const before = this.struggle;
    this.struggle = Math.max(0, this.struggle - dt * 0.6);
    const push = this.struggle > 0 ? Math.sin((1 - this.struggle) * Math.PI) : 0;
    P.footR.z = LYING.footR.z + push * 0.16;
    P.footR.lift = push * 0.04;
    if (before > 0.5 && this.struggle <= 0.5 && d < 30) {
      // the hoof shoves at the sand
      this.bodyToWorld(-0.17, 0.62, _w);
      for (let i = 0; i < 5; i++) {
        this.dust.spawn(
          _w.x,
          _w.y + 0.02,
          _w.z,
          (Math.random() - 0.5) * 0.6,
          0.4 + Math.random() * 0.5,
          (Math.random() - 0.5) * 0.6,
          0.5 + Math.random() * 0.4,
          SAND,
          1,
          { g: 3, drag: 1, windK: 0.3 },
        );
      }
      this.audio.scuff(0.12 * saturate(1.5 - d / 8));
    }
    P.tremble = 0.18 + this.struggle * 0.6 + (crying ? 0.75 : 0) + (singing ? 0.25 : 0) + this.reach.y * 0.35;

    // ---- arms: one hand pressed to the wound, the other reaching out the first time it sees the player
    rigWound(this, _w);
    this.toBody(_w, P.handR);
    P.handR.y += 0.03;
    let reachWant = 0;
    if (this.reachT >= 0) {
      this.reachT += dt;
      const r = this.reachT;
      reachWant = r < 0.7 ? 0 : r < 4.0 ? 1 : 0;
      if (r > 5.5) this.reachT = -1;
    }
    if (inEnc) reachWant = Math.max(reachWant, 0.45 * smoothstep(E.notes[0] - 0.3, E.notes[0] + 0.3, enc) * (1 - smoothstep(E.sink - 0.4, E.sink, enc)));
    const rv = this.reach.update(dt, reachWant);
    this.creature.rig.arms[0].shoulder.getWorldPosition(_v);
    // toward the player, but out to its side too, so the arm clears its body
    const hl = Math.max(0.01, Math.hypot(player.x - _v.x, player.z - _v.z));
    const hx = ((player.x - _v.x) / hl) * 0.6 + Math.cos(this.yaw) * 0.55;
    const hz = ((player.z - _v.z) / hl) * 0.6 - Math.sin(this.yaw) * 0.55;
    const hn = Math.max(0.01, Math.hypot(hx, hz));
    _w.set(_v.x + (hx / hn) * 0.4, _v.y + 0.13, _v.z + (hz / hn) * 0.4);
    this.toBody(_w, P.handL);
    const rest = LYING.handL;
    const k = clamp(rv, 0, 1.1);
    P.handL.x = lerp(rest.x, P.handL.x, k);
    P.handL.y = lerp(rest.y, P.handL.y, k) + noise1(t * 6, 41) * 0.03 * k;
    P.handL.z = lerp(rest.z, P.handL.z, k);
    // the arm drops back onto the sand
    if (rv > 0.4) this.landed = false;
    if (!this.landed && rv < 0.08) {
      this.landed = true;
      this.bodyToWorld(rest.x, rest.z, _w);
      this.dust.kick(_w.x, _w.y, _w.z, 0, 0, 3, 0.35);
      this.audio.thud(0.12 * saturate(1.6 - d / 8));
    }

    this.creature.updateScripted(dt, P, this.world);
    this.breakLeg();
  }

  /** 0..1 loudness of the note being sung at encounter time `enc`. */
  private noteEnvelope(enc: number) {
    if (enc < 0) return 0;
    let a = 0;
    for (const n of E.notes) {
      const u = (enc - n) / E.noteLen;
      // each note catches in the middle and comes out as two (see noteSamples)
      if (u > 0 && u < 1) a = Math.max(a, Math.min(1, u * 8, (1 - u) * 4) * (1 - 0.8 * smoothstep(0.06, 0, Math.abs(u - 0.48))));
    }
    return a;
  }

  private updateBreath(dt: number, enc: number, inEnc: boolean, crying: boolean, singing: boolean) {
    let target: number;
    const near = this.distance < 30;
    if (crying) {
      // short shuddering heaves
      target = Math.sin(enc * 22) > 0 ? 0.75 : 0.15;
    } else if (inEnc && enc > E.inhale - 0.05 && enc < E.notes[0]) {
      target = 1;
    } else if (singing) {
      // the tune is sung on one long breath out
      target = lerp(1, -0.7, (enc - E.notes[0]) / (E.notes[2] + E.noteLen - E.notes[0]));
    } else {
      this.breathTimer -= dt;
      if (this.breathTimer <= 0) {
        switch (this.breathState) {
          case 'pause':
            this.breathState = 'in';
            this.breathTimer = 0.5 + Math.random() * 0.25;
            if (near && !inEnc) this.audio.strangerBreath(0.7, true);
            break;
          case 'in':
            this.breathState = 'hold';
            this.breathTimer = 0.1 + Math.random() * 0.25;
            break;
          case 'hold':
            this.breathState = 'out';
            this.breathTimer = 0.8 + Math.random() * 0.4;
            if (near && !inEnc) this.audio.strangerBreath(0.5, false);
            break;
          default:
            this.breathState = 'pause';
            this.breathTimer = 0.3 + Math.random() * 1.3;
        }
      }
      target = this.breathState === 'in' || this.breathState === 'hold' ? 1 : this.breathState === 'out' ? -0.6 : -0.3;
      if (this.breathState === 'hold') target += Math.sin(this.time * 40) * 0.08;
    }
    this.breath.value = this.breathDyn.update(dt, target);
  }

  /** The left leg is broken below the knee: the shin juts out sideways and the hoof lies twisted. */
  private breakLeg() {
    const c = this.creature;
    const rig = c.rig;
    const leg = rig.legs[0];
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    // body x (its left), y (up), z (toward its feet) to a world direction
    const dir = (x: number, y: number, z: number, out: Vector3) =>
      out.set(x * cy + z * sy, y, -x * sy + z * cy).normalize();
    _hip.set(LEG.hipWidth, -0.04, 0);
    rig.pelvis.localToWorld(_hip);
    _knee.copy(_hip).addScaledVector(dir(0.4, 0.3, 0.86, _v), LEG.thigh);
    _hock.copy(_knee).addScaledVector(dir(0.92, -0.38, -0.12, _v), LEG.shin);
    _hock.y = Math.max(_hock.y, terrainHeight(_hock.x, _hock.z) + 0.06);
    _fet.copy(_hock).addScaledVector(dir(0.35, -0.45, 0.82, _v), LEG.cannon);
    _fet.y = Math.max(_fet.y, terrainHeight(_fet.x, _fet.z) + 0.05);
    dir(0, 0, 1, _w);
    orient(leg.thigh.obj, _hip, _knee, _w);
    orient(leg.shin.obj, _knee, _hock, _w);
    orient(leg.cannon.obj, _hock, _fet, _w);
    leg.hoof.position.copy(_fet);
    leg.hoof.position.y -= LEG.hoof * 0.6;
    _e.set(0.5, this.yaw + 1.9, 1.25, 'YXZ');
    leg.hoof.quaternion.setFromEuler(_e);
  }

  /**
   * The way it came: a curve from the pod's hatch to under its hips, arriving
   * head first along its body. `mid` is the curve's halfway point.
   */
  trailPath(from: Vector3) {
    this.bodyToWorld(0, 0.25, _w);
    const end = { x: _w.x, z: _w.z };
    const L = Math.hypot(end.x - from.x, end.z - from.z);
    const control = { x: end.x - this.axis.x * L * 0.42, z: end.z - this.axis.z * L * 0.42 };
    const mid = { x: (from.x + 2 * control.x + end.x) / 4, z: (from.z + 2 * control.z + end.z) / 4 };
    return { end, control, mid, length: L };
  }

  /**
   * Paint what it left on the sand on its way here. It fell out of the hatch,
   * tried to limp on its good leg, collapsed, and crawled the rest: dragging
   * its body and its broken leg, clawing forward with its hands and shoving
   * with its good hoof, stopping more and more often. Blood fell from the
   * wound in sparse drips and pooled where it rested. The oldest marks, near
   * the pod, are half filled in by blown sand.
   */
  paint(stains: StainMap, from: Vector3) {
    const rand = rng(7731);
    const path = this.trailPath(from);
    const { end, control } = path;
    const pts: { x: number; z: number; tx: number; tz: number; s: number }[] = [];
    let prevX = from.x;
    let prevZ = from.z;
    let s = 0;
    const N = 800;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const a = (1 - u) * (1 - u);
      const b = 2 * u * (1 - u);
      const c = u * u;
      let x = a * from.x + b * control.x + c * end.x;
      let z = a * from.z + b * control.z + c * end.z;
      const tx = 2 * (1 - u) * (control.x - from.x) + 2 * u * (end.x - control.x);
      const tz = 2 * (1 - u) * (control.z - from.z) + 2 * u * (end.z - control.z);
      const tl = Math.hypot(tx, tz) || 1;
      // it could not keep a straight line
      const wob = (noise1(u * path.length * 0.22, 61) * 0.6 + noise1(u * path.length * 0.9, 62) * 0.15) * Math.sin(Math.PI * u);
      x += (-tz / tl) * wob;
      z += (tx / tl) * wob;
      s += Math.hypot(x - prevX, z - prevZ);
      prevX = x;
      prevZ = z;
      pts.push({ x, z, tx: tx / tl, tz: tz / tl, s });
    }
    const total = s;
    const at = (q: number) => {
      let lo = 0;
      let hi = pts.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (pts[m].s < q) lo = m;
        else hi = m;
      }
      return pts[hi];
    };
    type P = { x: number; z: number; tx: number; tz: number };
    const off = (p: P, side: number, along: number) => ({
      x: p.x - p.tz * side + p.tx * along,
      z: p.z + p.tx * side + p.tz * along,
    });
    const yawOf = (p: P) => Math.atan2(p.tx, p.tz);
    // older marks, near the pod, are softer and part buried
    const age = (q: number) => 0.5 + 0.5 * (q / total);
    const fresh = (q: number) => 0.1 + 0.8 * (q / total);

    /** One falling drop, with a satellite or two flung off where it hit. */
    const drop = (x: number, z: number, r: number, f: number) => {
      stains.splat(x, z, r, 0.95, f);
      if (rand() < 0.55) {
        const n = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < n; i++) {
          const a = rand() * Math.PI * 2;
          const d = r * (1.6 + rand() * 1.6);
          stains.splat(x + Math.cos(a) * d, z + Math.sin(a) * d, r * (0.25 + rand() * 0.2), 0.9, f);
        }
      }
    };
    /** A pool where it lay and bled: a few overlapping, ragged blots and spatter round them. */
    const blotch = (x: number, z: number, size: number, f: number) => {
      const n = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const d = size * rand() * 0.8;
        stains.splat(x + Math.cos(a) * d, z + Math.sin(a) * d, size * (0.45 + rand() * 0.5), 1, f);
      }
      for (let i = 0; i < 4; i++) {
        const a = rand() * Math.PI * 2;
        const d = size * (1.4 + rand() * 1.5);
        drop(x + Math.cos(a) * d, z + Math.sin(a) * d, 0.012 + rand() * 0.02, f);
      }
    };
    /** Where it lay: a body-shaped hollow and sand pushed about by its struggling. */
    const rest = (p: P, q: number, size: number) => {
      const k = age(q);
      stains.dent(p.x, p.z, 0.3 * size, 0.6 * size, yawOf(p), 0.055 * k);
      stains.churn(p.x, p.z, 0.65 * size, 0.7 * k, q);
      const b = off(p, -0.1, 0.12);
      blotch(b.x, b.z, 0.1 * size, fresh(q));
      // a hand pressed to the wound, then to the sand
      if (rand() < 0.7) {
        const hp = off(p, (rand() < 0.5 ? -1 : 1) * 0.32, 0.3);
        stains.splat(hp.x, hp.z, 0.035, 0.75, fresh(q));
        stains.dent(hp.x, hp.z, 0.05, 0.06, 0, 0.03 * k);
      }
    };

    // ---- it fell out of the hatch onto the sand
    const p0 = at(0.05);
    stains.dent(from.x, from.z, 0.4, 0.75, yawOf(p0) + 1.2, 0.05 * age(0));
    stains.churn(from.x, from.z, 0.85, 0.6, 3);
    blotch(from.x + p0.tx * 0.1, from.z + p0.tz * 0.1, 0.12, fresh(0));
    for (const sd of [-1, 1]) {
      const h = off(p0, sd * 0.35, 0.45);
      stains.dent(h.x, h.z, 0.05, 0.07, 0, 0.035 * age(0));
    }

    // ---- it tried to walk: hoof prints of the good leg, the broken one dragging, drops falling
    const limpEnd = 3.6 + rand() * 1.2;
    for (let q = 0.9; q < limpEnd; q += 0.5 + rand() * 0.12) {
      const p = at(q);
      const k = age(q);
      const hoof = off(p, -0.1, 0);
      stains.dent(hoof.x, hoof.z, 0.05, 0.07, yawOf(p), 0.04 * k);
      const a = off(p, 0.12, -0.25);
      const b = off(at(q + 0.5), 0.12, -0.25);
      stains.groove(a.x, a.z, b.x, b.z, 0.03, 0.03 * k);
      if (rand() < 0.65) {
        const d = off(p, (rand() - 0.5) * 0.25, rand() * 0.4);
        drop(d.x, d.z, 0.018 + rand() * 0.022, fresh(q));
      }
    }
    // ---- and went down
    rest(at(limpEnd + 0.3), limpEnd, 1.3);

    // ---- then it crawled
    const crawlStart = limpEnd + 0.9;
    const crawlLen = total - 1.2 - crawlStart;
    const stops = [0.28, 0.52, 0.68, 0.8, 0.9].map((f) => crawlStart + crawlLen * (f + (rand() - 0.5) * 0.05));
    let stop = 0;
    let stride = 0;
    let hand = 1;
    for (let q = crawlStart; q < total - 1.2; ) {
      const u = (q - crawlStart) / crawlLen;
      // weaker and weaker: the pulls get shorter
      const step = (0.58 - 0.26 * u) * (0.85 + rand() * 0.3);
      const p = at(q);
      const n = at(Math.min(total, q + step));
      const k = age(q);
      // its body pressed a trough, deeper where it sagged, barely touching where it heaved itself up
      const press = 0.5 + 0.5 * noise1(q * 1.3, 81);
      stains.groove(p.x, p.z, n.x, n.z, 0.13, (0.012 + 0.035 * press) * k);
      // the broken leg dragged behind, a thin wavering line
      const l0 = off(p, 0.14 + noise1(q * 2, 82) * 0.03, -0.55);
      const l1 = off(n, 0.14 + noise1((q + step) * 2, 82) * 0.03, -0.55);
      stains.groove(l0.x, l0.z, l1.x, l1.z, 0.03, 0.03 * k);
      // a hand reached ahead, dug in and pulled, heaping sand behind its claws
      hand = -hand;
      const h0 = off(p, hand * (0.27 + rand() * 0.05), 0.42);
      const h1 = off(p, hand * 0.27, 0.22);
      stains.groove(h0.x, h0.z, h1.x, h1.z, 0.035, 0.05 * k);
      stains.dent(h1.x, h1.z, 0.05, 0.05, 0, -0.035 * k);
      if (rand() < 0.1 + 0.15 * u) stains.splat(h0.x, h0.z, 0.025, 0.7, fresh(q));
      // every other pull, the good hoof shoved at the sand
      if (stride++ % 2 === 1) {
        const g0 = off(p, -0.12, -0.6);
        const g1 = off(p, -0.12, -0.82);
        stains.groove(g0.x, g0.z, g1.x, g1.z, 0.04, 0.05 * k);
        stains.dent(g1.x, g1.z, 0.06, 0.05, 0, -0.04 * k);
      }
      // blood: a drip now and then, more as it weakened, and a short smear where its belly pressed
      const drips = rand() < 0.3 + 0.45 * u ? 1 + Math.floor(rand() * 2) : 0;
      for (let i = 0; i < drips; i++) {
        const d = off(p, -0.04 + (rand() - 0.5) * 0.2, rand() * step);
        drop(d.x, d.z, 0.014 + rand() * 0.024, fresh(q));
      }
      if (press > 0.75 && rand() < 0.22) {
        const a = off(p, -0.05, 0);
        const b = off(p, -0.05, 0.12 + rand() * 0.12);
        stains.smear(a.x, a.z, b.x, b.z, 0.035, 0.6, fresh(q));
      }
      if (stop < stops.length && q + step >= stops[stop]) {
        rest(at(stops[stop]), stops[stop], 0.9 + 0.35 * u);
        stop++;
      }
      q += step;
    }

    // ---- where it lies now: a hollow, sand churned all round, gouges from kicking hooves and flailing arms
    const ax = this.axis.x;
    const az = this.axis.z;
    this.bodyToWorld(0, -0.2, _w);
    stains.dent(_w.x, _w.z, 0.36, 0.95, Math.atan2(ax, az), 0.06);
    stains.churn(_w.x, _w.z, 1.35, 1, 9);
    const kick = (bx: number, bz: number, n: number, spread: number, len: number) => {
      this.bodyToWorld(bx, bz, _v);
      for (let i = 0; i < n; i++) {
        const a = Math.atan2(-ax, -az) + (rand() - 0.5) * spread;
        const l = len * (0.6 + rand() * 0.6);
        const x1 = _v.x + Math.sin(a) * l;
        const z1 = _v.z + Math.cos(a) * l;
        stains.groove(_v.x, _v.z, x1, z1, 0.05, 0.07);
        stains.dent(x1, z1, 0.09, 0.09, 0, -0.05);
      }
    };
    kick(-0.17, 0.5, 6, 1.8, 0.45);
    kick(0.42, 0.6, 3, 1.2, 0.3);
    // arms sweeping the sand beside it
    for (const sx of [1, -1]) {
      for (let i = 0; i < 3; i++) {
        const a0 = -0.6 + i * 0.35;
        this.bodyToWorld(sx * (0.35 + 0.1 * i), -0.55 + a0 * 0.3, _v);
        this.bodyToWorld(sx * (0.5 + 0.12 * i), -0.15 + a0 * 0.3, _w);
        stains.groove(_v.x, _v.z, _w.x, _w.z, 0.045, 0.05);
      }
    }
    // blood ran off its side into the sand, and its hand left smudges
    this.bodyToWorld(-0.3, -0.25, _v);
    blotch(_v.x, _v.z, 0.17, 0.95);
    this.bodyToWorld(-0.5, -0.05, _v);
    this.bodyToWorld(-0.6, 0.1, _w);
    stains.smear(_v.x, _v.z, _w.x, _w.z, 0.04, 0.7, 0.85);
    for (let i = 0; i < 10; i++) {
      this.bodyToWorld((rand() - 0.6) * 1.5, (rand() - 0.5) * 1.7, _v);
      drop(_v.x, _v.z, 0.012 + rand() * 0.022, 0.75);
    }
    stains.commit();
  }
}

/** The middle of the wound, in world space. */
function rigWound(s: Stranger, out: Vector3) {
  return s.creature.rig.spine.localToWorld(out.set(0.0, 0.09, 0.14));
}
