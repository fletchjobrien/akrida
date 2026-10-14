import { clamp, lerp, rng } from '../core/math';
import { SONG_TONES, TONES, TUNE } from '../story/tune';

/**
 * A voice for the dying stranger, synthesised sample by sample: a glottal
 * pulse source (with jitter, shimmer and period doubling for a rasp) through
 * a cascade of formant resonators, plus fluid gurgling in the throat and
 * bursts of electrical static.
 */

/** Two-pole resonator with unity gain at DC (Klatt 1980). */
class Reson {
  private a = 1;
  private b = 0;
  private c = 0;
  private y1 = 0;
  private y2 = 0;
  set(f: number, bw: number, sr: number) {
    const r = Math.exp((-Math.PI * bw) / sr);
    this.c = -r * r;
    this.b = 2 * r * Math.cos((2 * Math.PI * f) / sr);
    this.a = 1 - this.b - this.c;
  }
  tick(x: number) {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Rosenberg glottal flow over one period (phase 0..1): opening, closing, closed. */
function glottalFlow(ph: number, open = 0.42, close = 0.16) {
  if (ph < open) return 0.5 * (1 - Math.cos((Math.PI * ph) / open));
  if (ph < open + close) return Math.cos((Math.PI * (ph - open)) / (2 * close));
  return 0;
}

interface VoiceFrame {
  /** Fundamental (Hz), 0 for none. */
  f0: number;
  /** Voiced loudness. */
  voice: number;
  /** Breath noise loudness (aspiration). */
  breath: number;
  f1: number;
  f2: number;
  f3: number;
  /** 0..1, wet bubbling in the throat. */
  gurgle: number;
  /** 0..1, chance of static bursts. */
  stat: number;
  /** 0..1, period doubling (a rough, split voice). */
  rasp: number;
  /** Pitch irregularity, fraction of a period. */
  jitter: number;
}

/**
 * Render a voice from a function giving the frame at time t (seconds).
 * Returns mono samples, peak-normalised to `peak`.
 */
function render(sr: number, seconds: number, seed: number, frame: (t: number) => VoiceFrame, peak: number) {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const r = rng(seed);
  const F1 = new Reson();
  const F2 = new Reson();
  const F3 = new Reson();
  const nasal = new Reson();
  let ph = 0;
  let periodF0 = 0;
  let periodAmp = 1;
  let odd = false;
  let prevFlow = 0;
  let lpNoise = 0;
  // bubbling: a slow random level, re-drawn at a random rate
  let bub = 0;
  let bubTarget = 0;
  let bubTimer = 0;
  // bubble pops: short rising chirps
  let popT = -1;
  let popF = 0;
  let popAmp = 0;
  // static: a telegraph process that switches bursts on and off, and a sample-and-hold crusher
  let statOn = false;
  let statTimer = 0;
  let hold = 0;
  let holdN = 0;
  let holdK = 6;
  let peakSeen = 1e-9;
  let fr = frame(0);
  for (let i = 0; i < n; i++) {
    // the voice's controls change slowly: sample them every 16 samples (3 kHz)
    if ((i & 15) === 0) fr = frame(i / sr);

    // new glottal period: draw its jittered pitch and shimmered loudness
    if (ph >= 1 || periodF0 === 0) {
      ph -= Math.floor(ph);
      periodF0 = fr.f0 * (1 + (r() - 0.5) * 2 * fr.jitter);
      periodAmp = 1 + (r() - 0.5) * 0.5 * (fr.jitter * 6);
      odd = !odd;
    }
    let src = 0;
    if (fr.f0 > 0) {
      ph += periodF0 / sr;
      const flow = glottalFlow(ph % 1) * periodAmp * (odd ? 1 - fr.rasp * 0.6 : 1);
      // radiation at the lips: the derivative of the flow
      // (scaled so a voice of 1 peaks near 1 at any pitch)
      src = ((flow - prevFlow) * sr * fr.voice) / Math.max(30, periodF0 * 3.7);
      prevFlow = flow;
      // breath noise is louder while the glottis is open
      const w = r() * 2 - 1;
      src += w * fr.breath * (0.35 + 0.65 * flow);
    } else {
      src = (r() * 2 - 1) * fr.breath;
    }

    // fluid in the throat: it shifts the low resonance and chops the sound
    bubTimer -= 1;
    if (bubTimer <= 0) {
      bubTarget = r();
      bubTimer = sr * (0.012 + r() * 0.035);
      if (fr.gurgle > 0.2 && r() < fr.gurgle * 0.22 && popT < 0) {
        popT = 0;
        popF = 260 + r() * 520;
        popAmp = 0.25 + r() * 0.5;
      }
    }
    bub += (bubTarget - bub) * 0.004;
    const am = 1 - fr.gurgle * 0.85 * Math.pow(bub, 1.5);

    // the resonances drift slowly: retune them every 16 samples, not every sample
    if ((i & 15) === 0) {
      F1.set(fr.f1 + fr.gurgle * 180 * (bub - 0.5), 90 + fr.gurgle * 120, sr);
      F2.set(fr.f2, 120, sr);
      F3.set(fr.f3, 180, sr);
      if (i === 0) nasal.set(260, 120, sr);
    }
    let y = F3.tick(F2.tick(F1.tick(src)));
    y = y * 0.85 + nasal.tick(src) * 0.15;
    y *= am;

    if (popT >= 0) {
      const f = popF * (1 + popT * 60);
      y += Math.sin(2 * Math.PI * f * popT) * Math.exp(-popT / 0.01) * popAmp * fr.gurgle * 0.6;
      popT += 1 / sr;
      if (popT > 0.05) popT = -1;
    }

    // static: in bursts the voice is crushed to a few bits at a low rate and fizzes
    statTimer -= 1;
    if (statTimer <= 0) {
      statOn = !statOn && r() < fr.stat;
      statTimer = sr * (statOn ? 0.03 + r() * 0.12 : 0.06 + r() * 0.3);
      holdK = 4 + Math.floor(r() * 7);
    }
    if (statOn) {
      const q = peakSeen * 0.14;
      if (holdN-- <= 0) {
        hold = Math.round(y / q) * q;
        holdN = holdK;
      }
      lpNoise += (r() * 2 - 1 - lpNoise) * 0.6;
      const crackle = r() < 0.004 ? (r() * 2 - 1) * 1.5 : 0;
      y = hold * 0.8 + (lpNoise * 0.18 + crackle * 0.3) * peakSeen * fr.stat;
    }

    out[i] = y;
    peakSeen = Math.max(peakSeen, Math.abs(y));
  }
  const g = peak / peakSeen;
  // short fades so nothing clicks
  const fade = Math.floor(sr * 0.006);
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] *= g * e;
  }
  return out;
}

