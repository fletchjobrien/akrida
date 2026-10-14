import { Vector2, Vector3 } from 'three';
import { Creature, type CreatureInput, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import { blendPose, type ScriptPose } from '../character/scriptPose';
import { noise1 } from '../core/math';
import type { AudioEngine } from '../audio/AudioEngine';
import type { FacilityInterior } from '../world/facilityInterior';
import { PIPE_TONES, TONES, TUNE } from './tune';
import { KNEEL, RISE, STAND, ease, hand, mk } from './WakeUp';

/** A soft rose, its eye bright: alive. */
const ROSE: Skin = {
  fur: [0x5a3040, 0x8a4a5e, 0xa8667a],
  belly: [0xa87a88, 0xc89aa6, 0xdcb6c0],
  hoof: [0x3a1e28, 0x5a3040],
  eye: 0xffffff,
};

/** Crouched in the corner, knees drawn up, arms wrapped round them, head down, shaking. */
const CROUCH: ScriptPose = mk(STAND, {
  pelvisY: 0.2,
  pelvisZ: -0.05,
  pelvisPitch: -0.55,
  pelvisYaw: 0,
  spinePitch: 0.5,
  chestPitch: 0.4,
  chestRoll: 0,
  neckPitch: 0.55,
  headPitch: 0.35,
  headYaw: 0,
  headRoll: 0,
  handL: hand(0.14, 0.42, 0.3),
  handR: hand(-0.14, 0.42, 0.3),
  armPitch: 0,
  elbow: -1.2,
  armOut: 0.1,
  footL: { x: 0.15, z: 0.34, lift: 0, tilt: 0.55, pitch: 0.2, poleDown: 0 },
  footR: { x: -0.15, z: 0.3, lift: 0, tilt: 0.55, pitch: 0.2, poleDown: 0 },
  eyeOpen: 1,
  tremble: 1,
  exertion: 0.7,
});

/** Out of hiding at last: standing hunched, arms held in close, still shaking. */
const WARY: ScriptPose = mk(STAND, { pelvisY: 0.66, spinePitch: 0.18, chestPitch: 0.1, neckPitch: 0.2, tremble: 0.7, exertion: 0.6, elbow: -1.3, armOut: 0.02 });

type Knock = { pipe: number; at: number };

/**
 * The one still alive in the facility: an Akridian hiding in the vault, a
 * soft rose colour, crouched in the corner by the pipes, shaking. It cannot
 * see who is out there. It hears the knocks on the pipes and knocks back,
 * nervously, the same pattern, testing: anyone could be out there. Knock the
 * three tones the dying stranger sang, in order, and it knows one of its own
 * is outside: it knocks them back, draws the bolts, and comes out.
 *
 * A phrase ends when the knocking stops for a moment. It answers after a
 * pause, a little slower than it was knocked, its timing unsteady; now and
 * then it falters and leaves the last knock off. If the knocking goes on while
 * it answers, it stops at once. Too many wrong answers and it sometimes does
 * not answer at all. When someone tries its door, it freezes.
 */
export class Survivor {
  readonly creature: Creature;
  state: 'hiding' | 'answering' | 'trusting' | 'rising' | 'walking' | 'out' = 'hiding';
  /** It has let them in: the door is open (or opening). */
  get freed() {
    return this.state === 'rising' || this.state === 'walking' || this.state === 'out';
  }
  private readonly world: World;
  private readonly pose: ScriptPose = mk(CROUCH, {});
  private phrase: Knock[] = [];
  private lastHeard = -9;
  private answer: Knock[] = [];
  private wrong = 0;
  private frozenUntil = 0;
  private time = 0;
  /** The hand's reach toward the pipe it knocks (0..1, then back), and which pipe. */
  private reach = 0;
  private reachPipe = 0;
  private reachAt = -9;
  private voiceTimer = 3;
  private t = 0;
  private path: Vector3[] = [];
  private seg = 0;
  private readonly input: CreatureInput = { move: new Vector2(), sprint: false, crouch: false, look: null };
  private readonly look = new Vector3();
  private readonly tmp = new Vector3();
  private sung = false;

  constructor(
    private readonly interior: FacilityInterior,
    private readonly audio: AudioEngine,
  ) {
    this.world = { height: interior.height, rocks: interior.colliders };
    const h = interior.hide;
    this.creature = new Creature(this.world, h.x, h.z, ROSE);
    this.reset();
  }

  /** Back in hiding, the door shut (after a death undoes it). */
  reset() {
    const c = this.creature;
    const h = this.interior.hide;
    c.releaseScript();
    c.teleport(h.x, h.z, this.world);
    c.setYaw(this.interior.hideYaw);
    c.pos.set(h.x, this.interior.floorY, h.z);
    c.scriptBreath = null;
    this.state = 'hiding';
    this.phrase = [];
    this.answer = [];
    this.wrong = 0;
    this.frozenUntil = 0;
    this.sung = false;
    blendPose(this.pose, CROUCH, CROUCH, 0);
    for (let i = 0; i < 20; i++) c.updateScripted(1 / 30, this.pose, this.world);
  }

  /** Someone outside knocked on pipe `i`. */
  heard(i: number) {
    if (this.state !== 'hiding' && this.state !== 'answering') return;
    if (this.state === 'answering') {
      // knocked over its answer: it stops dead
      this.answer = [];
      this.state = 'hiding';
      this.frozenUntil = this.time + 0.6;
    }
    this.phrase.push({ pipe: i, at: this.time });
    this.lastHeard = this.time;
  }

  /** Someone tried its door: it freezes, and will not answer for a while. */
  doorTried() {
    if (this.freed) return;
    this.answer = [];
    if (this.state === 'answering') this.state = 'hiding';
    this.phrase = [];
    this.frozenUntil = this.time + 4;
    this.voiceTimer = 0.8;
  }

  /** The knocks of the stranger's tune, as pipes. */
  private static readonly TUNE_PIPES = TUNE.map((t) => PIPE_TONES.indexOf(t as (typeof PIPE_TONES)[number]));

  /** It has heard the whole of a phrase: decide how it answers. */
  private answerPhrase() {
    const p = this.phrase;
    this.phrase = [];
    const tp = Survivor.TUNE_PIPES;
    const tail = p.slice(-tp.length);
    const right = tail.length === tp.length && tail.every((k, i) => k.pipe === tp[i]);
    // it answers after a breath, a little slower, unsteady
    const start = this.time + 0.9 + Math.random() * 0.7;
    const said = right ? tail : p.slice(-6);
    const out: Knock[] = [];
    let at = start;
    for (let i = 0; i < said.length; i++) {
      if (i > 0) {
        const gap = Math.min(1.2, Math.max(0.22, said[i].at - said[i - 1].at));
        at += gap * (right ? 1.2 : 1.15 + Math.random() * 0.35) + (Math.random() - 0.5) * (right ? 0.04 : 0.12);
      }
      out.push({ pipe: said[i].pipe, at });
    }
    if (right) {
      this.answer = out;
      this.state = 'trusting';
      this.t = 0;
      return;
    }
    this.wrong++;
    // after a few wrong answers it grows warier: now and then it does not answer at all
    if (this.wrong > 3 && Math.random() < 0.3) {
      this.voiceTimer = 1.2;
      return;
    }
    // and sometimes its nerve fails before the last knock
    if (out.length > 1 && Math.random() < 0.25) out.pop();
    this.answer = out;
    this.state = 'answering';
  }

  /** Knock pipe `i` from inside: reach for it, then the knock comes through the wall. */
  private knock(i: number, listener: Vector3, freed = false) {
    const pipe = this.interior.pipes[i];
    this.reachPipe = i;
    this.reachAt = this.time;
    const pan = Math.max(-0.8, Math.min(0.8, (pipe.inner.x - listener.x) / 6));
    const d = listener.distanceTo(pipe.inner);
    this.audio.pipeKnock(pipe.f, 0.5 / (1 + d * d * 0.02), pan, !freed, pipe.size);
  }

  update(dt: number, listener: Vector3) {
    this.time += dt;
    this.t += dt;
    const c = this.creature;
    const I = this.interior;
    const listenerNear = listener.distanceTo(I.hide) < 9;

    if (this.state === 'hiding' || this.state === 'answering' || this.state === 'trusting') {
      // a phrase is over when the knocking stops for a moment
      if (this.state === 'hiding' && this.phrase.length && this.time - this.lastHeard > 1.4 && this.time > this.frozenUntil) this.answerPhrase();
      // its answer, knock by knock
      while (this.answer.length && this.time >= this.answer[0].at) {
        const k = this.answer.shift()!;
        this.knock(k.pipe, listener);
      }
      if (this.state === 'answering' && !this.answer.length) {
        this.state = 'hiding';
        this.voiceTimer = Math.min(this.voiceTimer, 0.7);
      }
      // the crouch, shaking, its head darting at every sound; reaching out to knock
      blendPose(this.pose, CROUCH, CROUCH, 0);
      const p = this.pose;
      const jumpy = this.time < this.frozenUntil ? 0.15 : 1;
      p.headYaw = (noise1(this.time * 1.7, 3) * 0.7 + noise1(this.time * 5.3, 9) * 0.2) * jumpy;
      p.headPitch = 0.35 + noise1(this.time * 1.1, 4) * 0.2;
      p.neckPitch = 0.5 + noise1(this.time * 0.9, 6) * 0.15;
      p.tremble = this.time < this.frozenUntil ? 1.4 : 1;
      // the knock: the right hand out to the pipe and back
      const since = this.time - this.reachAt;
      this.reach = since < 0.12 ? since / 0.12 : since < 0.18 ? 1 : Math.max(0, 1 - (since - 0.18) / 0.25);
      if (this.reach > 0) {
        const target = this.bodySpace(I.pipes[this.reachPipe].inner, this.tmp);
        const r = Math.hypot(target.x, target.z);
        if (r > 0.75) target.multiplyScalar(0.75 / r);
        const e = ease('inOut', this.reach);
        p.handR.x += (target.x - p.handR.x) * e;
        p.handR.z += (target.z - p.handR.z) * e;
        p.handR.y += (0.4 - p.handR.y) * e;
        p.chestRoll -= 0.25 * e;
        p.headYaw += (-0.8 - p.headYaw) * e;
      }
      c.updateScripted(dt, p, this.world);
      // little sounds it cannot keep in: muffled whimpers through the wall
      this.voiceTimer -= dt;
      if (this.voiceTimer <= 0) {
        this.voiceTimer = 4 + Math.random() * 7;
        if (listenerNear) this.audio.specimenVoice(Math.random() < 0.6 ? 'whimper' : 'gasp', 0.12, this.pan(listener), true);
      }
      this.trust(dt);
      return;
    }

    if (this.state === 'rising') {
      // up out of the corner
      const keys: [number, ScriptPose][] = [
        [0, CROUCH],
        [0.7, KNEEL],
        [1.3, RISE],
        [1.9, WARY],
      ];
      let k = 0;
      while (k < keys.length - 2 && this.t > keys[k + 1][0]) k++;
      const [t0, a] = keys[k];
      const [t1, b] = keys[k + 1];
      blendPose(this.pose, a, b, ease('inOut', Math.min(1, Math.max(0, (this.t - t0) / (t1 - t0)))));
      c.updateScripted(dt, this.pose, this.world);
      if (this.t > 2.1 && I.vault.state === 'open') {
        c.releaseScript(0.5);
        this.state = 'walking';
        this.path = [I.vault.inside.clone(), I.vault.outside.clone()];
        this.seg = 0;
      }
      return;
    }

    // out: walking from the corner to the door and out of it, then standing, wary, eyes on the creature
    c.panic = 0.5;
    c.tired = Math.max(c.tired, 0.6);
    this.input.move.set(0, 0);
    this.input.look = this.look.copy(listener).setY(listener.y + 1.1);
    if (this.state === 'walking') {
      const to = this.path[this.seg];
      const dx = to.x - c.pos.x;
      const dz = to.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.25) {
        if (this.seg < this.path.length - 1) this.seg++;
        else this.state = 'out';
      } else {
        const s = Math.min(0.45, d * 0.8);
        this.input.move.set((dx / d) * s, (-dz / d) * s);
      }
    }
    c.update(dt, this.input, this.world);
    // and once it is out, it sings them softly: the stranger's three tones, the song of its own
    if (this.state === 'out' && !this.sung) {
      this.sung = true;
      this.t = 0;
    }
    if (this.state === 'out' && this.sung && this.t < 4) {
      const notes = [0.4, 1.3, 2.2];
      for (let i = 0; i < notes.length; i++) {
        if (this.t >= notes[i] && this.t - dt < notes[i]) this.audio.survivorNote(TONES[TUNE[i]], i === 2 ? 1.4 : 0.8, 0.22, this.pan(listener));
      }
    }
  }

  /** Answered with the tune: once its knocks are done, the bolts, the door, and out. */
  private trustT = -1;
  private trust(dt: number) {
    if (this.state !== 'trusting' || this.answer.length) return;
    const I = this.interior;
    if (this.trustT < 0) this.trustT = 0;
    this.trustT += dt;
    if (this.trustT > 1.1 && I.vault.state === 'locked') I.unlockVault();
    if (this.trustT > 3.0 && I.vault.state === 'unlocking') I.openVault();
    if (this.trustT > 3.4) {
      this.state = 'rising';
      this.t = 0;
      this.trustT = -1;
    }
  }

  private pan(listener: Vector3) {
    return Math.max(-0.8, Math.min(0.8, (this.creature.pos.x - listener.x) / 6));
  }

  /** A point in the world in its body's space (x to its left, z ahead), as a hand target. */
  private bodySpace(p: Vector3, out: Vector3) {
    const c = this.creature;
    const sn = Math.sin(c.yaw);
    const cs = Math.cos(c.yaw);
    const rx = p.x - c.pos.x;
    const rz = p.z - c.pos.z;
    return out.set(rx * cs - rz * sn, 0, rx * sn + rz * cs);
  }
}
