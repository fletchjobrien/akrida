import { clamp, lerp, noise1, rng } from '../core/math';
import type { StepEvent } from '../character/Creature';
import type { Wind } from '../world/wind';

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
    const env = Math.exp(-t / (0.05 + heavy * 0.03));
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
  const lpA = 1 - Math.exp((-2 * Math.PI * (3000 + heavy * 1500)) / sr);
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
    d[i] += Math.sin(phase) * env * (0.45 + heavy * 0.35);
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

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverbSend!: GainNode;
  private steps: Buf[] = [];
  private heavySteps: Buf[] = [];
  private sprays: Buf[] = [];
  private time = 0;

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

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(1.15, ctx.currentTime, 1.2);
    this.master.connect(comp);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulseResponse(ctx, 2.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.18;
    this.reverbSend.connect(reverb);
    reverb.connect(this.master);

    this.buildWind(ctx);
    this.buildBreath(ctx);

    for (let i = 0; i < 10; i++) this.steps.push(stepBuffer(ctx, i, 0));
    for (let i = 0; i < 8; i++) this.heavySteps.push(stepBuffer(ctx, 100 + i, 1));
    for (let i = 0; i < 6; i++) this.sprays.push(sprayBuffer(ctx, i));

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

  private buildWind(ctx: AudioContext) {
    const white = noiseBuffer(ctx, 7.3, 'white', 1);
    const pink = noiseBuffer(ctx, 9.1, 'pink', 2);
    const brown = noiseBuffer(ctx, 11.7, 'brown', 3);

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
    this.loop(ctx, pink).connect(this.breathFilter);
    this.breathFilter.connect(this.breathGain).connect(this.master);
  }

  update(dt: number, wind: Wind, breath: { value: number; exertion: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.time += dt;
    const now = ctx.currentTime;
    const t = this.time;
    const s = wind.strength;
    const f = wind.flutter;
    const tc = 0.08;

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
  }

  /** A long scrape of hooves digging into the sand. */
  scuff(amount: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.sprays[Math.floor(Math.random() * this.sprays.length)];
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
    lp.frequency.value = lerp(lerp(3800, 7000, ev.run), 1500, ev.crouch);
    const gain = ctx.createGain();
    const loud = ev.scuff ? 0.11 : clamp(0.22 + ev.speed * 0.09, 0.2, 0.75) * lerp(1, 0.45, ev.crouch);
    gain.gain.value = loud * (0.85 + Math.random() * 0.3);
    const pan = ctx.createStereoPanner();
    pan.pan.value = ev.side * 0.12;
    src.connect(lp).connect(gain).connect(pan);
    pan.connect(this.master);
    pan.connect(this.reverbSend);
    src.start(now);

    if (ev.run > 0.2 || ev.scuff) {
      const sp = ctx.createBufferSource();
      sp.buffer = this.sprays[Math.floor(Math.random() * this.sprays.length)];
      sp.playbackRate.value = 0.85 + Math.random() * 0.4;
      const g = ctx.createGain();
      g.gain.value = ev.scuff ? 0.05 : ev.run * 0.22 * (0.7 + Math.random() * 0.6);
      const p = ctx.createStereoPanner();
      p.pan.value = ev.side * 0.2;
      sp.connect(g).connect(p).connect(this.master);
      sp.start(now + 0.012);
    }
  }
}