const env = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);
const bell = (t: number, a: number, m: number, b: number) => (t < m ? env(t, a, m) : 1 - env(t, m, b));

/** A wet, choked cough, then a pained moan that breaks into a creaking rattle. */
export function gargleSamples(sr: number, seed: number) {
  const r = rng(seed * 13 + 5);
  const pitch = 0.92 + r() * 0.16;
  const len = 2.5 + r() * 0.3;
  return render(
    sr,
    len,
    seed,
    (t) => {
      const cough = bell(t, 0, 0.03, 0.32);
      const moan = bell(t, 0.22, 0.45, len - 0.75) ** 0.8;
      const fry = bell(t, len - 1.25, len - 0.75, len - 0.05);
      const rise = env(t, 0.22, 0.65);
      const fall = env(t, 0.65, len - 0.8);
      const f0 = moan > 0.01 || fry > 0.01 ? pitch * lerp(lerp(150, 205, rise), lerp(205, 105, fall), fall > 0 ? 1 : 0) : 0;
      const creak = fry > moan ? lerp(105, 42, env(t, len - 1.1, len - 0.1)) * pitch : f0;
      return {
        f0: cough > 0.3 ? 210 : creak,
        voice: cough * 0.7 + moan * 1 + fry * 0.75,
        breath: cough * 0.9 + moan * 0.28 + fry * 0.2,
        f1: lerp(760, 540, fall),
        f2: lerp(1220, 980, fall),
        f3: 2500,
        gurgle: Math.max(cough, 0.55 + 0.35 * fall, fry),
        stat: 0.2 + 0.25 * fall,
        rasp: 0.35 + 0.4 * fry,
        jitter: 0.03 + 0.12 * fry + 0.04 * cough,
      };
    },
    0.8,
  );
}

/**
 * One note of the tune: a hummed, raspy tone that wavers and sags. A thin pure
 * tone rides under it, so the pitch is easy to tell even through the rasp.
 */
