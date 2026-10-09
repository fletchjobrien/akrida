import { Vector2 } from 'three';

/**
 * Decides when the wreck turns up: once the player has wandered a little and
 * then held one heading for a while, it is placed just out of sight ahead of
 * them, so they walk straight into its trench.
 */
export class SiteSpawner {
  /** Smoothed direction of travel (unit, on the ground: x, z). */
  readonly heading = new Vector2(1, 0);
  /** Total distance walked. */
  travelled = 0;
  /** Distance walked without straying from the heading. */
  straight = 0;
  done = false;
  private hasHeading = false;

  /** Walk this far in total before it can appear... */
  static readonly MIN_WANDER = 25;
  /** ...then this far in one direction. */
  static readonly STRAIGHT = 18;
  /** Or, failing that, after this much aimless wandering. */
  static readonly FALLBACK = 140;

  /** Returns true on the frame the site should appear. */
  update(dt: number, vx: number, vz: number): boolean {
    if (this.done) return false;
    const sp = Math.hypot(vx, vz);
    if (sp > 0.4) {
      const dx = vx / sp;
      const dz = vz / sp;
      if (!this.hasHeading) {
        this.heading.set(dx, dz);
        this.hasHeading = true;
      }
      // follow the direction of travel slowly, so wiggles don't count as turns
      const k = 1 - Math.exp(-dt / 3);
      this.heading.x += (dx - this.heading.x) * k;
      this.heading.y += (dz - this.heading.y) * k;
      this.heading.normalize();
      const along = dx * this.heading.x + dz * this.heading.y;
      if (along > 0.85) this.straight += sp * dt;
      else this.straight = Math.max(0, this.straight - sp * dt * 3);
      this.travelled += sp * dt;
    }
    const ready =
      (this.travelled > SiteSpawner.MIN_WANDER && this.straight > SiteSpawner.STRAIGHT) ||
      this.travelled > SiteSpawner.FALLBACK;
    if (ready) this.done = true;
    return ready;
  }
}
