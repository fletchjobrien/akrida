import { clamp, lerp, noise1, rng } from '../core/math';
import type { StaminaCue, StepEvent } from '../character/Creature';
import type { Wind } from '../world/wind';
import { buildVoicesSliced, type Voices } from './voice';
import { SONG_TONES, TONES } from '../story/tune';

/**
 * All sound is synthesised at start-up with the Web Audio API: no samples.
 * Wind is several layers of shaped noise; footsteps are granular bursts of
 * filtered noise with a soft hoof thud underneath.
 */

type Buf = AudioBuffer;

function noiseBuffer(ctx: BaseAudioContext, seconds: number, color: 'white' | 'pink' | 'brown', seed: number): Buf {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(seed * 31 + ch * 7 + 1);
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = r() * 2 - 1;
      if (color === 'white') d[i] = w;
      else if (color === 'pink') {
        // Paul Kellet's refined pink noise filter
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    // crossfade the loop seam
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
  }
  return buf;
}

/** A single hoof-in-sand impact: crunchy grains plus a soft thud. */
function stepBuffer(ctx: BaseAudioContext, seed: number, heavy: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 0.32;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 977 + 3);

  // grains: a burst of tiny noise clicks, dense at first then thinning out
  const grains: { start: number; len: number; amp: number; decay: number }[] = [];
  let t = r() * 0.004;
  while (t < dur * 0.8) {
    const density = 2200 * Math.exp(-t / (0.035 + heavy * 0.02)) + 60;
    t += -Math.log(1 - r() * 0.999) / density;
    const env = Math.exp(-t / (0.05 + heavy * 0.015));
    grains.push({
      start: Math.floor(t * sr),
      len: Math.floor(sr * (0.0004 + r() * 0.0018)),
      amp: env * (0.3 + r() * r() * 0.9),
      decay: 0.3 + r() * 0.5,
    });
  }
  for (const g of grains) {
    for (let i = 0; i < g.len && g.start + i < len; i++) {
      const e = Math.exp((-i / g.len) * 4 * g.decay);
      d[g.start + i] += (r() * 2 - 1) * g.amp * e;
    }
  }
  // gentle band limiting so it reads as sand, not static
  let lp = 0;
  let hp = 0;
  let prev = 0;
  const lpA = 1 - Math.exp((-2 * Math.PI * (3000 + heavy * 500)) / sr);
  const hpA = Math.exp((-2 * Math.PI * 180) / sr);
  for (let i = 0; i < len; i++) {
    lp += (d[i] - lp) * lpA;
    hp = hpA * (hp + lp - prev);
    prev = lp;
    d[i] = hp;
  }
  // the thud of a hoof pressing into packed sand
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const ts = i / sr;
    const f = 52 + 70 * Math.exp(-ts / 0.03);
    phase += (2 * Math.PI * f) / sr;
    const env = (1 - Math.exp(-ts / 0.003)) * Math.exp(-ts / (0.035 + heavy * 0.02));
    d[i] += Math.sin(phase) * env * (0.45 + heavy * 0.1);
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const g = 0.9 / (peak || 1);
  for (let i = 0; i < len; i++) d[i] *= g;
  return buf;
}

/**
 * A hoof coming down on a steel deck plate, by modal synthesis: a hard
 * contact click drives a bank of damped, inharmonic plate modes (a dull
 * clank, not a bell), with the hollow thump of the space under the deck, a
 * couple of small rattles as the loose plate settles, and a little grit
 * crunched underfoot.
 */
function metalStepBuffer(ctx: BaseAudioContext, seed: number, heavy: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 0.42;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 4513 + 11);
  // the excitation: the hoof's hard contact, then the plate rattling back down on its frame
  const ex = new Float32Array(len);
  const hit = (at: number, amp: number, width: number) => {
    const i0 = Math.floor(at * sr);
    const w = Math.max(2, Math.floor(width * sr));
    for (let i = 0; i < w && i0 + i < len; i++) ex[i0 + i] += Math.sin((Math.PI * i) / w) * amp;
    // a short burst of noise with it: the hoof's edge skidding a hair on the plate
    const n = Math.floor(sr * (0.004 + heavy * 0.002));
    for (let i = 0; i < n && i0 + i < len; i++) ex[i0 + i] += (r() * 2 - 1) * amp * 0.5 * Math.exp((-i / n) * 4);
  };
  hit(0.002, 1, 0.0012 + heavy * 0.0008);
  const rattles = 1 + Math.floor(r() * 3);
  for (let k = 0; k < rattles; k++) hit(0.016 + r() * 0.03 + k * 0.012, 0.12 + r() * 0.18, 0.0006);
  // the plate's modes, crowded and out of tune with one another, the high ones dying fast
  const f0 = 170 + r() * 90 - heavy * 25;
  const modes = 22;
  const out = new Float32Array(len);
  for (let k = 0; k < modes; k++) {
    const f = f0 * Math.pow(1 + k * 0.72 + r() * 0.45, 1.28);
    if (f > sr * 0.45) break;
    const tau = (0.07 + heavy * 0.025) * Math.pow(f0 / f, 0.55) * (0.6 + r() * 0.8) + 0.006;
    const amp = (0.6 + r() * 0.8) / (1 + k * 0.28);
    const rr = Math.exp(-1 / (tau * sr));
    const c = 2 * rr * Math.cos((2 * Math.PI * f) / sr);
    const r2 = rr * rr;
    let y1 = 0;
    let y2 = 0;
    const norm = 1 - rr;
    for (let i = 0; i < len; i++) {
      const y = c * y1 - r2 * y2 + ex[i] * norm;
      y2 = y1;
      y1 = y;
      out[i] += y * amp;
    }
  }
  // the hollow under the deck: a low, quick boom
  {
    const f = 80 + r() * 35;
    const rr = Math.exp(-1 / ((0.035 + heavy * 0.015) * sr));
    const c = 2 * rr * Math.cos((2 * Math.PI * f) / sr);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < len; i++) {
      const y = c * y1 - rr * rr * y2 + ex[i] * (1 - rr);
      y2 = y1;
      y1 = y;
      out[i] += y * (2.2 + heavy);
    }
  }
  // grit crunched between hoof and plate
  for (let t = 0.002; t < 0.035; t += 0.0015 + r() * 0.004) {
    const i0 = Math.floor(t * sr);
    const n = Math.floor(sr * 0.0004);
    const a = 0.05 * Math.exp(-t / 0.015) * r();
    for (let i = 0; i < n && i0 + i < len; i++) out[i0 + i] += (r() * 2 - 1) * a;
  }
  // a gentle top cut, a fade at the end, and level
  let lp = 0;
  const lpA = 1 - Math.exp((-2 * Math.PI * 6500) / sr);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    lp += (out[i] - lp) * lpA;
    const fade = i > len - sr * 0.05 ? (len - i) / (sr * 0.05) : 1;
    d[i] = lp * fade;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  const g = 0.9 / (peak || 1);
  for (let i = 0; i < len; i++) d[i] *= g;
  return buf;
}

/** Sand sprayed by a running hoof: a short hiss with a scattered tail. */
function sprayBuffer(ctx: BaseAudioContext, seed: number): Buf {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.45);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 131 + 9);
  let hp = 0;
  let prev = 0;
  const hpA = Math.exp((-2 * Math.PI * 1400) / sr);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = (1 - Math.exp(-t / 0.01)) * Math.exp(-t / 0.09);
    const grain = r() < 0.25 ? 1 : 0.25;
    const x = (r() * 2 - 1) * env * grain;
    hp = hpA * (hp + x - prev);
    prev = x;
    d[i] = hp;
  }
  return buf;
}

/**
 * A breathy gasp with a thin wheeze in it: noise through a broad formant
 * that opens up ("hhh-aah"), plus a narrow whistling resonance.
 */
function gaspBuffer(ctx: BaseAudioContext, seed: number, deep: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 0.42 + deep * 0.38;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 733 + 5);
  const breathy = new Float32Array(len);
  const whistle = new Float32Array(len);
  // Chamberlin state-variable band-pass filters
  let l1 = 0;
  let b1 = 0;
  let l2 = 0;
  let b2 = 0;
  const wheezeHz = 1450 + r() * 450;
  const vibHz = 5 + r() * 3;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const u = t / dur;
    const n = r() * 2 - 1;
    const fc1 = 600 + 1200 * Math.min(1, u * 1.7);
    const f1 = 2 * Math.sin((Math.PI * fc1) / sr);
    l1 += f1 * b1;
    b1 += f1 * (n - l1 - 0.9 * b1);
    breathy[i] = b1;
    const fc2 = wheezeHz * (1 + 0.2 * u) + 70 * Math.sin(2 * Math.PI * vibHz * t);
    const f2 = 2 * Math.sin((Math.PI * fc2) / sr);
    l2 += f2 * b2;
    b2 += f2 * (n - l2 - 0.05 * b2);
    whistle[i] = b2;
  }
  const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const pb = peak(breathy);
  const pw = peak(whistle);
  const wheezeMix = 0.3 - deep * 0.16;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const u = t / dur;
    // sharp intake, ragged hold, quick fade
    const attack = 1 - Math.exp(-t / (0.02 + deep * 0.03));
    const release = u < 0.62 ? 1 : Math.exp(-(u - 0.62) / 0.11);
    const rag = 0.8 + 0.2 * Math.sin(2 * Math.PI * 23 * t + seed);
    d[i] = attack * release * rag * ((breathy[i] / pb) * (1 - wheezeMix) + (whistle[i] / pw) * wheezeMix);
  }
  // the catch of the throat at the very start
  const click = Math.floor(sr * 0.01);
  for (let i = 0; i < click && i < len; i++) d[i] += (r() * 2 - 1) * (1 - i / click) * 0.5;
  const g = 0.9 / peak(d);
  for (let i = 0; i < len; i++) d[i] *= g;
  return buf;
}

/** One heartbeat, "lub-dub": two low, soft thumps. */
function heartBuffer(ctx: BaseAudioContext): Buf {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.6);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const beat = (start: number, freq: number, amp: number) => {
    let phase = 0;
    for (let i = Math.floor(start * sr); i < len; i++) {
      const t = i / sr - start;
      const f = freq * (1 + 0.6 * Math.exp(-t / 0.02));
      phase += (2 * Math.PI * f) / sr;
      const env = (1 - Math.exp(-t / 0.006)) * Math.exp(-t / 0.07);
      d[i] += Math.sin(phase) * env * amp;
    }
  };
  beat(0, 48, 1);
  beat(0.17, 42, 0.7);
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;
  return buf;
}

/** Fine sand pouring off a body: a soft, dense trickle of grains. */
function pourBuffer(ctx: BaseAudioContext, seed: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 1.6;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 619 + 11);
  let t = 0;
  while (t < dur) {
    const u = t / dur;
    const density = 900 * Math.sin(Math.PI * Math.min(1, u * 1.3)) + 40;
    t += -Math.log(1 - r() * 0.999) / density;
    const start = Math.floor(t * sr);
    const glen = Math.floor(sr * (0.0003 + r() * 0.001));
    const amp = (0.2 + r() * r()) * Math.sin(Math.PI * Math.min(1, u * 1.15));
    for (let i = 0; i < glen && start + i < len; i++) d[start + i] += (r() * 2 - 1) * amp * Math.exp((-i / glen) * 3);
  }
  // keep the hiss soft: band-limit to roughly 500 Hz - 5 kHz
  let lp = 0;
  let hp = 0;
  let prev = 0;
  const lpA = 1 - Math.exp((-2 * Math.PI * 5000) / sr);
  const hpA = Math.exp((-2 * Math.PI * 500) / sr);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    lp += (d[i] - lp) * lpA;
    hp = hpA * (hp + lp - prev);
    prev = lp;
    d[i] = hp;
    peak = Math.max(peak, Math.abs(hp));
  }
  for (let i = 0; i < len; i++) d[i] *= 0.9 / (peak || 1);
  return buf;
}

/** Hot metal cooling: a tiny bright tick with a short metallic ring. */
function tickBuffer(ctx: BaseAudioContext, seed: number): Buf {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 0.08);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 37 + 3);
  const f1 = 2300 + r() * 2600;
  const f2 = f1 * (1.47 + r() * 0.2);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const click = i < sr * 0.0015 ? (r() * 2 - 1) * (1 - i / (sr * 0.0015)) : 0;
    d[i] = click * 0.8 + (Math.sin(2 * Math.PI * f1 * t) * 0.6 + Math.sin(2 * Math.PI * f2 * t) * 0.3) * Math.exp(-t / 0.012);
  }
  return buf;
}

/** Electrical sparks: sharp, sparse snaps over a fizz. */
function crackleBuffer(ctx: BaseAudioContext, seed: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 0.55;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 811 + 7);
  let t = 0;
  while (t < dur) {
    t += -Math.log(1 - r() * 0.999) / (180 * Math.exp(-t / 0.18) + 8);
    const start = Math.floor(t * sr);
    const glen = Math.floor(sr * (0.0002 + r() * 0.0012));
    const amp = (0.3 + r() * 0.7) * Math.exp(-t / 0.25);
    for (let i = 0; i < glen && start + i < len; i++) d[start + i] += (r() * 2 - 1) * amp;
  }
  let hp = 0;
  let prev = 0;
  const hpA = Math.exp((-2 * Math.PI * 1800) / sr);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const fizz = (r() * 2 - 1) * 0.06 * Math.exp(-(i / sr) / 0.15);
    const x = d[i] + fizz;
    hp = hpA * (hp + x - prev);
    prev = x;
    d[i] = hp;
    peak = Math.max(peak, Math.abs(hp));
  }
  for (let i = 0; i < len; i++) d[i] *= 0.9 / (peak || 1);
  return buf;
}

/** A hinge creaking: a stick-slip train of pulses ringing two resonances. */
function creakBuffer(ctx: BaseAudioContext, seed: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 0.7 + seed * 0.15;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 97 + 41);
  const src = new Float32Array(len);
  let next = 0;
  for (let i = 0; i < len; i++) {
    const u = i / len;
    if (i >= next) {
      src[i] = 0.6 + r() * 0.4;
      const rate = 35 + 55 * Math.sin(Math.PI * u) + (r() - 0.5) * 18;
      next = i + Math.floor(sr / rate);
    }
  }
  const res = (fc: number, q: number, g: number) => {
    let lo = 0;
    let band = 0;
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    for (let i = 0; i < len; i++) {
      lo += f * band;
      band += f * (src[i] - lo - q * band);
      d[i] += band * g;
    }
  };
  res(620 + r() * 120, 0.08, 1);
  res(1450 + r() * 300, 0.1, 0.6);
  res(3100 + r() * 400, 0.15, 0.25);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const u = i / len;
    d[i] *= Math.sin(Math.PI * Math.min(1, u * 1.2)) ** 0.7;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  for (let i = 0; i < len; i++) d[i] *= 0.9 / (peak || 1);
  return buf;
}