export function noteSamples(sr: number, freq: number, seed: number, seconds = 0.95) {
  const r = rng(seed * 7 + 3);
  // the breath catches in the middle of every note, so each comes out as two
  const brk = 0.44 + r() * 0.08;
  const gap = (u: number) => 1 - 0.98 * Math.min(1, 1.6 * bell(u, brk - 0.075, brk, brk + 0.065));
  const voice = render(
    sr,
    seconds,
    seed,
    (t) => {
      const u = t / seconds;
      const a = env(t, 0, 0.09) * (1 - env(t, seconds - 0.24, seconds)) * (1 - 0.25 * u);
      const vib = 1 + Math.sin(t * 2 * Math.PI * 5.2) * 0.006 * env(t, 0.2, 0.6);
      const sag = 1 - 0.02 * env(t, seconds - 0.3, seconds);
      const broken = gap(u);
      return {
        f0: freq * vib * sag,
        voice: a * broken,
        breath: a * 2.2 * (0.3 + 0.7 * broken),
        // the mouth opens up for the high notes, so they still ring
        f1: Math.max(360, freq * 1.15),
        f2: Math.max(860, freq * 2.3),
        f3: Math.max(2350, freq * 3.6),
        gurgle: 0.22,
        stat: 0.14,
        rasp: 0.45,
        jitter: 0.008,
      };
    },
    0.62,
  );
  // the pure tone underneath, flickering with the voice
  for (let i = 0; i < voice.length; i++) {
    const t = i / sr;
    const a = env(t, 0.02, 0.12) * (1 - env(t, seconds - 0.28, seconds - 0.02));
    const vib = Math.sin(t * 2 * Math.PI * 5.2) * 0.006 * env(t, 0.2, 0.6);
    voice[i] += Math.sin(2 * Math.PI * freq * t * (1 + vib)) * 0.3 * a * gap(t / seconds);
  }
  return voice;
}

/**
 * The keypad's voice for a tone: the same hummed sound the stranger makes, but
 * clean and steady (no rasp, no gurgle), over a pure electronic tone and a
 * bright blip as it starts. It is meant to be matched by ear with the
 * stranger's notes.
 */
export function padSamples(sr: number, freq: number, double = false) {
  // the stranger's tones come out as two hums, like its broken notes; the rest as one
  const seconds = double ? 1.15 : 1.0;
  const release = double ? 0.75 : seconds * 0.55;
  const brk = 0.45;
  const gap = (t: number) => (double ? 1 - Math.min(1, 1.7 * bell(t, brk - 0.09, brk, brk + 0.06)) : 1);
  const voice = render(
    sr,
    seconds,
    11,
    (t) => {
      const a = env(t, 0, 0.04) * (1 - env(t, release, seconds)) * gap(t);
      const vib = 1 + Math.sin(t * 2 * Math.PI * 5.5) * 0.005 * env(t, 0.15, 0.4);
      return {
        f0: freq * vib,
        voice: a,
        breath: a * 0.25,
        f1: Math.max(380, freq * 1.15),
        f2: Math.max(900, freq * 2.3),
        f3: Math.max(2400, freq * 3.6),
        gurgle: 0,
        stat: 0,
        rasp: 0.05,
        jitter: 0.002,
      };
    },
    0.45,
  );
  for (let i = 0; i < voice.length; i++) {
    const t = i / sr;
    const a = env(t, 0, 0.01) * (1 - env(t, release - 0.05, seconds)) * gap(t);
    const vib = Math.sin(t * 2 * Math.PI * 5.5) * 0.005 * env(t, 0.15, 0.4);
    // a bright click at the start of each hum
    const blip = Math.exp(-t / 0.03) + (double && t > brk ? Math.exp(-(t - brk - 0.02) / 0.03) * (t > brk + 0.02 ? 1 : 0) : 0);
    voice[i] +=
      Math.sin(2 * Math.PI * freq * t * (1 + vib)) * 0.4 * a +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.18 * blip +
      Math.sin(2 * Math.PI * freq * 4 * t) * 0.06 * blip;
  }
  return voice;
}

/** A dying breath: a rattling inhale, or a weak exhale that sometimes carries a moan. */
export function breathSamples(sr: number, seed: number, inhale: boolean) {
  const r = rng(seed * 17 + 11);
  const len = inhale ? 0.55 + r() * 0.25 : 0.8 + r() * 0.4;
  const moan = !inhale && r() < 0.45;
  const f0 = 95 + r() * 30;
  return render(
    sr,
    len,
    seed,
    (t) => {
      const a = inhale ? env(t, 0, len * 0.65) * (1 - env(t, len * 0.8, len)) : env(t, 0, 0.06) * (1 - env(t, 0.1, len));
      return {
        f0: moan ? f0 * (1 - 0.2 * t) : inhale ? 55 : 0,
        voice: moan ? a * 0.35 : inhale ? a * 0.18 : 0,
        breath: a * (inhale ? 0.9 : 0.6),
        f1: inhale ? 620 : 480,
        f2: inhale ? 1550 : 1100,
        f3: 2600,
        gurgle: inhale ? 0.85 : 0.5,
        stat: 0.12,
        rasp: 0.5,
        jitter: 0.1,
      };
    },
    inhale ? 0.5 : 0.35,
  );
}

