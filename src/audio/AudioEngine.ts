import { clamp, lerp, noise1, rng } from '../core/math';
import type { StaminaCue, StepEvent } from '../character/Creature';
import type { Wind } from '../world/wind';
import { buildVoicesSliced, type Voices } from './voice';
import { TONES } from '../story/tune';

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
export type SiteHum = 'power' | 'buzz' | 'fire';

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
  // the tracker: its own bus, a held chord for when it points true, and radio static
  private tracker: {
    bus: GainNode;
    pan: StereoPannerNode;
    low: BiquadFilterNode;
    hot: GainNode;
    fizz: GainNode | null;
  } | null = null;
  /** 0..1 multiplier on the surroundings (wind, the wreck), lowered for close moments. */
  private envLevel = 1;

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
    this.windGain.connect(this.master);
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
    // pointing true: a soft open fifth on G, two voices a hair apart on each note so it shimmers
    const hot = ctx.createGain();
    hot.gain.value = 0;
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 1500;
    warm.connect(hot).connect(bus);
    for (const [f, g] of [
      [196.0, 0.32],
      [196.45, 0.26],
      [293.66, 0.22],
      [294.2, 0.18],
      [392.0, 0.14],
      [783.99, 0.035],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(warm);
      o.start();
    }
    // a slow swell on the chord, like breath
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg).connect(warm.frequency);
    lfo.start();
    this.tracker = { bus, pan, low, hot, fizz: this.white ? this.trackerFizz(ctx, this.white, bus) : null };
    return this.tracker;
  }

  private trackerFizz(ctx: AudioContext, white: Buf, bus: GainNode) {
    const src = this.loop(ctx, white);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(bp).connect(g).connect(bus);
    return g;
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
    t.hot.gain.setTargetAtTime(hot * 0.075, now, 0.25);
    t.fizz?.gain.setTargetAtTime(fizz * 0.012, now, 0.2);
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
      this.trackerVoice(f, f, t, 0.006, 0.02, 1.1, level);
      this.trackerVoice(f * 2.76, f * 2.76, t, 0.004, 0.0, 0.35, level * 0.18);
    });
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

  /** One raspy note: `tone` indexes TONES (see story/tune.ts). */
  strangerNote(tone: number, level: number) {
    const v = this.notes[tone];
    if (!v) return;
    this.playStranger(v[Math.floor(Math.random() * v.length)], level);
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
