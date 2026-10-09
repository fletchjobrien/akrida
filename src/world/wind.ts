import { Vector2 } from 'three';
import { clamp, noise1, smoothstep } from '../core/math';

/**
 * One wind model drives everything: the sound, the blowing sand veils on the
 * ground, the sand streak particles and the cloud drift.
 */
export class Wind {
  /** 0..1 overall wind strength. */
  strength = 0.3;
  /** Short-term turbulence, -1..1, for flutter. */
  flutter = 0;
  readonly dir = new Vector2(-0.963, -0.27);
  /** Integrated sand travel distance, for scrolling patterns. */
  travel = 0;
  private time = 0;
  private gust = 0;
  private gustStart = 6;
  private gustRise = 2;
  private gustHold = 2;
  private gustFall = 4;
  private gustPeak = 0.45;

  update(dt: number) {
    this.time += dt;
    const t = this.time;

    const ge = t - this.gustStart;
    if (ge > this.gustRise + this.gustHold + this.gustFall) {
      this.gustStart = t + 4 + Math.random() * 10;
      this.gustRise = 1.2 + Math.random() * 2.5;
      this.gustHold = 0.5 + Math.random() * 3;
      this.gustFall = 2.5 + Math.random() * 4;
      this.gustPeak = 0.25 + Math.random() * 0.45;
    }
    let g = 0;
    if (ge > 0) {
      if (ge < this.gustRise) g = smoothstep(0, this.gustRise, ge);
      else if (ge < this.gustRise + this.gustHold) g = 1;
      else g = 1 - smoothstep(0, this.gustFall, ge - this.gustRise - this.gustHold);
    }
    this.gust = g * this.gustPeak;

    const base = 0.26 + noise1(t * 0.045, 1) * 0.1 + noise1(t * 0.17, 2) * 0.05;
    this.flutter = noise1(t * 2.3, 3) * 0.6 + noise1(t * 5.1, 4) * 0.4;
    this.strength = clamp(base + this.gust + this.flutter * 0.04 * (0.4 + this.gust), 0, 1);

    const a = Math.atan2(-0.27, -0.963) + noise1(t * 0.02, 5) * 0.18;
    this.dir.set(Math.cos(a), Math.sin(a));
    this.travel += dt * (0.6 + this.strength * 3.2);
  }
}