/**
 * A tone of one of the tracker's songs: the same voice as the stranger's, but
 * whole and clear, a long, open hum with a slow vibrato that blooms as it is
 * held, a pure tone under it, and a faint second voice a hair above, so it
 * shimmers like something carried a long way.
 */
export function songSamples(sr: number, freq: number) {
  const seconds = 1.6;
  const voice = render(
    sr,
    seconds,
    23,
    (t) => {
      const a = env(t, 0, 0.12) * (1 - env(t, seconds - 0.7, seconds));
      const vib = 1 + Math.sin(t * 2 * Math.PI * 4.8) * 0.007 * env(t, 0.25, 0.8);
      return {
        f0: freq * vib,
        voice: a,
        breath: a * 0.35,
        f1: Math.max(330, freq * 1.05),
        f2: Math.max(800, freq * 2.1),
        f3: Math.max(2300, freq * 3.4),
        gurgle: 0,
        stat: 0,
        rasp: 0.03,
        jitter: 0.002,
      };
    },
    0.4,
  );
  for (let i = 0; i < voice.length; i++) {
    const t = i / sr;
    const a = env(t, 0, 0.1) * (1 - env(t, seconds - 0.75, seconds - 0.02));
    const vib = Math.sin(t * 2 * Math.PI * 4.8) * 0.007 * env(t, 0.25, 0.8);
    voice[i] +=
      Math.sin(2 * Math.PI * freq * t * (1 + vib)) * 0.34 * a +
      Math.sin(2 * Math.PI * freq * 1.004 * t * (1 + vib)) * 0.14 * a +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.05 * a * env(t, 0.2, 0.6);
  }
  return voice;
}

/** Every voice buffer the game uses (mono samples at `sr`). */
export interface Voices {
  gargles: Float32Array[];
  inhales: Float32Array[];
  exhales: Float32Array[];
  /** Two takes of each tone the stranger sings, by TONES index. */
  notes: Float32Array[][];
  /** The keypad's tone for each TONES index. */
  pads: Float32Array[];
  /** The tracker's song voice for each SONG_TONES index. */
  songs: Float32Array[];
}

/** Build them all (half a second or more: run it in a worker, see voiceWorker.ts). */
export function buildVoices(sr: number): Voices {
  return {
    gargles: [0, 1, 2].map((i) => gargleSamples(sr, 300 + i)),
    inhales: [0, 1, 2, 3].map((i) => breathSamples(sr, 400 + i, true)),
    exhales: [0, 1, 2, 3, 4].map((i) => breathSamples(sr, 500 + i, false)),
    notes: TONES.map((f, k) => [0, 1].map((v) => noteSamples(sr, f, 600 + k * 10 + v))),
    pads: TONES.map((f, k) => padSamples(sr, f, (TUNE as readonly number[]).includes(k))),
    songs: SONG_TONES.map((f) => songSamples(sr, f)),
  };
}

/**
 * The same, a piece at a time between frames, for when a worker cannot be
 * started. Calls `done` when finished.
 */
export function buildVoicesSliced(sr: number, done: (v: Voices) => void) {
  const v: Voices = { gargles: [], inhales: [], exhales: [], notes: TONES.map(() => []), pads: [], songs: [] };
  const jobs: (() => void)[] = [
    ...[0, 1, 2].map((i) => () => v.gargles.push(gargleSamples(sr, 300 + i))),
    ...[0, 1, 2, 3].map((i) => () => v.inhales.push(breathSamples(sr, 400 + i, true))),
    ...[0, 1, 2, 3, 4].map((i) => () => v.exhales.push(breathSamples(sr, 500 + i, false))),
    ...TONES.flatMap((f, k) => [0, 1].map((n) => () => v.notes[k].push(noteSamples(sr, f, 600 + k * 10 + n)))),
    ...TONES.map((f, k) => () => v.pads.push(padSamples(sr, f, (TUNE as readonly number[]).includes(k)))),
    ...SONG_TONES.map((f) => () => v.songs.push(songSamples(sr, f))),
  ];
  const step = () => {
    const job = jobs.shift();
    if (!job) return done(v);
    job();
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
