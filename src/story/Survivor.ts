import { Vector2, Vector3 } from 'three';
import { Creature, type CreatureInput, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import { blendPose, type ScriptPose } from '../character/scriptPose';
import { noise1 } from '../core/math';
import type { AudioEngine } from '../audio/AudioEngine';
import type { FacilityInterior } from '../world/facilityInterior';
import { BEAT, PIPE_TONES, TONES, WALL_SONG } from './tune';
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

/** Overjoyed: up on its hooves, head up, both arms thrown up high. */
const JOY: ScriptPose = mk(STAND, {
  pelvisPitch: 0.05,
  spinePitch: -0.08,
  chestPitch: -0.1,
  neckPitch: -0.15,
  headPitch: -0.25,
  handL: hand(0.3, 1.75, 0.18, 1),
  handR: hand(-0.3, 1.75, 0.18, 1),
  tremble: 0.15,
  exertion: 0.9,
  eyeOpen: 1,
});

type Knock = { pipe: number; at: number };

/**
 * The one still alive in the facility: an Akridian hiding in the vault, a
 * soft rose colour, crouched in the corner by the pipes, shaking. It cannot
 * see who is out there. It hears the knocks on the pipes and knocks back,
 * nervously, the same pattern, testing: anyone could be out there. Knock the
 * song painted on the hall's wall, and it knows one of its own is outside: it
 * knocks it back, draws the bolts, and comes out, still afraid, peeking out
 * and starting back; and when it sees who it is, it jumps for joy, sings, and
 * from then on keeps close.
 *
 * A phrase ends when the knocking stops for a moment. It answers after a
 * pause, a little slower than it was knocked, its timing unsteady; now and
 * then it falters and leaves the last knock off. If the knocking goes on while
 * it answers, it stops at once. Too many wrong answers and it sometimes does
 * not answer at all. When someone tries its door, it freezes.
 */
export class Survivor {
  readonly creature: Creature;
  state: 'hiding' | 'answering' | 'trusting' | 'rising' | 'peeking' | 'watching' | 'excited' | 'with' = 'hiding';
  /** It has let them in: the door is open (or opening). */
  get freed() {
    return this.state === 'rising' || this.state === 'peeking' || this.state === 'watching' || this.state === 'excited' || this.state === 'with';
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
  /** Its way out, a step at a time: where to, crouched or not, how long to stay there. */
  private steps: { to: Vector3; crouch: boolean; wait: number; flinch?: boolean }[] = [];
  private seg = 0;
  private waited = 0;
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

  /** The knocks of the song painted on the wall, as pipes. */
  private static readonly TUNE_PIPES = WALL_SONG.map(([t]) => PIPE_TONES.indexOf(t as (typeof PIPE_TONES)[number]));

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
        // out the way a frightened thing comes out: creep to the doorway and look, flinch
        // back, creep out again, and only then step out
        const v = I.vault;
        const back = v.inside.clone().lerp(I.hide, 0.45);
        const peek = v.inside.clone().lerp(v.outside, 0.38);
        this.steps = [
          { to: v.inside.clone(), crouch: true, wait: 1.3 },
          { to: back, crouch: true, wait: 1.1, flinch: true },
          { to: peek, crouch: true, wait: 1.4 },
          { to: v.outside.clone(), crouch: false, wait: 0 },
        ];
        this.seg = 0;
        this.waited = 0;
        this.state = 'peeking';
      }
      return;
    }

    if (this.state === 'excited') {
      // it sees who it is: it jumps for joy, arms up, again and again, and sings
      const hop = Math.max(0, Math.sin(this.t * Math.PI * 2.6)) * (this.t < 2.4 ? 1 : 0);
      blendPose(this.pose, WARY, JOY, ease('out', Math.min(1, this.t * 3)) * (this.t < 2.6 ? 1 : Math.max(0, 1 - (this.t - 2.6) * 2)));
      const p = this.pose;
      p.pelvisY += hop * 0.22;
      p.footL.lift += hop * 0.2;
      p.footR.lift += hop * 0.2;
      p.handL.x += Math.sin(this.t * 9) * 0.08;
      p.handR.x += Math.sin(this.t * 9 + 1) * 0.08;
      p.headYaw = Math.sin(this.t * 5) * 0.25;
      c.updateScripted(dt, p, this.world);
      // a quick, bright run up the song, then it whole
      const notes = [0, 0.14, 0.28, 0.42];
      const tones = [5, 6, 7, 8];
      for (let i = 0; i < notes.length; i++) if (this.t >= notes[i] && this.t - dt < notes[i]) this.audio.survivorNote(TONES[tones[i]] , 0.2, 0.2, this.pan(listener));
      if (this.t > 3.1) {
        c.releaseScript(0.3);
        this.state = 'with';
        this.t = 0;
        this.sung = false;
      }
      return;
    }

    c.tired = Math.max(c.tired, 0.3);
    this.input.move.set(0, 0);
    this.input.crouch = false;
    this.input.look = this.look.copy(listener).setY(listener.y + 1.1);
    const dl = Math.hypot(listener.x - c.pos.x, listener.z - c.pos.z);
    if (this.state === 'peeking') {
      // still afraid: low, slow, shaking, the head darting
      c.panic = 0.9;
      const st = this.steps[this.seg];
      this.input.crouch = st.crouch;
      const dx = st.to.x - c.pos.x;
      const dz = st.to.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.18 && this.waited === 0) {
        const s = Math.min(st.flinch ? 0.9 : 0.32, d * 0.9);
        this.input.move.set((dx / d) * s, (-dz / d) * s);
        if (st.flinch && d > 0.5 && this.t > 0.05) {
          // it starts back with a gasp
          this.audio.specimenVoice('gasp', 0.14, this.pan(listener));
          this.t = -99;
        }
      } else {
        this.waited += dt;
        if (this.waited >= st.wait) {
          this.waited = 0;
          this.t = 0;
          if (this.seg < this.steps.length - 1) this.seg++;
          else this.state = 'watching';
        }
      }
    } else if (this.state === 'watching') {
      // out, wary, eyes on the creature until it comes near enough to see who it is
      c.panic = 0.6;
      if (dl < 6.5) {
        this.state = 'excited';
        this.t = 0;
        c.releaseScript();
        blendPose(this.pose, WARY, WARY, 0);
        return;
      }
    } else if (this.state === 'with') {
      // calm now, and it keeps close: it follows the creature about, never too near
      c.panic = Math.max(0, c.panic - dt * 0.4);
      if (dl > 3.2) {
        const s = Math.min(dl > 6 ? 0.9 : 0.5, (dl - 2.2) * 0.4);
        this.input.move.set(((listener.x - c.pos.x) / dl) * s, (-(listener.z - c.pos.z) / dl) * s);
      }
    }
    c.update(dt, this.input, this.world);
    // once it is with the creature, it sings the song from the wall, softly
    if (this.state === 'with' && !this.sung && this.t > 0.6) {
      this.sung = true;
      this.t = 0;
      this.singAt = 0;
    }
    if (this.state === 'with' && this.sung && this.singAt < WALL_SONG.length) {
      let at = 0;
      for (let i = 0; i < this.singAt; i++) at += WALL_SONG[i][1] * BEAT * 1.4;
      if (this.t >= at) {
        const [tone, beats] = WALL_SONG[this.singAt];
        this.audio.survivorNote(TONES[tone], beats * BEAT * 1.4, 0.2, this.pan(listener));
        this.singAt++;
      }
    }
  }
  private singAt = 0;

  /** Answered with the song: once its knocks are done, the bolts, the door, and out. */
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