/** A hollow metal panel knocking against its frame: inharmonic partials. */
function clankBuffer(ctx: BaseAudioContext, seed: number): Buf {
  const sr = ctx.sampleRate;
  const dur = 1.3;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const r = rng(seed * 59 + 13);
  const base = 260 + r() * 120;
  const partials = [1, 2.32, 4.25, 6.63, 9.38].map((m, k) => ({
    f: base * m * (1 + (r() - 0.5) * 0.02),
    a: 1 / (1 + k * 0.9),
    tau: 0.5 / (1 + k * 0.7),
  }));
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let v = i < sr * 0.004 ? (r() * 2 - 1) * (1 - t / 0.004) * 0.7 : 0;
    for (const p of partials) v += Math.sin(2 * Math.PI * p.f * t) * p.a * Math.exp(-t / p.tau);
    d[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  for (let i = 0; i < len; i++) d[i] *= 0.9 / peak;
  return buf;
}

function impulseResponse(ctx: BaseAudioContext, seconds: number): Buf {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(500 + ch);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const a = 1 - Math.exp((-2 * Math.PI * lerp(5000, 900, t / seconds)) / sr);
      lp += (r() * 2 - 1 - lp) * a;
      d[i] = lp * Math.exp(-t / (seconds * 0.22)) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  return buf;
}

/** What a wreck hums with: a damaged power unit, or a failing light's buzz. */
export type SiteHum = 'power' | 'buzz' | 'fire' | 'vast';

interface SiteNodes {
  bus: GainNode;
  pan: StereoPannerNode;
  low: BiquadFilterNode;
  hum: GainNode;
  level: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverbSend!: GainNode;
  private steps: Buf[] = [];
  private heavySteps: Buf[] = [];
  private metalSteps: Buf[] = [];
  private heavyMetalSteps: Buf[] = [];
  private sprays: Buf[] = [];
  private gasps: Buf[] = [];
  private pours: Buf[] = [];
  private heart: Buf | null = null;
  // crash site
  private ticks: Buf[] = [];
  private crackles: Buf[] = [];
  private creaks: Buf[] = [];
  private clanks: Buf[] = [];
  /** One positional bus per wreck: what kind of hum it makes, and its nodes once sound has started. */
  private siteKinds: SiteHum[] = [];
  private sites: SiteNodes[] = [];
  private white: Buf | null = null;
  private out!: AudioNode;
  private muffle!: BiquadFilterNode;
  private deepGasps: Buf[] = [];
  private time = 0;
  /** Sound still to be built after start, a little each frame. */
  private jobs: (() => void)[] = [];
  private windReady = false;
  private sitesReady = false;
  private silence!: Buf;
  // the dying stranger
  private strangerBus: GainNode | null = null;
  private strangerPan!: StereoPannerNode;
  private strangerLow!: BiquadFilterNode;
  private gargles: Buf[] = [];
  private inhales: Buf[] = [];
  private exhales: Buf[] = [];
  private notes: Buf[][] = [];
  private padVoices: Buf[] = [];
  private songVoices: Buf[] = [];
  // the tracker: its own bus, the song it picks up when it points true, and radio static
  private tracker: {
    bus: GainNode;
    pan: StereoPannerNode;
    low: BiquadFilterNode;
    /** The song comes through here, louder the truer it points. */
    hot: GainNode;
    /** The static between stations. */
    fizz: GainNode | null;
  } | null = null;
  // the highlands: wind moaning through the rock, a thin whistle, and the hum at their heart
  private high: {
    bus: GainNode;
    moan: GainNode;
    whistle: GainNode;
    heart: GainNode;
    level: number;
  } | null = null;
  /** 0..1 multiplier on the surroundings (wind, the wreck), lowered for close moments. */
  private envLevel = 1;
  /** The world outside (wind, the highlands), muffled when the creature is indoors. */
  private outside!: BiquadFilterNode;
  private outsideGain!: GainNode;
  /** How far indoors the creature is (0..1), and the room's own sound once built. */
  private indoor = 0;
  private room: { bus: GainNode; buzz: GainNode; echo: GainNode } | null = null;
  /** The facility's great hall: its own ambience, and a long, dark reverb for what sounds in it. */
  private hall: {
    bus: GainNode;
    verb: GainNode;
    sand: GainNode;
    sandPan: StereoPannerNode;
    core: GainNode;
    corePan: StereoPannerNode;
    whine: GainNode;
    feed: GainNode;
  } | null = null;
  /** Which building the creature is in, for where the sounds in it echo: 0 the station, 1 the facility. */
  private indoorKind = 0;
  /** The drone's rotors: their level, pan, pitch, and the scream of the dive. */
  private drone: { bus: GainNode; pan: StereoPannerNode; oscs: OscillatorNode[]; base: number[]; wash: BiquadFilterNode; tone: BiquadFilterNode } | null = null;
  private ring: GainNode | null = null;

  private windGain!: GainNode;
  private whoosh!: BiquadFilterNode;
  private whooshGain!: GainNode;
  private whooshPan!: StereoPannerNode;
  private rumble!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private whistles: { filter: BiquadFilterNode; gain: GainNode; base: number; seed: number }[] = [];
  private hiss!: BiquadFilterNode;
  private hissGain!: GainNode;
  private hissPan!: StereoPannerNode;
  private breathFilter!: BiquadFilterNode;
  private breathGain!: GainNode;
  private wheezeFilter!: BiquadFilterNode;
  private wheezeGain!: GainNode;

  get running() {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.out = comp;

    // a low-pass on everything: closed while the creature comes to, then open
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.Q.value = 0.5;
    this.muffle.frequency.value = 20000;
    this.muffle.connect(comp);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(1.15, ctx.currentTime, 1.2);
    this.master.connect(this.muffle);

    // the outside world, dulled through walls when the creature is indoors
    this.outside = ctx.createBiquadFilter();
    this.outside.type = 'lowpass';
    this.outside.frequency.value = 20000;
    this.outsideGain = ctx.createGain();
    this.outside.connect(this.outsideGain).connect(this.master);

    const reverb = ctx.createConvolver();
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.18;
    this.reverbSend.connect(reverb);
    reverb.connect(this.master);

    // Only what the first moments need is made now. Everything else is built a little
    // at a time over the next frames (see pump), so starting the sound never stalls
    // the game; the voices are built in a worker (see buildStranger).
    this.silence = ctx.createBuffer(1, 1, ctx.sampleRate);
    this.heart = heartBuffer(ctx);
    this.buildStranger(ctx);
    const noise: Buf[] = [];
    this.jobs.push(
      () => noise.push(noiseBuffer(ctx, 7.3, 'white', 1)),
      () => noise.push(noiseBuffer(ctx, 9.1, 'pink', 2)),
      () => noise.push(noiseBuffer(ctx, 11.7, 'brown', 3)),
      () => this.buildWind(ctx, noise[0], noise[1], noise[2]),
      () => {
        this.buildBreath(ctx);
        this.windReady = true;
      },
      () => (reverb.buffer = impulseResponse(ctx, 2.4)),
      ...[0, 1, 2, 3].map((i) => () => this.gasps.push(gaspBuffer(ctx, i, 0))),
      ...[0, 1, 2].map((i) => () => this.deepGasps.push(gaspBuffer(ctx, 50 + i, 1))),
      ...Array.from({ length: 10 }, (_, i) => () => this.steps.push(stepBuffer(ctx, i, 0))),
      ...[0, 1, 2].map((i) => () => this.pours.push(pourBuffer(ctx, i))),
      ...Array.from({ length: 8 }, (_, i) => () => this.heavySteps.push(stepBuffer(ctx, 100 + i, 1))),
      ...Array.from({ length: 10 }, (_, i) => () => this.metalSteps.push(metalStepBuffer(ctx, i, 0))),
      ...Array.from({ length: 8 }, (_, i) => () => this.heavyMetalSteps.push(metalStepBuffer(ctx, 200 + i, 1))),
      ...Array.from({ length: 6 }, (_, i) => () => this.sprays.push(sprayBuffer(ctx, i))),
      ...Array.from({ length: 6 }, (_, i) => () => this.ticks.push(tickBuffer(ctx, i))),
      ...[0, 1, 2].map((i) => () => this.crackles.push(crackleBuffer(ctx, i))),
      ...[0, 1, 2].map((i) => () => this.creaks.push(creakBuffer(ctx, i))),
      ...[0, 1].map((i) => () => this.clanks.push(clankBuffer(ctx, i))),
      () => (this.white = noiseBuffer(ctx, 2.3, 'white', 9)),
      () => {
        this.sites = this.siteKinds.map((k) => this.buildSite(ctx, k));
        this.sitesReady = true;
      },
    );
    // keep building between frames too, so it finishes quickly whatever the frame rate
    const tick = () => {
      this.pump();
      if (this.jobs.length) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);

    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  private loop(ctx: AudioContext, buf: Buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buf.duration;
    src.start(ctx.currentTime, Math.random() * buf.duration);
    return src;
  }

  private buildWind(ctx: AudioContext, white: Buf, pink: Buf, brown: Buf) {
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 1;
    this.windGain.connect(this.outside);
    const windVerb = ctx.createGain();
    windVerb.gain.value = 0.35;
    this.windGain.connect(windVerb);
    windVerb.connect(this.reverbSend);

    // broad whoosh
    this.whoosh = ctx.createBiquadFilter();
    this.whoosh.type = 'bandpass';
    this.whoosh.Q.value = 0.55;
    this.whoosh.frequency.value = 500;
    this.whooshGain = ctx.createGain();
    this.whooshGain.gain.value = 0;
    this.whooshPan = ctx.createStereoPanner();
    this.loop(ctx, pink).connect(this.whoosh);
    this.whoosh.connect(this.whooshGain).connect(this.whooshPan).connect(this.windGain);

    // low body of the wind
    this.rumble = ctx.createBiquadFilter();
    this.rumble.type = 'lowpass';
    this.rumble.frequency.value = 160;
    this.rumble.Q.value = 0.3;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.loop(ctx, brown).connect(this.rumble);
    this.rumble.connect(this.rumbleGain).connect(this.windGain);

    // faint, eerie whistles where the wind catches the dune crests
    const whistleSrc = this.loop(ctx, white);
    const bases = [620, 930, 1370];
    bases.forEach((base, i) => {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 26 + i * 8;
      filter.frequency.value = base;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i - 1) * 0.6;
      whistleSrc.connect(filter);
      filter.connect(gain).connect(pan).connect(this.windGain);
      this.whistles.push({ filter, gain, base, seed: 40 + i * 3 });
    });

    // sand grains hissing across the ground
    this.hiss = ctx.createBiquadFilter();
    this.hiss.type = 'highpass';
    this.hiss.frequency.value = 3800;
    this.hiss.Q.value = 0.4;
    const hissShelf = ctx.createBiquadFilter();
    hissShelf.type = 'peaking';
    hissShelf.frequency.value = 7000;
    hissShelf.gain.value = 4;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissPan = ctx.createStereoPanner();
    this.loop(ctx, white).connect(this.hiss);
    this.hiss.connect(hissShelf).connect(this.hissGain).connect(this.hissPan).connect(this.windGain);
  }

  private buildBreath(ctx: AudioContext) {
    const pink = noiseBuffer(ctx, 3.1, 'pink', 9);
    this.breathFilter = ctx.createBiquadFilter();
    this.breathFilter.type = 'bandpass';
    this.breathFilter.frequency.value = 1100;
    this.breathFilter.Q.value = 1.4;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    const src = this.loop(ctx, pink);
    src.connect(this.breathFilter);
    this.breathFilter.connect(this.breathGain).connect(this.master);
    // a thin whistle in the breath when out of breath
    this.wheezeFilter = ctx.createBiquadFilter();
    this.wheezeFilter.type = 'bandpass';
    this.wheezeFilter.frequency.value = 1650;
    this.wheezeFilter.Q.value = 24;
    this.wheezeGain = ctx.createGain();
    this.wheezeGain.gain.value = 0;
    src.connect(this.wheezeFilter);
    this.wheezeFilter.connect(this.wheezeGain).connect(this.master);
  }

  /**
   * Coming to: the world fades in from silence through a muffled, closed-in
   * sound that opens up over `seconds`.
   */
  wakeUp(seconds: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(0.3, now + seconds * 0.25);
    g.linearRampToValueAtTime(1.15, now + seconds);
    const f = this.muffle.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(240, now);
    f.exponentialRampToValueAtTime(700, now + seconds * 0.3);
    f.exponentialRampToValueAtTime(3500, now + seconds * 0.7);
    f.exponentialRampToValueAtTime(20000, now + seconds);
  }

  /** One heartbeat, felt more than heard; bypasses the muffle. */
  heartbeat(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.heart) return;
    const src = ctx.createBufferSource();
    src.buffer = this.heart;
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(this.out);
    src.start();
  }

  /** Sand sliding off the body. */
  sandPour(level: number, rate = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.any(this.pours);
    src.playbackRate.value = rate * (0.9 + Math.random() * 0.2);
    const g = ctx.createGain();
    g.gain.value = level;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 0.4;
    src.connect(g).connect(pan).connect(this.master);
    g.connect(this.reverbSend);
    src.start();
  }

  /** A hand, knee or body pressing into the sand. */
  thud(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.any(this.steps);
    src.playbackRate.value = 0.7 + Math.random() * 0.15;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  /** A strained breath through clenched effort. */
  effort(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.any(this.deepGasps);
    src.playbackRate.value = 0.62 + Math.random() * 0.08;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1300;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  // ------------------------------------------------------------ crash site

  /** Register a wreck; returns its id for the site* calls. */
  addSite(hum: SiteHum): number {
    this.siteKinds.push(hum);
    if (this.ctx && this.sitesReady) this.sites.push(this.buildSite(this.ctx, hum));
    return this.siteKinds.length - 1;
  }

  private buildSite(ctx: AudioContext, kind: SiteHum): SiteNodes {
    // everything at a wreck goes through one bus that fades, pans and dulls with distance
    const bus = ctx.createGain();
    bus.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 800;
    bus.connect(pan).connect(low).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    low.connect(send).connect(this.reverbSend);

    const hum = ctx.createGain();
    hum.gain.value = 0;
    const filt = ctx.createBiquadFilter();
    if (kind === 'power') {
      // a damaged power unit hums and flutters
      filt.type = 'lowpass';
      filt.frequency.value = 340;
      for (const [f, type, g] of [
        [50, 'sawtooth', 0.5],
        [100.6, 'square', 0.12],
        [151, 'sine', 0.2],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(filt);
        o.start();
      }
    } else if (kind === 'fire') {
      // the ship burning: a low roar of flame with a deep failing drone under it
      filt.type = 'lowpass';
      filt.frequency.value = 520;
      filt.Q.value = 0.4;
      const roar = this.loop(ctx, noiseBuffer(ctx, 6.7, 'brown', 21));
      const rg = ctx.createGain();
      rg.gain.value = 3.2;
      roar.connect(rg).connect(filt);
      const flutter = ctx.createOscillator();
      flutter.frequency.value = 0.37;
      const fg = ctx.createGain();
      fg.gain.value = 160;
      flutter.connect(fg).connect(filt.frequency);
      flutter.start();
      for (const [f, g] of [
        [36.5, 0.5],
        [37.3, 0.4],
        [73.4, 0.12],
      ]) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(filt);
        o.start();
      }
    } else if (kind === 'vast') {
      // the wind through a great hollow structure: a deep moan in its halls that rises and
      // sinks, a thin whistle through its holes, and a dead-slow throb far underneath
      filt.type = 'lowpass';
      filt.frequency.value = 2400;
      const air = this.loop(ctx, noiseBuffer(ctx, 7.3, 'brown', 33));
      for (const [f, q, g, rate] of [
        [92, 9, 2.4, 0.07],
        [143, 11, 1.6, 0.05],
        [211, 12, 1.0, 0.09],
      ]) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = q;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const lg = ctx.createGain();
        lg.gain.value = f * 0.12;
        lfo.connect(lg).connect(bp.frequency);
        lfo.start();
        const sw = ctx.createGain();
        sw.gain.value = g;
        air.connect(bp).connect(sw).connect(filt);
      }
      if (this.white) {
        const hiss = this.loop(ctx, this.white);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1750;
        bp.Q.value = 28;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.13;
        const lg = ctx.createGain();
        lg.gain.value = 260;
        lfo.connect(lg).connect(bp.frequency);
        lfo.start();
        const wg = ctx.createGain();
        wg.gain.value = 0.35;
        const swell = ctx.createOscillator();
        swell.frequency.value = 0.07;
        const swg = ctx.createGain();
        swg.gain.value = 0.3;
        swell.connect(swg).connect(wg.gain);
        swell.start();
        hiss.connect(bp).connect(wg).connect(filt);
      }
      const throb = ctx.createOscillator();
      throb.frequency.value = 31;
      const tg = ctx.createGain();
      tg.gain.value = 0.25;
      const tl = ctx.createOscillator();
      tl.frequency.value = 0.4;
      const tlg = ctx.createGain();
      tlg.gain.value = 0.2;
      tl.connect(tlg).connect(tg.gain);
      tl.start();
      throb.connect(tg).connect(filt);
      throb.start();
    } else {
      // a failing light ballast: a thin, nasal mains buzz
      filt.type = 'bandpass';
      filt.frequency.value = 900;
      filt.Q.value = 0.7;
      for (const [f, type, g] of [
        [120, 'sawtooth', 0.45],
        [240.3, 'square', 0.2],
        [360, 'sawtooth', 0.12],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(filt);
        o.start();
      }
    }
    filt.connect(hum).connect(bus);
    return { bus, pan, low, hum, level: 0 };
  }

  /** Place the listener relative to wreck `i`: 0..1 loudness, -1..1 pan, 0..1 clarity, hum level. */
  setSite(i: number, level: number, pan: number, clarity: number, hum: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    n.level = level;
    n.bus.gain.setTargetAtTime(level * this.envLevel, now, 0.15);
    n.pan.pan.setTargetAtTime(pan, now, 0.15);
    n.low.frequency.setTargetAtTime(500 * Math.pow(30, clarity), now, 0.15);
    n.hum.gain.setTargetAtTime(hum * 0.05, now, this.siteKinds[i] === 'buzz' ? 0.01 : 0.08);
  }

  private playSite(i: number, buf: Buf, level: number, rate = 1) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(n.bus);
    src.start();
  }

  /** The emergency beacon: a thin, slightly broken electronic beep. */
  siteBeep(i: number, level: number, pitch = 1) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level, now + 0.006);
    g.gain.setTargetAtTime(0, now + 0.09, 0.02);
    g.connect(n.bus);
    for (const [f, a] of [
      [1975 * pitch, 1],
      [3950 * pitch, 0.25],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(f, now);
      o.frequency.linearRampToValueAtTime(f * 0.985, now + 0.12);
      const og = ctx.createGain();
      og.gain.value = a * 0.25;
      o.connect(og).connect(g);
      o.start(now);
      o.stop(now + 0.25);
    }
  }

  siteTick(i: number, level: number) {
    this.playSite(i, this.any(this.ticks), level, 0.85 + Math.random() * 0.3);
  }

  siteSpark(i: number, level: number) {
    this.playSite(i, this.any(this.crackles), level, 0.9 + Math.random() * 0.25);
  }

  siteCreak(i: number, level: number, rate: number) {
    this.playSite(i, this.any(this.creaks), level, rate);
  }

  siteClank(i: number, level: number) {
    this.playSite(i, this.any(this.clanks), level, 0.92 + Math.random() * 0.16);
  }

  /** A dying beacon half buried in the sand: a soft warble that sags in pitch. */
  siteWarble(i: number, level: number, pitch = 1) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level, now + 0.03);
    g.gain.setTargetAtTime(0, now + 0.22, 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.connect(g).connect(n.bus);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1180 * pitch, now);
    o.frequency.exponentialRampToValueAtTime(820 * pitch, now + 0.3);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 23;
    const lg = ctx.createGain();
    lg.gain.value = 40 * pitch;
    lfo.connect(lg).connect(o.frequency);
    o.connect(lp);
    o.start(now);
    lfo.start(now);
    o.stop(now + 0.6);
    lfo.stop(now + 0.6);
  }

  /** Coolant venting from a split line: a hiss that bursts, flutters and dies away. */
  siteHiss(i: number, level: number, seconds: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n || !this.white) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    const pk = ctx.createBiquadFilter();
    pk.type = 'peaking';
    pk.frequency.setValueAtTime(5200, now);
    pk.frequency.linearRampToValueAtTime(3600, now + seconds);
    pk.gain.value = 9;
    pk.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level, now + 0.04);
    // it sputters as the pressure drops
    for (let t = 0.15; t < seconds; t += 0.07 + Math.random() * 0.12) {
      g.gain.setTargetAtTime(level * (0.45 + Math.random() * 0.55) * (1 - (t / seconds) * 0.6), now + t, 0.03);
    }
    g.gain.setTargetAtTime(0.0001, now + seconds, 0.15);
    src.connect(hp).connect(pk).connect(g).connect(n.bus);
    src.start(now, Math.random() * 1.5);
    src.stop(now + seconds + 1);
  }

  /** An electric arc: a sharp crack with a short burst of buzz. */
  siteZap(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    this.playSite(i, this.any(this.crackles), level, 1.5 + Math.random() * 0.4);
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * 0.35, now);
    g.gain.setTargetAtTime(0, now + 0.05, 0.03);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 180 + Math.random() * 60;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    o.connect(bp).connect(g).connect(n.bus);
    o.start(now);
    o.stop(now + 0.25);
  }

  /** A deep groan of stressed hull plating, bending and settling. */
  shipGroan(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    const dur = 2.2 + Math.random() * 2;
    const f0 = 38 + Math.random() * 30;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(level, now + dur * 0.3);
    out.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    out.connect(n.bus);
    // metal resonances the groan drives
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(180 + Math.random() * 120, now);
    bp.frequency.linearRampToValueAtTime(120 + Math.random() * 60, now + dur);
    bp.Q.value = 6;
    bp.connect(out);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.connect(out);
    for (const [mul, g] of [
      [1, 0.6],
      [1.007, 0.5],
      [2.03, 0.25],
    ]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * mul, now);
      o.frequency.linearRampToValueAtTime(f0 * mul * (0.8 + Math.random() * 0.3), now + dur);
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(bp);
      og.connect(lp);
      o.start(now);
      o.stop(now + dur + 0.1);
    }
    // a scrape of grit and rivets
    if (this.white) {
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 900;
      hp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.value = 0.06;
      src.connect(hp).connect(g).connect(out);
      src.start(now, Math.random());
      src.stop(now + dur);
    }
  }

  /** Something inside the wreck goes up: a thump, a deep boom and a long rumble. */
  shipBoom(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n || !this.white) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(n.bus);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    out.connect(send).connect(this.reverbSend);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, now);
    o.frequency.exponentialRampToValueAtTime(28, now + 0.9);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 1.6);
    o.connect(og).connect(out);
    o.start(now);
    o.stop(now + 1.7);
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, now);
    lp.frequency.exponentialRampToValueAtTime(160, now + 2.2);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 2.6);
    src.connect(lp).connect(ng).connect(out);
    src.start(now, Math.random());
    src.stop(now + 2.7);
  }

  /**
   * A chime over a public-address system deep inside: three soft falling
   * notes through a tinny speaker, the last sagging out of tune, a crackle of
   * the speaker breaking up, and nothing after.
   */
  facilityChime(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 0.9;
    const out = ctx.createGain();
    out.gain.value = level;
    bp.connect(out).connect(n.bus);
    const send = ctx.createGain();
    send.gain.value = 1.2;
    out.connect(send).connect(this.reverbSend);
    [880, 698.46, 523.25].forEach((f, k) => {
      const t = now + k * 0.42;
      const sag = k === 2 ? 0.96 : 1;
      for (const [mul, type, g] of [
        [1, 'sine', 0.5],
        [2.01, 'triangle', 0.12],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(f * mul, t);
        o.frequency.linearRampToValueAtTime(f * mul * sag, t + 0.9);
        const gg = ctx.createGain();
        gg.gain.setValueAtTime(0.0001, t);
        gg.gain.exponentialRampToValueAtTime(g, t + 0.01);
        gg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        o.connect(gg).connect(bp);
        o.start(t);
        o.stop(t + 1.2);
      }
    });
    if (this.crackles.length) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(this.crackles);
      c.playbackRate.value = 0.7;
      const cg = ctx.createGain();
      cg.gain.value = 0.25;
      c.connect(cg).connect(bp);
      c.start(now + 1.1);
    }
  }

  /** A damaged servo jerking: a ragged whine that climbs and stutters, and a clunk as it stops. */
  dogServo(i: number, level: number, seconds: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180 + Math.random() * 60, now);
    o.frequency.exponentialRampToValueAtTime(620 + Math.random() * 300, now + seconds * 0.6);
    o.frequency.exponentialRampToValueAtTime(240, now + seconds);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1300;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 0.4, now + 0.03);
    // it stutters: the drive cutting in and out
    for (let t = 0.05; t < seconds; t += 0.04 + Math.random() * 0.07) g.gain.setValueAtTime(level * (Math.random() < 0.3 ? 0.03 : 0.4), now + t);
    g.gain.setTargetAtTime(0.0001, now + seconds, 0.03);
    o.connect(bp).connect(g).connect(n.bus);
    o.start(now);
    o.stop(now + seconds + 0.2);
    if (this.clanks.length) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(this.clanks);
      c.playbackRate.value = 1.6;
      const cg = ctx.createGain();
      cg.gain.value = level * 0.5;
      c.connect(cg).connect(n.bus);
      c.start(now + seconds);
    }
  }

  /** Its electronics failing: a few bright, broken digital chirps. */
  dogGlitch(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    let t = now;
    const count = 3 + Math.floor(Math.random() * 5);
    for (let k = 0; k < count; k++) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 900 + Math.random() * 2600;
      const g = ctx.createGain();
      const d = 0.015 + Math.random() * 0.05;
      g.gain.setValueAtTime(level * 0.12, t);
      g.gain.setValueAtTime(0, t + d);
      o.connect(g).connect(n.bus);
      o.start(t);
      o.stop(t + d + 0.01);
      t += d + Math.random() * 0.04;
    }
  }

  /**
   * A dead soldier's radio: a squelch, a burst of hiss through a narrow band
   * with a garbled voice in it that cannot be made out, and the squelch again.
   */
  radioStatic(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n || !this.white) return;
    const now = ctx.currentTime;
    const dur = 0.6 + Math.random() * 1.1;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 1.6;
    const out = ctx.createGain();
    out.gain.value = level;
    bp.connect(out).connect(n.bus);
    const click = (t: number) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 1400;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25, t);
      g.gain.setValueAtTime(0, t + 0.012);
      o.connect(g).connect(bp);
      o.start(t);
      o.stop(t + 0.02);
    };
    click(now);
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.22, now + 0.05);
    g.gain.setValueAtTime(0.22, now + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.04);
    src.connect(g).connect(bp);
    src.start(now, Math.random(), dur + 0.1);
    // a voice in it, too broken to understand
    const v = ctx.createOscillator();
    v.type = 'sawtooth';
    const vg = ctx.createGain();
    vg.gain.value = 0;
    let t = now + 0.08;
    while (t < now + dur - 0.1) {
      const seg = 0.06 + Math.random() * 0.14;
      v.frequency.setValueAtTime(110 + Math.random() * 90, t);
      vg.gain.setValueAtTime(Math.random() < 0.7 ? 0.12 : 0, t);
      t += seg;
    }
    vg.gain.setValueAtTime(0, t);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 900;
    f1.Q.value = 4;
    v.connect(f1).connect(vg).connect(bp);
    v.start(now);
    v.stop(now + dur + 0.1);
    click(now + dur + 0.05);
  }

  /** Coming upon the facility: a low, dissonant cluster swelling out of the wind, a cold metallic shimmer over it. */
  facilityReveal() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.16, now + 3.5);
    out.gain.setValueAtTime(0.16, now + 5.5);
    out.gain.linearRampToValueAtTime(0.0001, now + 12);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, now);
    lp.frequency.linearRampToValueAtTime(1100, now + 4);
    lp.frequency.linearRampToValueAtTime(300, now + 12);
    lp.connect(out).connect(this.master);
    out.connect(this.reverbSend);
    for (const [f, type, g] of [
      [55, 'triangle', 0.55],
      [58.27, 'sine', 0.4],
      [82.41, 'triangle', 0.3],
      [116.54, 'sine', 0.22],
      [164.81, 'sine', 0.12],
      [174.61, 'sine', 0.1],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(now);
      o.stop(now + 12.5);
    }
    // the shimmer: two high, beating tones like a struck girder ringing far off
    for (const [f, d] of [
      [1567.98, 0],
      [1574.5, 0.4],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, now + 1.5 + d);
      og.gain.exponentialRampToValueAtTime(0.025, now + 3 + d);
      og.gain.exponentialRampToValueAtTime(0.0001, now + 10);
      o.connect(og).connect(this.master);
      og.connect(this.reverbSend);
      o.start(now + 1.5 + d);
      o.stop(now + 10.5);
    }
  }

  /** The ship's alarm, still going somewhere inside: a muffled, failing two-tone klaxon. */
  shipAlarm(i: number, level: number) {
    const ctx = this.ctx;
    const n = this.sites[i];
    if (!ctx || !n) return;
    const now = ctx.currentTime;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = 0;
    bp.connect(g).connect(n.bus);
    const o = ctx.createOscillator();
    o.type = 'square';
    const sag = 0.96 + Math.random() * 0.04;
    for (let k = 0; k < 3; k++) {
      const t = now + k * 0.9;
      o.frequency.setValueAtTime(587 * sag, t);
      o.frequency.setValueAtTime(466 * sag, t + 0.42);
      g.gain.setTargetAtTime(level, t, 0.02);
      g.gain.setTargetAtTime(level * 0.8, t + 0.42, 0.02);
      g.gain.setTargetAtTime(0, t + 0.8, 0.03);
    }
    o.connect(bp);
    o.start(now);
    o.stop(now + 2.9);
  }

  // ------------------------------------------------------------ the keypad

  /** One keypad button: its tone (TONES[tone]) hummed in a clean version of the stranger's voice. */
  padTone(tone: number, level: number, pan = 0) {
    const ctx = this.ctx;
    const buf = this.padVoices[tone];
    if (!ctx || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = level;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.4;
    p.connect(send).connect(this.reverbSend);
    src.start();
    this.click(0.08);
  }

  /** A small mechanical click, for a button going down. */
  click(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.tickAt(level, 2.2);
  }

  private tickAt(level: number, rate: number) {
    const ctx = this.ctx;
    if (!ctx || !this.ticks.length) return;
    const src = ctx.createBufferSource();
    src.buffer = this.any(this.ticks);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(this.master);
    src.start();
  }

  /** The keypad rejects a sequence: a flat, falling double buzz. */
  padError(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let k = 0; k < 2; k++) {
      const t = now + k * 0.16;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(150, t);
      o.frequency.linearRampToValueAtTime(118, t + 0.12);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, t);
      g.gain.setTargetAtTime(0, t + 0.1, 0.02);
      o.connect(lp).connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.2);
    }
  }

  /** The keypad accepts: the three tones again, quick and bright, rising into a chord. */
  padAccept(tones: readonly number[], level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    tones.forEach((tone, k) => {
      const t = now + k * 0.09;
      const o = ctx.createOscillator();
      o.frequency.value = TONES[tone] * 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.01);
      g.gain.setTargetAtTime(0.0001, t + 0.6, 0.25);
      o.connect(g).connect(this.master);
      g.connect(this.reverbSend);
      o.start(t);
      o.stop(t + 2);
    });
  }

  /**
   * The door's lock lets go: a servo strains and dies, bolts clunk back, and the
   * seal breaks with a hiss of stale air.
   */
  doorCrack(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, now);
    o.frequency.linearRampToValueAtTime(340, now + 0.5);
    o.frequency.exponentialRampToValueAtTime(60, now + 1.1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 0.25, now + 0.1);
    g.gain.setTargetAtTime(0, now + 0.9, 0.08);
    o.connect(bp).connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 1.3);
    for (const t of [1.0, 1.12, 1.3]) {
      const src = ctx.createBufferSource();
      src.buffer = this.any(this.clanks);
      src.playbackRate.value = 0.7 + Math.random() * 0.15;
      const cg = ctx.createGain();
      cg.gain.value = level * 0.6;
      src.connect(cg).connect(this.master);
      cg.connect(this.reverbSend);
      src.start(now + t);
    }
    // the seal breaks
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, now + 1.35);
    hg.gain.exponentialRampToValueAtTime(level * 0.35, now + 1.4);
    hg.gain.setTargetAtTime(0.0001, now + 1.6, 0.35);
    src.connect(hp).connect(hg).connect(this.master);
    src.start(now + 1.3, Math.random());
    src.stop(now + 3.5);
  }

  /** Metal dragged against metal: the jammed door grinding along its track. */
  doorGrind(level: number, seconds: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, now);
    bp.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    // it moves in judders: stick, slip, stick
    for (let t = 0; t < seconds; t += 0.06 + Math.random() * 0.1) {
      g.gain.setTargetAtTime(level * (Math.random() < 0.35 ? 0.15 : 0.6 + Math.random() * 0.4), now + t, 0.015);
      bp.frequency.setTargetAtTime(500 + Math.random() * 700, now + t, 0.03);
    }
    g.gain.setTargetAtTime(0.0001, now + seconds, 0.05);
    src.connect(bp).connect(g).connect(this.master);
    // and a thin squeal riding over it
    const sq = ctx.createOscillator();
    sq.type = 'triangle';
    sq.frequency.setValueAtTime(1500 + Math.random() * 400, now);
    sq.frequency.linearRampToValueAtTime(1300 + Math.random() * 600, now + seconds);
    const sg = ctx.createGain();
    sg.gain.value = 0;
    for (let t = 0; t < seconds; t += 0.2 + Math.random() * 0.3) sg.gain.setTargetAtTime(Math.random() < 0.5 ? level * 0.08 : 0, now + t, 0.03);
    sg.gain.setTargetAtTime(0, now + seconds, 0.03);
    sq.connect(sg).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + seconds + 0.4);
    sq.start(now);
    sq.stop(now + seconds + 0.4);
  }

  /** The door gives all at once: a loud clang and a rumbling slide to its stop. */
  doorGive(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    for (const [t, r, l] of [
      [0, 0.6, 1],
      [0.42, 0.5, 0.8],
    ]) {
      const src = ctx.createBufferSource();
      src.buffer = this.any(this.clanks);
      src.playbackRate.value = r;
      const g = ctx.createGain();
      g.gain.value = level * l;
      src.connect(g).connect(this.master);
      g.connect(this.reverbSend);
      src.start(now + t);
    }
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * 0.5, now);
    g.gain.setTargetAtTime(0.0001, now + 0.35, 0.06);
    src.connect(lp).connect(g).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + 1);
  }

  /** A low swell when the wreck first comes into view. */
  // ----------------------------------------------------------------- tracker

  private trackerBus() {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this.tracker) {
      // the static needs the noise, which is built a little after the start
      if (!this.tracker.fizz && this.white) this.tracker.fizz = this.trackerFizz(ctx, this.white, this.tracker.bus);
      return this.tracker;
    }
    const bus = ctx.createGain();
    bus.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 6000;
    bus.connect(pan).connect(low).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.55;
    low.connect(send).connect(this.reverbSend);
    // pointing true: the song comes through, as from a radio, a little narrow and warm,
    // with a long soft echo
    const hot = ctx.createGain();
    hot.gain.value = 0;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.35;
    hot.connect(band).connect(bus);
    const echo = ctx.createGain();
    echo.gain.value = 0.9;
    band.connect(echo).connect(this.reverbSend);
    this.tracker = { bus, pan, low, hot, fizz: this.white ? this.trackerFizz(ctx, this.white, bus) : null };
    return this.tracker;
  }

  /**
   * Radio static between stations: hiss through a narrow band that surges and
   * fades as if the signal comes and goes, and a thin heterodyne whistle
   * wandering up and down under it.
   */
  private trackerFizz(ctx: AudioContext, white: Buf, bus: GainNode) {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(bus);
    const src = this.loop(ctx, white);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.8;
    const surge = ctx.createGain();
    surge.gain.value = 0.7;
    for (const [f, d] of [
      [0.37, 0.25],
      [1.9, 0.12],
      [7.3, 0.08],
    ]) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = f;
      const lg = ctx.createGain();
      lg.gain.value = d;
      lfo.connect(lg).connect(surge.gain);
      lfo.start();
    }
    src.connect(bp).connect(surge).connect(g);
    const whistle = ctx.createOscillator();
    whistle.frequency.value = 1500;
    const wl = ctx.createOscillator();
    wl.frequency.value = 0.11;
    const wg = ctx.createGain();
    wg.gain.value = 700;
    wl.connect(wg).connect(whistle.frequency);
    const wv = ctx.createGain();
    wv.gain.value = 0.05;
    whistle.connect(wv).connect(g);
    whistle.start();
    wl.start();
    return g;
  }

  /**
   * A burst of what is out there between stations: a crackle, and a voice
   * breaking through for a moment, too garbled to make out, then gone.
   */
  trackerGarble(level: number) {
    const ctx = this.ctx;
    const t = this.trackerBus();
    if (!ctx || !t || !t.fizz) return;
    const now = ctx.currentTime;
    if (this.crackles.length) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(this.crackles);
      c.playbackRate.value = 1.2 + Math.random() * 0.5;
      const cg = ctx.createGain();
      cg.gain.value = level * 0.6;
      c.connect(cg).connect(t.fizz);
      c.start(now);
    }
    const dur = 0.3 + Math.random() * 0.6;
    const v = ctx.createOscillator();
    v.type = 'sawtooth';
    const vg = ctx.createGain();
    vg.gain.value = 0;
    let at = now + 0.05;
    while (at < now + dur) {
      v.frequency.setValueAtTime(140 + Math.random() * 260, at);
      vg.gain.setValueAtTime(Math.random() < 0.7 ? level * 0.5 : 0, at);
      at += 0.04 + Math.random() * 0.1;
    }
    vg.gain.setValueAtTime(0, at);
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 800 + Math.random() * 900;
    f1.Q.value = 3;
    v.connect(f1).connect(vg).connect(t.fizz);
    v.start(now);
    v.stop(now + dur + 0.1);
  }

  /**
   * One note of the song the tracker picks up when it points true: tone
   * `tone` (SONG_TONES), held `seconds`, through its song channel (which is
   * only open as far as it points true). `clarity` (0..1) is how clean the
   * signal is: far from where it leads the note comes through broken, cutting
   * out, wavering in pitch, crushed and thin; near, it is clear.
   */
  trackerSong(tone: number, seconds: number, level: number, clarity = 1) {
    const ctx = this.ctx;
    const t = this.trackerBus();
    const buf = this.songVoices[tone];
    if (!ctx || !t || !buf) return;
    const now = ctx.currentTime;
    const bad = 1 - Math.max(0, Math.min(1, clarity));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // held notes are stretched a little slower, so they hang
    const hold = Math.max(seconds, 0.3);
    const rate = hold > 1.2 ? 0.995 : 1;
    src.playbackRate.setValueAtTime(rate, now);
    // the signal drifts: the pitch wavers as it fades in and out
    if (bad > 0.05) {
      let at = now + 0.05;
      while (at < now + hold + 0.6) {
        src.playbackRate.linearRampToValueAtTime(rate * (1 + (Math.random() - 0.5) * 0.05 * bad), at);
        at += 0.06 + Math.random() * 0.12;
      }
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, now);
    // it cuts out: short gaps, more and longer the worse the signal
    if (bad > 0.05) {
      let at = now + 0.08 + Math.random() * 0.15;
      while (at < now + hold) {
        const gap = 0.02 + Math.random() * 0.1 * bad;
        if (Math.random() < bad * 0.85) {
          g.gain.setValueAtTime(level * 0.04, at);
          g.gain.setValueAtTime(level, at + gap);
        }
        at += gap + 0.05 + Math.random() * 0.25 * (1.2 - bad);
      }
    }
    g.gain.setValueAtTime(level, now + Math.min(hold, 1.0));
    g.gain.setTargetAtTime(0.0001, now + Math.min(hold, 1.0), hold > 1.2 ? 0.5 : 0.18);
    // and it is thin and crushed, as from a cheap radio a long way off
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900 + 500 * bad;
    band.Q.value = 0.35 + 2.6 * bad;
    const dry = ctx.createGain();
    dry.gain.value = 1 - 0.7 * bad;
    const wet = ctx.createGain();
    wet.gain.value = 0.9 * bad;
    src.connect(g).connect(band);
    band.connect(dry).connect(t.hot);
    band.connect(this.crusher(ctx)).connect(wet).connect(t.hot);
    src.start(now);
    src.stop(now + 3);
  }

  private crushCurve: Float32Array<ArrayBuffer> | null = null;
  /** A waveshaper that rounds the signal to a few steps (bit crushing, the grit of a bad signal). */
  private crusher(ctx: AudioContext) {
    if (!this.crushCurve) {
      const n = 1024;
      const steps = 5;
      this.crushCurve = new Float32Array(n);
      for (let i = 0; i < n; i++) this.crushCurve[i] = Math.round(((i / (n - 1)) * 2 - 1) * steps) / steps;
    }
    const w = ctx.createWaveShaper();
    w.curve = this.crushCurve;
    return w;
  }

  /**
   * Place the tracker: 0..1 loudness, -1..1 pan, 0..1 clarity, how much it hums
   * (pointing true) and how much it hisses (searching).
   */
  setTracker(level: number, pan: number, clarity: number, hot: number, fizz: number) {
    const ctx = this.ctx;
    const t = this.trackerBus();
    if (!ctx || !t) return;
    const now = ctx.currentTime;
    t.bus.gain.setTargetAtTime(level, now, 0.12);
    t.pan.pan.setTargetAtTime(pan, now, 0.12);
    t.low.frequency.setTargetAtTime(700 * Math.pow(12, clarity), now, 0.12);
    t.hot.gain.setTargetAtTime(hot * 0.55, now, 0.25);
    t.fizz?.gain.setTargetAtTime(fizz * 0.03, now, 0.2);
  }

  /** A sine with an envelope into the tracker's bus (or `to`). */
  private trackerVoice(
    f0: number,
    f1: number,
    at: number,
    attack: number,
    hold: number,
    decay: number,
    level: number,
    type: OscillatorType = 'sine',
    to?: AudioNode,
  ) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(f1, at + attack + hold + decay * 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + attack);
    g.gain.setTargetAtTime(0.0001, at + attack + hold, decay / 3);
    o.connect(g).connect(to ?? this.tracker!.bus);
    o.start(at);
    o.stop(at + attack + hold + decay * 2 + 0.1);
  }

  /**
   * One slow throb while it searches: a deep, soft swell like a heartbeat
   * heard through a wall, with a faint glassy ring over it.
   */
  trackerPulse(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.trackerBus()) return;
    const now = ctx.currentTime;
    this.trackerVoice(104, 88, now, 0.28, 0.08, 0.9, level);
    this.trackerVoice(208, 176, now, 0.3, 0.05, 0.7, level * 0.35, 'triangle');
    this.trackerVoice(1567.98, 1561, now + 0.12, 0.2, 0.0, 1.4, level * 0.05);
  }

  /** It finds the way: two bright bell notes, rising. */
  trackerLock(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.trackerBus()) return;
    const now = ctx.currentTime;
    [783.99, 1174.66].forEach((f, k) => {
      const t = now + k * 0.085;
      this.trackerVoice(f, f, t, 0.03, 0.02, 0.9, level);
      this.trackerVoice(f * 2.76, f * 2.76, t, 0.02, 0.0, 0.25, level * 0.08);
    });
  }

  /** A new fix: a sharp, insistent electronic chirp, over and over until it is answered. */
  trackerBeep(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.trackerBus()) return;
    const now = ctx.currentTime;
    this.trackerVoice(2093, 2093, now, 0.004, 0.035, 0.05, level, 'square');
    this.trackerVoice(2637, 2637, now + 0.075, 0.004, 0.035, 0.05, level * 0.9, 'square');
  }

  /**
   * The dock singing a note of the song the tracker sang on its way here, out of
   * its own small speaker: clear, a little thin and boxy, in the room.
   */
  dockSong(tone: number, seconds: number, level: number) {
    const ctx = this.ctx;
    const buf = this.songVoices[tone];
    if (!ctx || !buf || level < 0.003) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hold = Math.max(seconds, 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, now);
    g.gain.setValueAtTime(level, now + Math.min(hold, 1.0));
    g.gain.setTargetAtTime(0.0001, now + Math.min(hold, 1.0), hold > 1.2 ? 0.45 : 0.16);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 260;
    const box = ctx.createBiquadFilter();
    box.type = 'peaking';
    box.frequency.value = 1400;
    box.gain.value = 5;
    box.Q.value = 1.2;
    src.connect(g).connect(hp).connect(box).connect(this.master);
    const r = this.roomBus();
    if (r) box.connect(r.echo);
    src.start(now);
    src.stop(now + 3);
  }


  // ------------------------------------------------------------------ the facility's hall

  /** Where something sounding indoors sends its echo: the station's little room, or the hall's long dark. */
  private roomSend(): AudioNode | null {
    if (this.indoor < 0.5) return null;
    if (this.indoorKind === 1) return this.hallBus()?.verb ?? null;
    return this.roomBus()?.echo ?? null;
  }

  private hallBus() {
    const ctx = this.ctx;
    if (!ctx || !this.white) return null;
    if (this.hall) return this.hall;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    // a long, dark reverb: the hall is huge, its walls hard, its far end lost in the dark
    const verb = ctx.createGain();
    verb.gain.value = 0.55;
    const conv = ctx.createConvolver();
    conv.buffer = impulseResponse(ctx, 4.2);
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2600;
    verb.connect(conv).connect(dark).connect(this.master);
    // the room tone: the deep moan of a great hollow space with the wind in it, rising and sinking
    {
      const air = this.loop(ctx, noiseBuffer(ctx, 8.3, 'brown', 61));
      for (const [f, q, g, rate] of [
        [48, 6, 2.2, 0.05],
        [76, 9, 1.4, 0.07],
        [118, 12, 0.7, 0.04],
      ]) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = q;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const lg = ctx.createGain();
        lg.gain.value = f * 0.1;
        lfo.connect(lg).connect(bp.frequency);
        lfo.start();
        const g2 = ctx.createGain();
        g2.gain.value = g * 0.06;
        air.connect(bp).connect(g2).connect(bus);
      }
      // the wind's thin keening through the hole in the roof, far up
      const hiss = this.loop(ctx, this.white);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1300;
      bp.Q.value = 22;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const lg = ctx.createGain();
      lg.gain.value = 240;
      lfo.connect(lg).connect(bp.frequency);
      lfo.start();
      const wg = ctx.createGain();
      wg.gain.value = 0.02;
      const sw = ctx.createOscillator();
      sw.frequency.value = 0.06;
      const swg = ctx.createGain();
      swg.gain.value = 0.016;
      sw.connect(swg).connect(wg.gain);
      sw.start();
      hiss.connect(bp).connect(wg).connect(bus);
      wg.connect(verb);
    }
    // sand pouring in through the hole: a soft, steady hiss with a grainy patter in it
    const sand = ctx.createGain();
    sand.gain.value = 0;
    const sandPan = ctx.createStereoPanner();
    {
      const pink = this.loop(ctx, noiseBuffer(ctx, 6.1, 'pink', 71));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;
      const grain = ctx.createGain();
      grain.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 23;
      const lg = ctx.createGain();
      lg.gain.value = 0.25;
      lfo.connect(lg).connect(grain.gain);
      lfo.start();
      pink.connect(hp).connect(lp).connect(grain).connect(sand);
      sand.connect(sandPan).connect(bus);
      sandPan.connect(verb);
    }
    // the gantry's heart, still lit: a deep, slow-beating chord in the Akridians' own low
    // tones, a shimmer over it that swells and fades like breath
    const core = ctx.createGain();
    core.gain.value = 0;
    const corePan = ctx.createStereoPanner();
    {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      for (const [f, g] of [
        [61.74, 0.5],
        [61.95, 0.4],
        [92.5, 0.28],
        [123.47, 0.2],
        [185.0, 0.08],
      ]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(lp);
        o.start();
      }
      const shim = ctx.createGain();
      shim.gain.value = 0;
      const breath = ctx.createOscillator();
      breath.frequency.value = 0.08;
      const bg = ctx.createGain();
      bg.gain.value = 0.035;
      breath.connect(bg).connect(shim.gain);
      breath.start();
      for (const f of [987.77, 989.6, 1479.98]) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(shim);
        o.start();
      }
      lp.connect(core);
      shim.connect(core);
      core.connect(corePan).connect(bus);
      corePan.connect(verb);
    }
    // the monitors in the security office: a thin high whine and the hum of their supply
    const whine = ctx.createGain();
    whine.gain.value = 0;
    for (const [f, g, type] of [
      [7812, 0.012, 'sine'],
      [60, 0.12, 'sawtooth'],
      [120, 0.05, 'square'],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      const lp = ctx.createBiquadFilter();
      lp.type = f > 1000 ? 'highpass' : 'lowpass';
      lp.frequency.value = f > 1000 ? 6000 : 400;
      o.connect(og).connect(lp).connect(whine);
      o.start();
    }
    whine.connect(bus);
    // watching a camera's feed: its own hiss and hum in the ear
    const feed = ctx.createGain();
    feed.gain.value = 0;
    {
      const src = this.loop(ctx, this.white);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3200;
      bp.Q.value = 0.6;
      const g2 = ctx.createGain();
      g2.gain.value = 0.05;
      src.connect(bp).connect(g2).connect(feed);
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 15.6;
      const og = ctx.createGain();
      og.gain.value = 0.02;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      o.connect(og).connect(lp).connect(feed);
      o.start();
      feed.connect(this.master);
    }
    this.hall = { bus, verb, sand, sandPan, core, corePan, whine, feed };
    return this.hall;
  }

  /**
   * Place the listener in the hall: how near (0..1) and which side (-1..1) the
   * falling sand and the gantry's heart are, and how near the monitors.
   */
  setHall(sand: number, sandPan: number, core: number, corePan: number, monitors: number) {
    const ctx = this.ctx;
    const h = this.hallBus();
    if (!ctx || !h) return;
    const now = ctx.currentTime;
    h.sand.gain.setTargetAtTime(sand * 0.12, now, 0.2);
    h.sandPan.pan.setTargetAtTime(sandPan, now, 0.2);
    h.core.gain.setTargetAtTime(core * 0.05, now, 0.3);
    h.corePan.pan.setTargetAtTime(corePan, now, 0.3);
    h.whine.gain.setTargetAtTime(monitors * 0.12, now, 0.2);
  }

  /** The hiss and hum of watching a camera's feed (0..1). */
  setFeed(level: number) {
    const ctx = this.ctx;
    const h = this.hallBus();
    if (!ctx || !h) return;
    h.feed.gain.setTargetAtTime(level, ctx.currentTime, 0.05);
  }

  /** Switching to another camera: a relay's click and a burst of snow. */
  feedSwitch(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    this.burst(now, 0.008, 3800, 2600, 4, 0.8, out);
    this.tone(now, 160, 0.05, 0.25, out, 'square');
    this.burst(now + 0.02, 0.32, 4200, 2600, 0.5, 0.45, out);
    this.tone(now + 0.03, 15625 / 2, 0.3, 0.02, out);
  }

  /**
   * A knock on a pipe: the knuckle's knock, and the pipe ringing on tone `f`
   * (Hz) with a metallic clang over it, ringing long down the hall. Heard from
   * the other side of a wall (`muffled`), it comes dull and faint.
   */
  pipeKnock(f: number, level: number, pan: number, muffled = false, big = 0.5) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.003) return;
    const now = ctx.currentTime + 0.005;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    let out: AudioNode = p;
    if (muffled) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 650;
      lp.Q.value = 0.8;
      p.connect(lp).connect(this.master);
      out = lp;
    } else p.connect(this.master);
    const send = this.roomSend();
    if (send) out.connect(send);
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(p);
    // the knuckle: a short dull knock
    this.burst(now, 0.035, 1400, 500, 1.2, 0.45, g);
    this.tone(now, 110 + Math.random() * 20, 0.06, 0.4, g);
    // the pipe: its tone and its overtones (harmonic, as its column rings), and the metal's
    // own inharmonic clang, dying fast; bigger pipes ring longer
    const ring = 0.7 + 0.9 * big;
    for (const [m, a, d] of [
      [1, 0.55, ring],
      [2.003, 0.22, ring * 0.6],
      [3.01, 0.08, ring * 0.35],
      [2.76, 0.1, 0.18],
      [5.4, 0.06, 0.09],
      [8.93, 0.03, 0.05],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * m * (1 + (Math.random() - 0.5) * 0.002);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, now);
      og.gain.exponentialRampToValueAtTime(a, now + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0001, now + d);
      o.connect(og).connect(g);
      o.start(now);
      o.stop(now + d + 0.05);
    }
  }

  /** Trying a door that will not open: the handle wrenched, the lock's bolts knocking in their keeps. */
  vaultRattle(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    const send = this.roomSend();
    if (send) out.connect(send);
    for (let i = 0; i < 4; i++) {
      const t = now + i * 0.13 + Math.random() * 0.03;
      this.burst(t, 0.05, 900 + Math.random() * 400, 300, 3, 0.5, out);
      this.tone(t, 70 + Math.random() * 15, 0.12, 0.45, out);
      this.tone(t + 0.005, 1830 + Math.random() * 300, 0.07, 0.05, out, 'square');
    }
    // and its lock's light chirps: no
    this.tone(now + 0.6, 440, 0.12, 0.08, out, 'square');
    this.tone(now + 0.75, 330, 0.18, 0.08, out, 'square');
  }

  /** The door unlocking from inside: three heavy bolts drawn one by one, a seal breaking with a long hiss. */
  vaultUnlock(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    const send = this.roomSend();
    if (send) out.connect(send);
    for (let i = 0; i < 3; i++) {
      const t = now + i * 0.55;
      this.burst(t, 0.14, 2600, 400, 2, 0.35, out);
      this.tone(t + 0.12, 55, 0.35, 0.7, out);
      this.burst(t + 0.12, 0.08, 1200, 300, 2, 0.6, out);
    }
    this.tone(now + 1.75, 523.25, 0.25, 0.08, out, 'triangle');
    this.tone(now + 1.9, 783.99, 0.5, 0.08, out, 'triangle');
    this.burst(now + 1.8, 1.6, 6000, 1800, 0.6, 0.25, out);
  }

  /** The door grinding open along its track. */
  vaultSlide(seconds: number, level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(level, now + 0.2);
    out.gain.setValueAtTime(level, now + seconds - 0.25);
    out.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
    out.connect(this.master);
    const send = this.roomSend();
    if (send) out.connect(send);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(48, now);
    o.frequency.linearRampToValueAtTime(62, now + seconds);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const og = ctx.createGain();
    og.gain.value = 0.5;
    o.connect(lp).connect(og).connect(out);
    o.start(now);
    o.stop(now + seconds + 0.1);
    const grit = ctx.createBufferSource();
    grit.buffer = this.white;
    grit.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 1.5;
    const gg = ctx.createGain();
    gg.gain.value = 0.25;
    grit.connect(bp).connect(gg).connect(out);
    grit.start(now);
    grit.stop(now + seconds + 0.1);
    // and it thumps home into its pocket
    this.tone(now + seconds - 0.05, 60, 0.4, 0.8 * level, this.master);
  }

  /** A groan of the hall's frame settling, deep and long, far off in the dark. */
  hallGroan(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.creaks.length) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master);
    const send = this.roomSend();
    if (send) p.connect(send);
    const src = ctx.createBufferSource();
    src.buffer = this.any(this.creaks);
    src.playbackRate.value = 0.35 + Math.random() * 0.2;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(p);
    src.start(now);
  }

  /** A drip, somewhere in the dark: a small bright plink, and its echo. */
  hallDrip(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master);
    const send = this.roomSend();
    if (send) p.connect(send);
    const o = ctx.createOscillator();
    const f = 1400 + Math.random() * 900;
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 1.6, now + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    o.connect(g).connect(p);
    o.start(now);
    o.stop(now + 0.12);
  }

  /** The dock calling for the tracker: a soft, bright two-note chirp, in the room. */
  dockChirp(level: number) {
    const ctx = this.ctx;
    if (!ctx || level < 0.003) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    const r = this.roomBus();
    if (r) out.connect(r.echo);
    this.tone(now, 1318.5, 0.09, 0.5, out, 'triangle');
    this.tone(now + 0.11, 1760, 0.14, 0.5, out, 'triangle');
  }

  /**
   * The tracker taking its update: a click as it seats, a rising hum, a fast
   * patter of data, the song's tones running up as the new place is written
   * into it, and a bright, settled chord when it is done.
   */
  dockUpload(seconds: number, level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    const r = this.roomBus();
    if (r) out.connect(r.echo);
    this.burst(now, 0.01, 4200, 3200, 5, 0.6, out);
    this.tone(now + 0.02, 140, 0.1, 0.5, out);
    // the hum, rising as it works
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, now + 0.1);
    o.frequency.exponentialRampToValueAtTime(330, now + seconds);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + 0.1);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.4);
    g.gain.setValueAtTime(0.08, now + seconds - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, now + seconds + 0.1);
    o.connect(lp).connect(g).connect(out);
    o.start(now + 0.1);
    o.stop(now + seconds + 0.2);
    // the data: a patter of tiny blips
    for (let t = 0.3; t < seconds - 0.2; t += 0.035 + Math.random() * 0.04) {
      const b = ctx.createOscillator();
      b.type = 'square';
      b.frequency.value = 1800 + Math.random() * 2400;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.025, now + t);
      bg.gain.setValueAtTime(0, now + t + 0.012);
      b.connect(bg).connect(out);
      b.start(now + t);
      b.stop(now + t + 0.02);
    }
    // the tones of its new song running up through it, and the chord when it is written
    [293.66, 369.99, 440, 587.33, 659.26].forEach((f, k) => this.tone(now + seconds * 0.55 + k * 0.12, f * 2, 0.25, 0.08, out, 'triangle'));
    for (const f of [587.33, 739.99, 880, 1174.66]) this.tone(now + seconds, f, 1.4, 0.06, out, 'sine');
  }

  /** It loses the way: a soft falling pair. */
  trackerLose(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.trackerBus()) return;
    const now = ctx.currentTime;
    this.trackerVoice(587.33, 580, now, 0.01, 0.03, 0.4, level);
    this.trackerVoice(392, 386, now + 0.11, 0.01, 0.03, 0.6, level);
  }

  /** Waking in the hand: a rising sweep out of static, settling on a pure note. */
  trackerWake(level: number) {
    const ctx = this.ctx;
    const t = this.trackerBus();
    if (!ctx || !t) return;
    const now = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, now);
    lp.frequency.exponentialRampToValueAtTime(5000, now + 0.7);
    lp.connect(t.bus);
    this.trackerVoice(140, 784, now, 0.5, 0.15, 0.5, level * 0.5, 'triangle', lp);
    this.trackerVoice(147, 790, now + 0.03, 0.5, 0.15, 0.5, level * 0.25, 'sawtooth', lp);
    this.trackerVoice(1567.98, 1567.98, now + 0.62, 0.01, 0.1, 1.6, level * 0.22);
    if (this.white) {
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900, now);
      bp.frequency.exponentialRampToValueAtTime(4200, now + 0.6);
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(level * 0.12, now + 0.15);
      g.gain.setTargetAtTime(0.0001, now + 0.45, 0.08);
      src.connect(bp).connect(g).connect(t.bus);
      src.start(now, Math.random() * 1.5, 1);
    }
  }

  /** Picked up: the hoof closing on its shell. */
  trackerGrab(level: number) {
    this.tickAt(level, 1.5);
    this.tickAt(level * 0.5, 2.6);
  }

  /** Lifted up to look at: a soft little rising chirp. */
  trackerRaise(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.trackerBus()) return;
    const now = ctx.currentTime;
    this.trackerVoice(1046.5, 1318.5, now, 0.01, 0.04, 0.25, level);
  }

  /** Dropped: it knocks on the sand and rattles. */
  trackerDrop(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.thud(level * 0.6);
    this.tickAt(level, 1.15);
    const now = ctx.currentTime;
    for (const [d, r, l] of [
      [0.07, 1.6, 0.6],
      [0.16, 1.35, 0.3],
    ]) {
      const src = ctx.createBufferSource();
      src.buffer = this.any(this.ticks);
      src.playbackRate.value = r;
      const g = ctx.createGain();
      g.gain.value = level * l;
      src.connect(g).connect(this.master);
      src.start(now + d);
    }
  }

  // --------------------------------------------------------------- highlands

  private highBus() {
    const ctx = this.ctx;
    if (!ctx || !this.white) return null;
    if (this.high) return this.high;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.outside);
    // everything out there echoes off the rock
    const send = ctx.createGain();
    send.gain.value = 1.1;
    bus.connect(send).connect(this.reverbSend);
    const lfo = (f: number, depth: number, to: AudioParam) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g).connect(to);
      o.start();
    };
    // wind across the openings in the rock: two narrow, drifting resonances that gust
    const moan = ctx.createGain();
    moan.gain.value = 0;
    moan.connect(bus);
    for (const [f, q, drift, rate, g] of [
      [205, 14, 26, 0.061, 7],
      [318, 17, 34, 0.093, 5],
      [143, 11, 15, 0.047, 6],
    ]) {
      const src = this.loop(ctx, this.white);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      lfo(rate, drift, bp.frequency);
      const gust = ctx.createGain();
      gust.gain.value = g * 0.6;
      lfo(rate * 1.7 + 0.03, g * 0.4, gust.gain);
      src.connect(bp).connect(gust).connect(moan);
    }
    // a thin whistle off a sharp edge, coming and going
    const whistle = ctx.createGain();
    whistle.gain.value = 0;
    whistle.connect(bus);
    {
      const src = this.loop(ctx, this.white);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1240;
      bp.Q.value = 38;
      lfo(0.07, 90, bp.frequency);
      const g = ctx.createGain();
      g.gain.value = 3;
      lfo(0.11, 2.6, g.gain);
      src.connect(bp).connect(g).connect(whistle);
    }
    // at the heart of the place: a low hum, two notes slowly beating, and a faint high glint over them
    const heart = ctx.createGain();
    heart.gain.value = 0;
    const hlp = ctx.createBiquadFilter();
    hlp.type = 'lowpass';
    hlp.frequency.value = 420;
    hlp.connect(heart).connect(bus);
    for (const [f, g, type] of [
      [49, 0.5, 'sine'],
      [49.35, 0.35, 'sine'],
      [73.4, 0.3, 'triangle'],
      [98.3, 0.12, 'sine'],
      [587.3, 0.025, 'sine'],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(f > 400 ? heart : hlp);
      o.start();
    }
    this.high = { bus, moan, whistle, heart, level: 0 };
    return this.high;
  }

  /** How far into the highlands (0..1), how near their heart (0..1), and the wind (0..1). */
  setHighlands(level: number, heart: number, wind: number) {
    const ctx = this.ctx;
    if (!ctx || (level <= 0 && !this.high)) return;
    const h = this.highBus();
    if (!h) return;
    const now = ctx.currentTime;
    h.level = level;
    h.bus.gain.setTargetAtTime(level * this.envLevel, now, 0.5);
    h.moan.gain.setTargetAtTime(0.05 * (0.35 + 0.65 * wind), now, 0.8);
    h.whistle.gain.setTargetAtTime(0.012 * wind * wind, now, 0.8);
    h.heart.gain.setTargetAtTime(0.06 * heart, now, 1.2);
  }

  /** A trickle of pebbles skittering down a rock face somewhere near, echoing. */
  highlandPebbles(level: number, pan: number) {
    const ctx = this.ctx;
    const h = this.highBus();
    if (!ctx || !h || !this.ticks.length) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(h.bus);
    const n = 5 + Math.floor(Math.random() * 7);
    let t = now;
    for (let k = 0; k < n; k++) {
      t += 0.04 + Math.random() * 0.12 * (1 - k / n);
      const src = ctx.createBufferSource();
      src.buffer = this.any(this.ticks);
      src.playbackRate.value = 1.1 + Math.random() * 1.6;
      const g = ctx.createGain();
      g.gain.value = level * (1 - k / (n + 2)) * (0.5 + Math.random() * 0.5);
      src.connect(g).connect(p);
      src.start(t);
    }
    const pour = ctx.createBufferSource();
    pour.buffer = this.any(this.pours);
    pour.playbackRate.value = 1.3;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(level * 0.25, now);
    pg.gain.setTargetAtTime(0.0001, now + 0.6, 0.2);
    pour.connect(pg).connect(p);
    pour.start(now, 0, 1.5);
  }

  /** Far off, a slab lets go: a long low rumble, a clatter, and the echo coming back. */
  highlandRockfall(level: number, pan: number) {
    const ctx = this.ctx;
    const h = this.highBus();
    if (!ctx || !h || !this.white) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(h.bus);
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260, now);
    lp.frequency.exponentialRampToValueAtTime(90, now + 2.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 2.4, now + 0.25);
    g.gain.setTargetAtTime(0.0001, now + 0.9, 0.7);
    src.connect(lp).connect(g).connect(p);
    src.start(now, Math.random(), 3.5);
    for (let k = 0; k < 9; k++) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(k % 3 === 0 ? this.clanks : this.ticks);
      c.playbackRate.value = 0.5 + Math.random() * 0.6;
      const cg = ctx.createGain();
      cg.gain.value = level * 0.4 * (1 - k / 11);
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.value = 1400;
      c.connect(lp2).connect(cg).connect(p);
      c.start(now + 0.15 + k * (0.08 + Math.random() * 0.14));
    }
  }

  /**
   * Indoors (0..1): the wind and the rock outside fall to a dull murmur
   * through the walls, and the room's own sound comes up: a lamp ballast's
   * buzz, an air handler's fan, a low vent drone, and the whine of the rack.
   */
  setIndoors(amount: number, flicker = 1, kind = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.outside) return;
    this.indoor = amount;
    this.indoorKind = kind;
    if (kind === 1) {
      // the facility: deep underground, the outside barely there; the station's room is silent
      const now = ctx.currentTime;
      this.outside.frequency.setTargetAtTime(20000 * Math.pow(260 / 20000, amount), now, 0.2);
      this.outsideGain.gain.setTargetAtTime(1 - 0.75 * amount, now, 0.2);
      if (this.room) this.room.bus.gain.setTargetAtTime(0, now, 0.2);
      const h = this.hallBus();
      if (h) h.bus.gain.setTargetAtTime(amount * this.envLevel, now, 0.3);
      return;
    }
    if (this.hall) this.hall.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    const now = ctx.currentTime;
    this.outside.frequency.setTargetAtTime(20000 * Math.pow(500 / 20000, amount), now, 0.15);
    this.outsideGain.gain.setTargetAtTime(1 - 0.6 * amount, now, 0.15);
    if (amount <= 0 && !this.room) return;
    const r = this.roomBus();
    if (!r) return;
    r.bus.gain.setTargetAtTime(amount * 0.9 * this.envLevel, now, 0.2);
    r.buzz.gain.setTargetAtTime(0.02 * flicker * flicker, now, 0.01);
  }

  private roomBus() {
    const ctx = this.ctx;
    if (!ctx || !this.white) return null;
    if (this.room) return this.room;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    // the lamps' ballast: a thin mains buzz
    const buzz = ctx.createGain();
    buzz.gain.value = 0;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 1100;
    bf.Q.value = 0.8;
    bf.connect(buzz).connect(bus);
    for (const [f, type, g] of [
      [120, 'sawtooth', 0.5],
      [240.4, 'square', 0.15],
      [360.2, 'sawtooth', 0.1],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(bf);
      o.start();
    }
    // the air handler: a soft rush of air with a slow beat in it
    {
      const src = this.loop(ctx, this.white);
      const lp = ctx.createBiquadFilter();
      lp.type = 'bandpass';
      lp.frequency.value = 320;
      lp.Q.value = 0.6;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.31;
      const lg = ctx.createGain();
      lg.gain.value = 0.012;
      lfo.connect(lg).connect(g.gain);
      lfo.start();
      src.connect(lp).connect(g).connect(bus);
    }
    // a low drone in the vents, and the rack's faint high whine
    for (const [f, g] of [
      [55, 0.05],
      [82.6, 0.025],
      [3150, 0.0025],
      [3162, 0.0018],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(bus);
      o.start();
    }
    // a small hard room: a short, bright slap off the walls
    const echo = ctx.createGain();
    echo.gain.value = 1;
    const d = ctx.createDelay(0.2);
    d.delayTime.value = 0.045;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 2600;
    echo.connect(d).connect(dl).connect(fb).connect(d);
    dl.connect(this.master);
    this.room = { bus, buzz, echo };
    return this.room;
  }

  /** A bubble rising through the specimen tank: a soft, wet blip. */
  roomBubble(level: number) {
    const ctx = this.ctx;
    const r = this.roomBus();
    if (!ctx || !r) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    const f = 380 + Math.random() * 500;
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 2.2, now + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    o.connect(g).connect(r.bus);
    o.start(now);
    o.stop(now + 0.1);
  }

  /** The torn cable arcing: a sharp electric snap and a fizz. */
  roomZap(level: number) {
    const ctx = this.ctx;
    const r = this.roomBus();
    if (!ctx || !r || !this.white) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, now);
    g.gain.setTargetAtTime(level * 0.3, now + 0.02, 0.03);
    g.gain.setTargetAtTime(0.0001, now + 0.2, 0.08);
    const am = ctx.createOscillator();
    am.type = 'square';
    am.frequency.value = 60;
    const amg = ctx.createGain();
    amg.gain.value = level * 0.6;
    am.connect(amg).connect(g.gain);
    src.connect(hp).connect(g).connect(r.bus);
    g.connect(r.echo);
    src.start(now, Math.random(), 0.6);
    am.start(now);
    am.stop(now + 0.6);
  }

  /** The cracked screen stuttering: a dry crackle of static. */
  roomCrackle(level: number) {
    const ctx = this.ctx;
    const r = this.roomBus();
    if (!ctx || !r || !this.white) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3800;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    for (let k = 0; k < 6; k++) {
      const t = now + k * (0.02 + Math.random() * 0.05);
      g.gain.setValueAtTime(level * (0.4 + Math.random() * 0.6), t);
      g.gain.setValueAtTime(0.0001, t + 0.012);
    }
    src.connect(bp).connect(g).connect(r.bus);
    src.start(now, Math.random(), 0.5);
  }

  /** The airlock door dragged on its broken track: a short grinding scrape and a clank. */
  hatch(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, now);
    bp.frequency.linearRampToValueAtTime(420, now + 0.45);
    bp.Q.value = 3;
    const am = ctx.createOscillator();
    am.frequency.value = 23;
    const amg = ctx.createGain();
    amg.gain.value = level * 0.5;
    am.connect(amg);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level, now + 0.05);
    g.gain.setTargetAtTime(0.0001, now + 0.4, 0.06);
    amg.connect(g.gain);
    src.connect(bp).connect(g).connect(this.master);
    g.connect(this.reverbSend);
    src.start(now, Math.random(), 0.8);
    am.start(now);
    am.stop(now + 0.8);
    // it catches and clanks at the end
    if (this.clanks.length) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(this.clanks);
      c.playbackRate.value = 0.8;
      const cg = ctx.createGain();
      cg.gain.value = level * 0.8;
      c.connect(cg).connect(this.master);
      cg.connect(this.reverbSend);
      c.start(now + 0.42);
    }
  }

  /** A hoof on the metal deck, with the room's slap off its walls. */
  private metalStep(ev: StepEvent) {
    const ctx = this.ctx!;
    const heavy = ev.run > 0.5;
    const bank = heavy && this.heavyMetalSteps.length ? this.heavyMetalSteps : this.metalSteps;
    if (!bank.length) return;
    const now = ctx.currentTime;
    const r = this.roomBus();
    const src = ctx.createBufferSource();
    src.buffer = bank[Math.floor(Math.random() * bank.length)];
    src.playbackRate.value = (0.94 + Math.random() * 0.12) * lerp(1, 0.9, ev.crouch);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // soft-footed when crouching, sharper at a run
    lp.frequency.value = lerp(lerp(5200, 7000, ev.run), 1400, ev.crouch);
    const g = ctx.createGain();
    const pace = 0.2 + Math.min(ev.speed, 2.5) * 0.07;
    g.gain.value = (ev.scuff ? 0.07 : pace) * lerp(1, 0.4, ev.crouch) * (0.85 + Math.random() * 0.3);
    const p = ctx.createStereoPanner();
    p.pan.value = ev.side * 0.12;
    src.connect(lp).connect(g).connect(p);
    p.connect(this.master);
    if (r) {
      const send = ctx.createGain();
      send.gain.value = 0.55;
      p.connect(send).connect(r.echo);
    }
    src.start(now);
  }

  private droneBus() {
    const ctx = this.ctx;
    if (!ctx || !this.white) return null;
    if (this.drone) return this.drone;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    const pan = ctx.createStereoPanner();
    bus.connect(pan).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    pan.connect(send).connect(this.reverbSend);
    // four props, each a harsh buzz at its blade rate, a little apart so they beat and snarl
    // a slow, sick throb through it all
    const throb = ctx.createGain();
    throb.gain.value = 0.8;
    throb.connect(bus);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7.3;
    const lg = ctx.createGain();
    lg.gain.value = 0.2;
    lfo.connect(lg).connect(throb.gain);
    lfo.start();
    const tone = ctx.createBiquadFilter();
    tone.type = 'bandpass';
    tone.frequency.value = 900;
    tone.Q.value = 0.7;
    tone.connect(throb);
    const base = [196, 203.5, 211, 219.2];
    const oscs: OscillatorNode[] = [];
    for (const f of base) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.12;
      o.connect(og).connect(tone);
      o.start();
      oscs.push(o);
      // and its octave, thin and nasty
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = f * 2.01;
      const g2 = ctx.createGain();
      g2.gain.value = 0.03;
      o2.connect(g2).connect(tone);
      o2.start();
      oscs.push(o2);
    }
    // the rush of air off the props
    const src = this.loop(ctx, this.white);
    const wash = ctx.createBiquadFilter();
    wash.type = 'bandpass';
    wash.frequency.value = 1400;
    wash.Q.value = 0.9;
    const wg = ctx.createGain();
    wg.gain.value = 0.35;
    src.connect(wash).connect(wg).connect(throb);
    this.drone = { bus, pan, oscs, base: base.flatMap((f) => [f, f * 2.01]), wash, tone };
    return this.drone;
  }

  /** The drone, heard from here: 0..1 level, pan, how hard its props work, and the dive's scream (0..1). */
  setDrone(level: number, pan: number, throttle: number, scream: number) {
    const ctx = this.ctx;
    if (!ctx || (level <= 0 && !this.drone)) return;
    const d = this.droneBus();
    if (!d) return;
    const now = ctx.currentTime;
    d.bus.gain.setTargetAtTime(level * 0.45 * this.envLevel, now, 0.05);
    d.pan.pan.setTargetAtTime(pan, now, 0.05);
    const k = (1 + throttle * 0.28) * (1 + scream * 0.75);
    d.oscs.forEach((o, i) => o.frequency.setTargetAtTime(d.base[i] * k, now, scream > 0 ? 0.25 : 0.12));
    d.tone.frequency.setTargetAtTime(900 * k * (0.6 + 0.4 * level), now, 0.1);
    d.wash.frequency.setTargetAtTime(1400 * k, now, 0.1);
  }

  /** The drone's sensor studying something: a servo's whir and a few quick, cold chirps. */
  droneChirp(level: number) {
    const ctx = this.ctx;
    const d = this.droneBus();
    if (!ctx || !d || level < 0.01) return;
    const now = ctx.currentTime;
    for (let k = 0; k < 3; k++) {
      const t = now + 0.1 + k * 0.09;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(2400 + k * 300, t);
      o.frequency.exponentialRampToValueAtTime(3600 + k * 200, t + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level * 0.1, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g).connect(d.pan);
      o.start(t);
      o.stop(t + 0.08);
    }
    // the turret turning
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(140, now);
    o.frequency.linearRampToValueAtTime(260, now + 0.35);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    f.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 0.06, now + 0.03);
    g.gain.setTargetAtTime(0.0001, now + 0.3, 0.04);
    o.connect(f).connect(g).connect(d.pan);
    o.start(now);
    o.stop(now + 0.5);
  }

  /** Lock: a hard electronic tone that rises and holds. */
  droneLock(level: number) {
    const ctx = this.ctx;
    const d = this.droneBus();
    if (!ctx || !d) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(880, now);
    o.frequency.exponentialRampToValueAtTime(1760, now + 0.4);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07 + level * 0.05, now + 0.02);
    g.gain.setTargetAtTime(0.0001, now + 0.55, 0.05);
    o.connect(f).connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.9);
  }

  /** The targeting beep, faster and higher as the lock closes. */
  droneBeep(level: number, pitch: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 2200 * pitch;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 4000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 0.5, now + 0.004);
    g.gain.setValueAtTime(level * 0.5, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    o.connect(f).connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.1);
  }

  /** The dive: the props go to full and scream. */
  droneDive(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(900, now);
    bp.frequency.exponentialRampToValueAtTime(3200, now + 0.7);
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.1 + level * 0.15, now + 0.5);
    g.gain.setTargetAtTime(0.0001, now + 0.9, 0.1);
    src.connect(bp).connect(g).connect(this.master);
    src.start(now, Math.random(), 1.5);
  }

  /** Dread: something is coming. A low, dissonant cluster swells and hangs. */
  dread() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.12, now + 4);
    out.gain.setTargetAtTime(0.0001, now + 7, 1.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, now);
    lp.frequency.linearRampToValueAtTime(700, now + 5);
    lp.connect(out).connect(this.master);
    out.connect(this.reverbSend);
    for (const [f, type, g] of [
      [55, 'sawtooth', 0.35],
      [58.3, 'sawtooth', 0.3],
      [77.8, 'triangle', 0.3],
      [82.4, 'sine', 0.25],
      [116.5, 'sine', 0.12],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(now);
      o.stop(now + 14);
    }
  }

  /**
   * The warhead: a cracking report, a punch felt in the chest, a deep boom
   * that rolls away off the rock, and shrapnel and pieces raining down.
   */
  blast(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    // the crack
    const crack = ctx.createBufferSource();
    crack.buffer = this.white;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(level * 1.8, now);
    cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    crack.connect(hp).connect(cg).connect(this.out);
    crack.start(now, 0, 0.2);
    // the punch: a sub thump that drops
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(95, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.5);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(level * 1.4, now);
    sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
    sub.connect(sg).connect(this.out);
    sub.start(now);
    sub.stop(now + 0.9);
    // the boom and its long rumble
    const boom = ctx.createBufferSource();
    boom.buffer = this.white;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, now);
    lp.frequency.exponentialRampToValueAtTime(110, now + 2.5);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(level * 1.5, now);
    bg.gain.setTargetAtTime(level * 0.5, now + 0.1, 0.25);
    bg.gain.setTargetAtTime(0.0001, now + 1.2, 1.1);
    boom.connect(lp).connect(bg).connect(this.master);
    const verb = ctx.createGain();
    verb.gain.value = 2.2;
    bg.connect(verb).connect(this.reverbSend);
    boom.start(now, 0, 2.2);
    // shrapnel and pieces coming down
    for (let k = 0; k < 14; k++) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(k % 3 === 0 ? this.clanks : this.ticks);
      c.playbackRate.value = 0.8 + Math.random() * 0.9;
      const g = ctx.createGain();
      g.gain.value = level * 0.25 * (1 - k / 16);
      c.connect(g).connect(this.master);
      c.start(now + 0.3 + k * (0.06 + Math.random() * 0.12));
    }
  }

  /**
   * Deafened (1) by the blast: everything goes far away and dull, and a thin
   * high ringing fills the ears, slowly fading. 0 brings the world back.
   */
  deafen(amount: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const f = this.muffle.frequency;
    f.cancelScheduledValues(now);
    if (amount > 0) {
      f.setValueAtTime(f.value, now);
      f.setValueAtTime(20000, now + 0.08);
      f.exponentialRampToValueAtTime(260, now + 0.35);
      if (!this.ring) {
        this.ring = ctx.createGain();
        this.ring.connect(this.out);
        for (const [fr, g] of [
          [4180, 0.05],
          [4196, 0.04],
          [6250, 0.012],
        ]) {
          const o = ctx.createOscillator();
          o.frequency.value = fr;
          const og = ctx.createGain();
          og.gain.value = g;
          o.connect(og).connect(this.ring);
          o.start();
        }
      }
      this.ring.gain.cancelScheduledValues(now);
      this.ring.gain.setValueAtTime(0.0001, now);
      this.ring.gain.exponentialRampToValueAtTime(amount * 1.2, now + 0.3);
      this.ring.gain.setTargetAtTime(amount * 0.25, now + 0.8, 2.5);
    } else {
      f.setValueAtTime(Math.max(200, f.value), now);
      f.exponentialRampToValueAtTime(20000, now + 1.5);
      if (this.ring) {
        this.ring.gain.cancelScheduledValues(now);
        this.ring.gain.setTargetAtTime(0, now, 0.3);
      }
    }
  }

  /** A click of hard jaws, `at` seconds from now: a tiny bright tick, sometimes wet. */
  private jawClick(at: number, level: number, pan: StereoPannerNode, wet: boolean) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.white!;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + Math.random() * 3200;
    bp.Q.value = 3 + Math.random() * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.004 + Math.random() * 0.004);
    src.connect(bp).connect(g).connect(pan);
    src.start(at, Math.random() * 2, 0.02);
    if (wet) {
      // a squelch of torn flesh
      const s2 = ctx.createBufferSource();
      s2.buffer = this.white!;
      const lp = ctx.createBiquadFilter();
      lp.type = 'bandpass';
      lp.frequency.setValueAtTime(700 + Math.random() * 500, at);
      lp.frequency.exponentialRampToValueAtTime(260, at + 0.05);
      lp.Q.value = 2.5;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, at);
      g2.gain.exponentialRampToValueAtTime(level * 0.9, at + 0.006);
      g2.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
      s2.connect(lp).connect(g2).connect(pan);
      s2.start(at, Math.random() * 2, 0.08);
    }
  }

  private locustOut(pan: number) {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.outside);
    return p;
  }

  /** Jaws at work on the dead: a dry, busy clicking, now and then wet. */
  locustChew(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const p = this.locustOut(pan);
    const n = 2 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n; k++) this.jawClick(now + Math.random() * 0.1, level * (0.06 + Math.random() * 0.06), p, Math.random() < 0.18);
  }

  /** A little chirring chitter: a quick run of tiny pulses, high and dry, from somewhere in the swarm. */
  locustChitter(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const p = this.locustOut(Math.max(-1, Math.min(1, pan)));
    const n = 3 + Math.floor(Math.random() * 6);
    const f = 4200 + Math.random() * 2600;
    const gap = 0.018 + Math.random() * 0.016;
    for (let k = 0; k < n; k++) {
      const at = now + k * gap;
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * (1 + (Math.random() - 0.5) * 0.08);
      bp.Q.value = 7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level * 0.09 * (1 - (k / n) * 0.5), at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.011);
      src.connect(bp).connect(g).connect(p);
      src.start(at, Math.random() * 2, 0.02);
    }
  }

  /** One of them squealing in fright: a thin, harsh, rising squeak. */
  locustSqueal(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || level < 0.005) return;
    const now = ctx.currentTime;
    const p = this.locustOut(Math.max(-1, Math.min(1, pan)));
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = 2400 + Math.random() * 1400;
    o.frequency.setValueAtTime(f * 0.8, now);
    o.frequency.exponentialRampToValueAtTime(f * 1.35, now + 0.12);
    o.frequency.exponentialRampToValueAtTime(f, now + 0.2);
    const am = ctx.createOscillator();
    am.frequency.value = 90 + Math.random() * 60;
    const amg = ctx.createGain();
    amg.gain.value = 0.5;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    am.connect(amg).connect(g2.gain);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 0.06, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    o.connect(bp).connect(g2).connect(g).connect(p);
    o.start(now);
    am.start(now);
    o.stop(now + 0.3);
    am.stop(now + 0.3);
  }

  /** Startled: a dry rattle runs through the swarm, wings and legs scraping, rising. */
  locustAlarm(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const p = this.locustOut(pan);
    for (const [f, rate, delay] of [
      [4300, 58, 0],
      [5200, 71, 0.06],
      [3600, 49, 0.12],
    ]) {
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 3;
      const am = ctx.createGain();
      am.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(rate * 0.7, now + delay);
      lfo.frequency.linearRampToValueAtTime(rate * 1.3, now + delay + 0.7);
      const lg = ctx.createGain();
      lg.gain.value = 0.5;
      lfo.connect(lg).connect(am.gain);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + delay);
      g.gain.exponentialRampToValueAtTime(level * 0.18, now + delay + 0.25);
      g.gain.setTargetAtTime(0.0001, now + delay + 0.7, 0.12);
      src.connect(bp).connect(am).connect(g).connect(p);
      src.start(now + delay, Math.random(), 1.4);
      lfo.start(now + delay);
      lfo.stop(now + delay + 1.4);
    }
  }

  /** Many small feet running over sand: a soft, quick patter. */
  locustPatter(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const p = this.locustOut(pan);
    for (let k = 0; k < 5; k++) {
      const at = now + Math.random() * 0.03;
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + Math.random() * 2400;
      bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level * 0.05 * (0.5 + Math.random()), at + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.006);
      src.connect(bp).connect(g).connect(p);
      src.start(at, Math.random() * 2, 0.02);
    }
  }

  /** A hop: a short whirr of stiff wings. */
  locustBuzz(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const p = this.locustOut(pan);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 140 + Math.random() * 60;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100 + Math.random() * 600;
    bp.Q.value = 1.5;
    const am = ctx.createGain();
    am.gain.value = 0;
    o.connect(am.gain);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level * 0.1, now + 0.03);
    g.gain.setTargetAtTime(0.0001, now + 0.22, 0.04);
    src.connect(bp).connect(am).connect(g).connect(p);
    o.start(now);
    o.stop(now + 0.45);
    src.start(now, Math.random(), 0.45);
  }

  /** Digging in: quick scratching strokes in the sand, muffling as it goes under. */
  locustDig(level: number, pan: number) {
    const ctx = this.ctx;
    if (!ctx || !this.sprays.length || level < 0.005) return;
    const now = ctx.currentTime;
    const p = this.locustOut(pan);
    for (let k = 0; k < 10; k++) {
      const at = now + k * (0.08 + Math.random() * 0.04);
      const src = ctx.createBufferSource();
      src.buffer = this.any(this.sprays);
      src.playbackRate.value = 1.3 + Math.random() * 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5000 * (1 - k / 12) + 600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level * 0.12 * (1 - k / 13), at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
      src.connect(lp).connect(g).connect(p);
      src.start(at, Math.random() * 0.2, 0.1);
    }
  }

  /** A short burst of filtered noise at `at`: the building block of clicks, scrapes and slides. */
  private burst(at: number, dur: number, f0: number, f1: number, q: number, level: number, to: AudioNode, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.white!;
    const bp = ctx.createBiquadFilter();
    bp.type = type;
    bp.frequency.setValueAtTime(f0, at);
    bp.frequency.exponentialRampToValueAtTime(f1, at + dur);
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + Math.min(0.004, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(to);
    src.start(at, Math.random() * 2, dur + 0.05);
  }

  private tone(at: number, f: number, dur: number, level: number, to: AudioNode, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(to);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  /** Picking up a data card: two plastic clicks and a rustle as it goes in with the others. */
  cardPickup(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    this.burst(now, 0.012, 3800, 3000, 4, level * 0.6, this.master);
    this.burst(now + 0.05, 0.01, 4600, 3600, 5, level * 0.4, this.master);
    this.burst(now + 0.32, 0.18, 2400, 1200, 0.8, level * 0.18, this.master);
    this.burst(now + 0.36, 0.012, 3200, 2600, 4, level * 0.35, this.master);
  }

  /** A card slid into the reader: taken with a latch and a bright chirp, or refused with a buzz and pushed out. */
  cardInsert(level: number, ok: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const r = this.roomBus();
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);
    if (r) out.connect(r.echo);
    this.burst(now, 0.12, 1800, 3200, 2, level * 0.25, out);
    if (ok) {
      // ka-chunk: the latch catching, then the card driven home with a heavy clunk
      this.burst(now + 0.11, 0.008, 4200, 3400, 5, level * 0.7, out);
      this.burst(now + 0.13, 0.01, 2600, 2000, 5, level * 0.5, out);
      this.tone(now + 0.2, 95, 0.12, level * 0.9, out);
      this.burst(now + 0.2, 0.05, 1100, 500, 2, level * 0.6, out);
      if (this.clanks.length) {
        const c = ctx.createBufferSource();
        c.buffer = this.any(this.clanks);
        c.playbackRate.value = 1.35;
        const cg = ctx.createGain();
        cg.gain.value = level * 0.55;
        c.connect(cg).connect(out);
        c.start(now + 0.2);
      }
      this.tone(now + 0.18, 1320, 0.09, level * 0.12, out);
      this.tone(now + 0.27, 1760, 0.14, level * 0.12, out);
    } else {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 96;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + 0.1);
      g.gain.exponentialRampToValueAtTime(level * 0.35, now + 0.12);
      g.gain.setValueAtTime(level * 0.35, now + 0.42);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);
      o.connect(bp).connect(g).connect(out);
      o.start(now + 0.1);
      o.stop(now + 0.5);
      this.burst(now + 0.5, 0.1, 3000, 1800, 2, level * 0.25, out);
      this.burst(now + 0.58, 0.008, 3600, 3000, 5, level * 0.5, out);
    }
  }

  /** All three in: a rising chime, then a heavy relay clunks over. */
  releaseChime(level: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [k, f] of [523.25, 659.25, 783.99, 1046.5].entries()) {
      this.tone(now + k * 0.13, f, 0.5, level * 0.1, this.master);
      this.tone(now + k * 0.13, f * 2, 0.3, level * 0.03, this.master);
    }
    if (this.clanks.length) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(this.clanks);
      c.playbackRate.value = 0.55;
      const g = ctx.createGain();
      g.gain.value = level * 0.7;
      c.connect(g).connect(this.master);
      c.start(now + 0.75);
    }
  }

  /**
   * The tank draining: pumps start with a deep hum, the fluid goes down in
   * gulps and glugs, and the last of it is sucked away with a slurp.
   */
  tankDrain(level: number, seconds: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime + 0.8;
    const r = this.roomBus();
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    if (r) out.connect(r.echo);
    // the pump: a motor winding up, labouring under the load
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(30, now);
    o.frequency.exponentialRampToValueAtTime(58, now + 0.8);
    o.frequency.setValueAtTime(58, now + seconds - 0.4);
    o.frequency.exponentialRampToValueAtTime(30, now + seconds + 0.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.35, now + 0.6);
    g.gain.setValueAtTime(0.35, now + seconds - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, now + seconds + 0.7);
    o.connect(lp).connect(g).connect(out);
    o.start(now);
    o.stop(now + seconds + 0.8);
    // gulps and glugs: deep bubbles bursting as it goes down
    let t = now + 0.3;
    while (t < now + seconds) {
      const f = 520 + Math.random() * 300;
      this.burst(t, 0.09 + Math.random() * 0.08, f, f * 0.35, 6, 0.5 * (0.5 + Math.random() * 0.5), out);
      if (Math.random() < 0.4) this.tone(t + 0.02, 160 + Math.random() * 120, 0.08, 0.12, out);
      t += 0.06 + Math.random() * 0.18;
    }
    // the last of it sucked away
    this.burst(now + seconds - 0.3, 0.7, 260, 1400, 3, 0.6, out);
    this.burst(now + seconds + 0.2, 0.25, 900, 300, 4, 0.35, out);
  }

  /** The tank's door unsealing: a pop, a long hiss of pressure, the door grinding round on its track. */
  tankHiss(level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white) return;
    const now = ctx.currentTime;
    const r = this.roomBus();
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(this.master);
    if (r) out.connect(r.echo);
    this.tone(now, 110, 0.08, 0.6, out);
    this.burst(now + 0.01, 0.02, 2600, 1800, 3, 0.8, out);
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(3200, now);
    hp.frequency.exponentialRampToValueAtTime(1600, now + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.5, now + 0.04);
    g.gain.setTargetAtTime(0.0001, now + 0.2, 0.45);
    src.connect(hp).connect(g).connect(out);
    src.start(now, 0, 2);
    this.burst(now + 0.25, 0.8, 700, 450, 4, 0.25, out);
    if (this.clanks.length) {
      const c = ctx.createBufferSource();
      c.buffer = this.any(this.clanks);
      c.playbackRate.value = 1.2;
      const cg = ctx.createGain();
      cg.gain.value = 0.4;
      c.connect(cg).connect(out);
      c.start(now + 1.05);
    }
  }

  /**
   * The thing from the tank: small, wet, in pain. A ragged gasp, a thin mewling
   * cry that cracks and wavers, or a wet rattle in its chest.
   */
  specimenVoice(kind: 'gasp' | 'mewl' | 'rattle' | 'gurgle' | 'whimper' | 'retch' | 'shriek', level: number, pan: number, muffled = false) {
    const ctx = this.ctx;
    if (!ctx || level < 0.005) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    let out: AudioNode = p;
    if (muffled) {
      // through a wall: dull and close-mouthed
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 750;
      p.connect(lp).connect(this.master);
      out = lp;
    } else p.connect(this.master);
    const send = this.roomSend();
    if (send) out.connect(send);
    const play = (bank: Buf[], rate: number, gain: number, at = now) => {
      if (!bank.length) return;
      const src = ctx.createBufferSource();
      src.buffer = this.any(bank);
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(p);
      src.start(at);
    };
    if (kind === 'gurgle') {
      // a breath drawn through fluid: a wet rattle and a run of bubbles bursting in its throat
      play(this.gargles, 1.1 + Math.random() * 0.2, level * 1.2);
      let t = now + 0.05;
      const end = now + 0.5 + Math.random() * 0.5;
      while (t < end) {
        const f = 380 + Math.random() * 500;
        this.burst(t, 0.03 + Math.random() * 0.04, f, f * 0.5, 7, level * 0.35 * (0.4 + Math.random() * 0.6), p);
        t += 0.025 + Math.random() * 0.06;
      }
      this.cry(now + 0.1, 210 + Math.random() * 40, 0.5, 0.6, level * 0.5, p);
      return;
    }
    if (kind === 'whimper') {
      // short broken cries, each higher and more desperate than the last
      const n = 2 + Math.floor(Math.random() * 3);
      let t = now;
      for (let i = 0; i < n; i++) {
        const d = 0.14 + Math.random() * 0.14;
        this.cry(t, 520 + i * 70 + Math.random() * 90, d, 0.35, level * (0.7 + i * 0.12), p);
        play(this.inhales, 1.8 + Math.random() * 0.3, level * 0.5, t + d);
        t += d + 0.12 + Math.random() * 0.12;
      }
      return;
    }
    if (kind === 'retch') {
      // it heaves: two dry, choking hurks, then fluid coming up and spattering
      for (let i = 0; i < 2; i++) {
        const t = now + i * 0.32;
        this.cry(t, 120 + Math.random() * 30, 0.2, 1, level * 0.9, p);
        this.burst(t, 0.18, 900, 260, 1.4, level * 0.45, p);
        this.burst(t + 0.02, 0.02, 2400, 1600, 4, level * 0.3, p);
      }
      play(this.gargles, 0.9, level * 1.3, now + 0.62);
      if (this.sprays.length) {
        const src = ctx.createBufferSource();
        src.buffer = this.any(this.sprays);
        src.playbackRate.value = 0.8;
        const g = ctx.createGain();
        g.gain.setValueAtTime(level * 0.6, now + 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        src.connect(g).connect(p);
        src.start(now + 0.7, 0, 0.6);
      }
      for (let i = 0; i < 6; i++) this.burst(now + 0.75 + i * (0.04 + Math.random() * 0.06), 0.03, 1400, 500, 5, level * 0.3, p);
      return;
    }
    if (kind === 'shriek') {
      // a scream of pain that tears and breaks off into sobbing breaths
      const d = 0.6 + Math.random() * 0.3;
      this.cry(now, 780 + Math.random() * 200, d, 0.8, level * 1.2, p, 1.6);
      play(this.inhales, 1.6, level * 0.9, now + d + 0.05);
      this.cry(now + d + 0.3, 520, 0.22, 0.5, level * 0.5, p);
      return;
    }
    if (kind === 'gasp') play(this.inhales, 1.5 + Math.random() * 0.2, level * 1.4);
    else if (kind === 'rattle') play(this.gargles, 1.45 + Math.random() * 0.2, level * 1.1);
    else {
      // a thin cry, wavering and breaking
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const f = 620 + Math.random() * 160;
      const d = 0.45 + Math.random() * 0.4;
      o.frequency.setValueAtTime(f, now);
      o.frequency.linearRampToValueAtTime(f * 1.45, now + d * 0.35);
      o.frequency.linearRampToValueAtTime(f * 0.8, now + d);
      const vib = ctx.createOscillator();
      vib.frequency.value = 6 + Math.random() * 3;
      const vg = ctx.createGain();
      vg.gain.value = f * 0.04;
      vib.connect(vg).connect(o.frequency);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1300;
      bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(level * 0.12, now + 0.05);
      // it cracks: a stutter in the middle
      g.gain.setValueAtTime(level * 0.12, now + d * 0.5);
      g.gain.linearRampToValueAtTime(level * 0.02, now + d * 0.55);
      g.gain.linearRampToValueAtTime(level * 0.1, now + d * 0.62);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d);
      o.connect(bp).connect(g).connect(p);
      o.start(now);
      vib.start(now);
      o.stop(now + d + 0.05);
      vib.stop(now + d + 0.05);
      play(this.exhales, 1.55, level * 0.7, now + 0.02);
    }
  }

  /**
   * A small, cracked voice: a buzzing source (a sawtooth with a little
   * irregular wobble for a ragged throat) through two vocal formants, its
   * pitch jumping up as it strains and sagging as it breaks. `rough` adds the
   * rasp; `rise` is how far it climbs.
   */
  private cry(at: number, f: number, d: number, rough: number, level: number, to: AudioNode, rise = 1.35) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, at);
    o.frequency.linearRampToValueAtTime(f * rise, at + d * 0.3);
    o.frequency.setValueAtTime(f * rise * 0.82, at + d * 0.55);
    o.frequency.linearRampToValueAtTime(f * 0.7, at + d);
    // the rasp: a fast, uneven wobble in pitch and loudness
    const jit = ctx.createOscillator();
    jit.type = 'square';
    jit.frequency.value = 23 + Math.random() * 14;
    const jg = ctx.createGain();
    jg.gain.value = f * 0.06 * rough;
    jit.connect(jg).connect(o.frequency);
    const am = ctx.createGain();
    am.gain.value = 1 - rough * 0.35;
    const ag = ctx.createGain();
    ag.gain.value = rough * 0.35;
    jit.connect(ag).connect(am.gain);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, at);
    out.gain.exponentialRampToValueAtTime(level * 0.09, at + 0.03);
    out.gain.setValueAtTime(level * 0.09, at + d * 0.5);
    out.gain.linearRampToValueAtTime(level * 0.015, at + d * 0.56);
    out.gain.linearRampToValueAtTime(level * 0.07, at + d * 0.64);
    out.gain.exponentialRampToValueAtTime(0.0001, at + d);
    for (const [ff, q, g] of [
      [900, 3, 1],
      [2300, 5, 0.5],
    ]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = ff * (0.9 + Math.random() * 0.2);
      bp.Q.value = q;
      const bg = ctx.createGain();
      bg.gain.value = g;
      o.connect(bp).connect(bg).connect(am);
    }
    am.connect(out).connect(to);
    this.burst(at, d, 2400, 1600, 1.2, level * 0.05 * (0.5 + rough), out);
    o.start(at);
    jit.start(at);
    o.stop(at + d + 0.05);
    jit.stop(at + d + 0.05);
  }

  /**
   * The creature's own voice as it dies: heard from inside its head, past the
   * blast's deafness. A scream that tears and breaks; a short cry; sobbing,
   * catching breaths; a ragged gasp; a wet gurgle as blood gets into its
   * throat; and the last rattling breath.
   */
  agony(kind: 'scream' | 'cry' | 'sob' | 'gasp' | 'gurgle' | 'rattle', level: number) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.out);
    const play = (bank: Buf[], rate: number, gain: number, at = now, dur?: number) => {
      if (!bank.length) return;
      const src = ctx.createBufferSource();
      src.buffer = this.any(bank);
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(out);
      src.start(at, 0, dur);
    };
    if (kind === 'scream') {
      const d = 1.0 + Math.random() * 0.45;
      this.cry(now, 290 + Math.random() * 90, d, 0.95, level * 1.7, out, 1.6 + Math.random() * 0.3);
      // two voices a little apart: the throat tearing
      this.cry(now + 0.02, 450 + Math.random() * 60, d * 0.9, 1, level * 0.6, out, 1.5);
      play(this.inhales, 1.15, level * 1.2, now + d + 0.05);
    } else if (kind === 'cry') {
      const d = 0.4 + Math.random() * 0.3;
      this.cry(now, 320 + Math.random() * 80, d, 0.7, level * 1.1, out, 1.3);
      play(this.inhales, 1.25, level * 0.8, now + d);
    } else if (kind === 'sob') {
      // breath catching in its throat, over and over
      let t = now;
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        play(this.inhales, 1.4 + Math.random() * 0.3, level * 0.7, t, 0.18);
        if (i % 2) this.cry(t + 0.12, 300 + Math.random() * 60, 0.18, 0.6, level * 0.6, out, 1.2);
        t += 0.17 + Math.random() * 0.1;
      }
      play(this.exhales, 1.1, level * 0.7, t);
    } else if (kind === 'gasp') {
      play(this.inhales, 1.0 + Math.random() * 0.2, level * 1.2);
      play(this.exhales, 1.0, level * 0.7, now + 0.45);
    } else if (kind === 'gurgle') {
      play(this.gargles, 0.85 + Math.random() * 0.15, level * 1.1);
      let t = now + 0.05;
      while (t < now + 0.6) {
        const f = 300 + Math.random() * 400;
        this.burst(t, 0.04, f, f * 0.5, 7, level * 0.25, out);
        t += 0.03 + Math.random() * 0.06;
      }
      this.cry(now + 0.1, 170, 0.45, 0.8, level * 0.4, out, 1.1);
    } else {
      // the last breath: long, slow and wet, and nothing after it
      play(this.gargles, 0.62, level * 1.1, now, 1.6);
      play(this.exhales, 0.7, level * 0.9, now + 0.1);
    }
  }

  /** A wet slap: its hand smacking down, or its body flopping onto the deck or the sand; `crack` adds a joint popping. */
  specimenSlap(level: number, pan: number, metal: boolean, crack = false) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master);
    const r = this.roomBus();
    if (r && this.indoor > 0.5) p.connect(r.echo);
    // the smack of wet skin, and the squelch after it
    this.burst(now, 0.035, 2200, 900, 1.6, level * 0.7, p);
    this.tone(now, metal ? 140 : 90, 0.07, level * 0.5, p);
    this.burst(now + 0.03, 0.12, 700, 1500, 3, level * 0.25, p);
    if (metal) this.burst(now + 0.005, 0.05, 3200, 2600, 6, level * 0.2, p);
    if (crack) {
      // a knuckle or a rib giving: two sharp dry clicks
      this.burst(now + 0.05, 0.006, 5200, 4200, 6, level * 0.8, p);
      this.burst(now + 0.075, 0.005, 3800, 3000, 6, level * 0.6, p);
    }
  }

  /** It hauls itself along: a wet scrape over the deck, or a drag through the sand. */
  specimenDrag(level: number, pan: number, metal: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.white || level < 0.005) return;
    const now = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(this.master);
    if (metal) {
      this.burst(now, 0.25, 2600, 1500, 1.5, level * 0.3, p);
      this.burst(now + 0.02, 0.06, 900, 500, 3, level * 0.25, p);
      if (this.metalSteps.length) {
        const src = ctx.createBufferSource();
        src.buffer = this.any(this.metalSteps);
        src.playbackRate.value = 1.7;
        const g = ctx.createGain();
        g.gain.value = level * 0.25;
        src.connect(g).connect(p);
        src.start(now);
      }
    } else if (this.sprays.length) {
      const src = ctx.createBufferSource();
      src.buffer = this.any(this.sprays);
      src.playbackRate.value = 0.6;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(level * 0.5, now + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      src.connect(lp).connect(g).connect(p);
      src.start(now, 0, 0.5);
    }
  }

  /** The highlands come into view: a wide, open chord, slowly swelling. */
  vista() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.13, now + 3.2);
    out.gain.setValueAtTime(0.13, now + 5);
    out.gain.linearRampToValueAtTime(0.0001, now + 11);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, now);
    lp.frequency.linearRampToValueAtTime(1500, now + 3.6);
    lp.frequency.linearRampToValueAtTime(400, now + 11);
    lp.connect(out).connect(this.master);
    out.connect(this.reverbSend);
    // open fifths on D, stacked wide, the top voices a hair apart so they shimmer
    for (const [f, type, g] of [
      [73.42, 'triangle', 0.5],
      [110, 'sine', 0.4],
      [146.83, 'triangle', 0.26],
      [220, 'sine', 0.2],
      [220.6, 'sine', 0.14],
      [329.63, 'sine', 0.09],
      [440.9, 'sine', 0.04],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(now);
      o.stop(now + 11.5);
    }
  }

  stinger() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.22, now + 2.6);
    out.gain.setValueAtTime(0.22, now + 4.2);
    out.gain.linearRampToValueAtTime(0.0001, now + 8.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260, now);
    lp.frequency.linearRampToValueAtTime(900, now + 3);
    lp.frequency.linearRampToValueAtTime(300, now + 8.5);
    lp.connect(out).connect(this.master);
    out.connect(this.reverbSend);
    // a hollow fifth with a slow beating third partial
    for (const [f, type, g] of [
      [55, 'triangle', 0.6],
      [82.4, 'sine', 0.45],
      [110.7, 'triangle', 0.25],
      [164.2, 'sine', 0.12],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(now);
      o.stop(now + 9);
    }
  }

  // ------------------------------------------------------- dying stranger

  private buildStranger(ctx: AudioContext) {
    const sr = ctx.sampleRate;
    const mono = (d: Float32Array) => {
      const b = ctx.createBuffer(1, d.length, sr);
      b.getChannelData(0).set(d);
      return b;
    };
    // the voices take a while to synthesise: build them in a worker so the game never
    // stalls (they are not needed until the stranger is reached)
    const take = (v: Voices) => {
      this.gargles = v.gargles.map(mono);
      this.inhales = v.inhales.map(mono);
      this.exhales = v.exhales.map(mono);
      this.notes = v.notes.map((takes) => takes.map(mono));
      this.padVoices = v.pads.map(mono);
      this.songVoices = v.songs.map(mono);
    };
    try {
      const worker = new Worker(new URL('./voiceWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<Voices>) => {
        take(e.data);
        worker.terminate();
      };
      worker.onerror = () => {
        worker.terminate();
        buildVoicesSliced(sr, take);
      };
      worker.postMessage({ sr });
    } catch {
      buildVoicesSliced(sr, take);
    }

    this.strangerBus = ctx.createGain();
    this.strangerBus.gain.value = 0;
    this.strangerPan = ctx.createStereoPanner();
    this.strangerLow = ctx.createBiquadFilter();
    this.strangerLow.type = 'lowpass';
    this.strangerLow.frequency.value = 800;
    this.strangerBus.connect(this.strangerPan).connect(this.strangerLow).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.7;
    this.strangerLow.connect(send).connect(this.reverbSend);
  }

  /** Place the listener relative to the stranger: 0..1 loudness, -1..1 pan, 0..1 clarity. */
  setStranger(level: number, pan: number, clarity: number) {
    const ctx = this.ctx;
    if (!ctx || !this.strangerBus) return;
    const now = ctx.currentTime;
    this.strangerBus.gain.setTargetAtTime(level, now, 0.15);
    this.strangerPan.pan.setTargetAtTime(pan, now, 0.15);
    this.strangerLow.frequency.setTargetAtTime(600 * Math.pow(30, clarity), now, 0.15);
  }

  /** Lower (or restore) the wind and the wreck, so a close moment can be heard. */
  duck(level: number) {
    this.envLevel = level;
    const ctx = this.ctx;
    if (!ctx) return;
    for (const n of this.sites) n.bus.gain.setTargetAtTime(n.level * level, ctx.currentTime, 0.4);
    if (this.high) this.high.bus.gain.setTargetAtTime(this.high.level * level, ctx.currentTime, 0.4);
  }

  private playStranger(buf: Buf | undefined, level: number, rate = 1, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.strangerBus || !buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(this.strangerBus);
    src.start(ctx.currentTime + delay);
  }

  /** One laboured breath: a wet rattling inhale, or a weak exhale. */
  strangerBreath(level: number, inhale: boolean) {
    const bank = inhale ? this.inhales : this.exhales;
    this.playStranger(bank[Math.floor(Math.random() * bank.length)], level, 0.94 + Math.random() * 0.12);
  }

  /** A gargled, static-laced cry of pain. */
  strangerGargle(level: number) {
    this.playStranger(this.any(this.gargles), level);
  }

  /**
   * The survivor singing a note at `f` Hz: the same clear, humming voice as the
   * tracker's songs, soft and unsteady, muffled when there is a wall between.
   */
  survivorNote(f: number, seconds: number, level: number, pan: number, muffled = false) {
    const ctx = this.ctx;
    if (!ctx || !this.songVoices.length || level < 0.003) return;
    let k = 0;
    for (let i = 1; i < SONG_TONES.length; i++) if (Math.abs(Math.log(f / SONG_TONES[i])) < Math.abs(Math.log(f / SONG_TONES[k]))) k = i;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.songVoices[k];
    src.playbackRate.setValueAtTime(f / SONG_TONES[k], now);
    // a voice that shakes
    for (let t = 0.1; t < seconds + 0.6; t += 0.09) src.playbackRate.linearRampToValueAtTime((f / SONG_TONES[k]) * (1 + (Math.random() - 0.5) * 0.012), now + t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, now);
    g.gain.setValueAtTime(level, now + seconds);
    g.gain.setTargetAtTime(0.0001, now + seconds, 0.3);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p);
    let out: AudioNode = p;
    if (muffled) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      p.connect(lp);
      out = lp;
    }
    out.connect(this.master);
    const send = this.roomSend();
    if (send) out.connect(send);
    src.start(now);
    src.stop(now + seconds + 2);
  }

  /** One raspy note: `tone` indexes TONES (see story/tune.ts). */
  strangerNote(tone: number, level: number) {
    const v = this.notes[tone];
    if (!v) return;
    this.playStranger(v[Math.floor(Math.random() * v.length)], level);
  }

  /**
   * One of the stranger's notes heard from far off, carried on the wind:
   * muffled, faint, and mostly echo.
   */
  strangerFar(tone: number, level: number) {
    const ctx = this.ctx;
    const v = this.notes[tone];
    if (!ctx || !v || !v.length) return;
    const src = ctx.createBufferSource();
    src.buffer = v[0];
    src.playbackRate.value = 0.985;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const g = ctx.createGain();
    g.gain.value = level;
    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.5;
    src.connect(lp).connect(g).connect(pan).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 2.2;
    pan.connect(send).connect(this.reverbSend);
    src.start();
  }

  /** A low, sad swell when the stranger is first seen. */
  sorrow() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.linearRampToValueAtTime(0.16, now + 2.2);
    out.gain.setValueAtTime(0.16, now + 3.5);
    out.gain.linearRampToValueAtTime(0.0001, now + 8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(240, now);
    lp.frequency.linearRampToValueAtTime(760, now + 2.6);
    lp.frequency.linearRampToValueAtTime(260, now + 8);
    lp.connect(out).connect(this.master);
    out.connect(this.reverbSend);
    // a minor triad, low, its third slowly beating against a detuned twin
    for (const [f, type, g] of [
      [55, 'triangle', 0.55],
      [65.4, 'sine', 0.4],
      [65.9, 'sine', 0.25],
      [82.4, 'triangle', 0.3],
      [130.8, 'sine', 0.1],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(now);
      o.stop(now + 8.5);
    }
  }

  /** Stamina sounds: faint wheezes before running out, a deep gasp when it does. */
  cue(kind: StaminaCue) {
    if (!this.ctx) return;
    if (kind === 'warn') this.gasp(this.gasps, 0.07, 0);
    else if (kind === 'warn-late') this.gasp(this.gasps, 0.1, 0);
    else {
      this.gasp(this.deepGasps, 0.2, 0);
      this.gasp(this.deepGasps, 0.12, 0.9);
    }
  }

  /** A gasp for scripted moments. */
  wakeGasp(level: number, deep = true) {
    this.gasp(deep ? this.deepGasps : this.gasps, level, 0);
  }

  private gasp(bank: Buf[], level: number, delay: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = bank[Math.floor(Math.random() * bank.length)];
    src.playbackRate.value = 0.94 + Math.random() * 0.14;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 280;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(hp).connect(g).connect(this.master);
    g.connect(this.reverbSend);
    src.start(ctx.currentTime + delay);
  }

  /** Build some of the sound still waiting, a few milliseconds' worth per frame. */
  private pump() {
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < 4) this.jobs.shift()!();
  }

  /** A random buffer from a bank, or silence if the bank is not built yet. */
  private any(bank: Buf[]): Buf {
    return bank.length ? bank[Math.floor(Math.random() * bank.length)] : this.silence;
  }

  update(dt: number, wind: Wind, breath: { value: number; exertion: number; wheeze: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.pump();
    if (!this.windReady) return;
    this.time += dt;
    const now = ctx.currentTime;
    const t = this.time;
    const s = wind.strength;
    const f = wind.flutter;
    const tc = 0.08;
    this.windGain.gain.setTargetAtTime(this.envLevel, now, 0.25);

    this.whooshGain.gain.setTargetAtTime(0.17 + s * s * 0.6 + f * 0.04, now, tc);
    this.whoosh.frequency.setTargetAtTime(260 + s * 900 + f * 120, now, tc);
    this.whooshPan.pan.setTargetAtTime(noise1(t * 0.13, 61) * 0.5, now, 0.3);
    this.rumbleGain.gain.setTargetAtTime(0.28 + s * 0.55, now, tc);
    this.rumble.frequency.setTargetAtTime(110 + s * 180, now, tc);

    for (const w of this.whistles) {
      const drift = noise1(t * 0.09, w.seed) * 0.12 + noise1(t * 0.6, w.seed + 1) * 0.03;
      w.filter.frequency.setTargetAtTime(w.base * (1 + drift + s * 0.35), now, 0.12);
      const g = clamp((s - 0.35) * 1.6, 0, 1) * (0.5 + 0.5 * noise1(t * 0.35, w.seed + 2));
      w.gain.gain.setTargetAtTime(g * g * 0.22, now, 0.25);
    }

    const grain = clamp(s - 0.2, 0, 1);
    const shimmer = 0.6 + 0.4 * noise1(t * 7, 77);
    this.hissGain.gain.setTargetAtTime(grain * grain * 0.28 * shimmer, now, 0.04);
    this.hissPan.pan.setTargetAtTime(noise1(t * 0.21, 88) * 0.7, now, 0.2);

    // breathing: louder and lower on the exhale
    const e = breath.exertion;
    const b = breath.value;
    const level = Math.pow(clamp((e - 0.12) / 0.88, 0, 1), 1.3);
    const env = b < 0 ? -b * 1.0 : b * 0.55;
    this.breathGain.gain.setTargetAtTime(level * env * env * 0.16, now, 0.03);
    this.breathFilter.frequency.setTargetAtTime(b < 0 ? 850 : 1500, now, 0.06);
    // the whistle is strongest on the inhale
    const inhale = b > 0 ? b : 0;
    this.wheezeGain.gain.setTargetAtTime(breath.wheeze * level * inhale * inhale * 0.05, now, 0.04);
    this.wheezeFilter.frequency.setTargetAtTime(1550 + noise1(t * 0.9, 99) * 160 + inhale * 220, now, 0.05);
  }

  /** A long scrape of hooves digging into the sand. */
  scuff(amount: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.any(this.sprays);
    src.playbackRate.value = 0.55 + Math.random() * 0.15;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.value = 0.35 * amount;
    src.connect(lp).connect(g).connect(this.master);
    g.connect(this.reverbSend);
    src.start(now);
  }

  step(ev: StepEvent) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.indoor > 0.5) {
      this.metalStep(ev);
      return;
    }
    const now = ctx.currentTime;
    const heavy = ev.run > 0.5;
    const bank = heavy ? this.heavySteps : this.steps;
    const buf = bank[Math.floor(Math.random() * bank.length)];

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (heavy ? 0.92 : 1) * (0.9 + Math.random() * 0.22) * lerp(1, 0.86, ev.crouch);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lerp(lerp(3800, 4600, ev.run), 1500, ev.crouch);
    const gain = ctx.createGain();
    // louder with speed, but a sprint only a little louder than a walk
    const pace = 0.25 + Math.min(ev.speed, 2) * 0.07 + Math.max(0, ev.speed - 2) * 0.012;
    const loud = ev.scuff ? 0.11 : pace * lerp(1, 0.45, ev.crouch);
    gain.gain.value = loud * (0.85 + Math.random() * 0.3);
    const pan = ctx.createStereoPanner();
    pan.pan.value = ev.side * 0.12;
    src.connect(lp).connect(gain).connect(pan);
    pan.connect(this.master);
    pan.connect(this.reverbSend);
    src.start(now);

    if (ev.run > 0.2 || ev.scuff) {
      const sp = ctx.createBufferSource();
      sp.buffer = this.any(this.sprays);
      sp.playbackRate.value = 0.85 + Math.random() * 0.4;
      const g = ctx.createGain();
      g.gain.value = ev.scuff ? 0.05 : ev.run * 0.07 * (0.7 + Math.random() * 0.6);
      const soft = ctx.createBiquadFilter();
      soft.type = 'lowpass';
      soft.frequency.value = 4500;
      const p = ctx.createStereoPanner();
      p.pan.value = ev.side * 0.2;
      sp.connect(soft).connect(g).connect(p).connect(this.master);
      sp.start(now + 0.012);
    }
  }
}
