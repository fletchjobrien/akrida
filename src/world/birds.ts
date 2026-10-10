import { BoxGeometry, Group, Mesh, Object3D, Vector3 } from 'three';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { HIGH } from './highlands';
import { terrainHeight } from './terrain';
import type { AudioEngine } from '../audio/AudioEngine';

interface Bird {
  root: Group;
  /** Inner and outer wing on each side: the outer folds further. */
  wings: [Group, Group, Group, Group];
  angle: number;
  radius: number;
  speed: number;
  height: number;
  /** Flapping: how many beats are left, and where in the beat it is. */
  beats: number;
  phase: number;
  glide: number;
  bob: number;
}

/**
 * Carrion birds, drawn by the dead: three of them circling slowly over the
 * station on the rising air, mostly gliding on stiff, slightly raised wings,
 * banking into the turn, now and then beating a few times. Their shadows
 * sweep over the ground. Now and then one cries, a thin falling call that
 * echoes off the rock.
 */
export class Birds {
  private readonly birds: Bird[] = [];
  private cryTimer = 6;
  private readonly tmp = new Vector3();

  constructor(private readonly audio: AudioEngine) {
    const mat = toonMaterial({ dark: 0x1a1616, mid: 0x2a2422, light: 0x483e38, litAt: 0.5, outline: 0.6, highlight: 0.3 });
    const box = (w: number, h: number, d: number, parent: Object3D, x: number, y: number, z: number) => {
      const m = new Mesh(new BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.layers.enable(SHADOW_LAYER);
      parent.add(m);
      return m;
    };
    for (let i = 0; i < 3; i++) {
      const root = new Group();
      // body along +z (the way it flies), a hooked head, a fanned tail
      box(0.16, 0.13, 0.62, root, 0, 0, 0);
      box(0.1, 0.1, 0.16, root, 0, 0.03, 0.38);
      box(0.04, 0.05, 0.08, root, 0, 0, 0.48);
      const tail = box(0.26, 0.03, 0.22, root, 0, 0, -0.38);
      tail.rotation.x = -0.1;
      const wings: Group[] = [];
      for (const side of [-1, 1]) {
        const inner = new Group();
        inner.position.set(side * 0.07, 0.03, 0.04);
        root.add(inner);
        box(0.5, 0.025, 0.3, inner, side * 0.25, 0, 0);
        const outer = new Group();
        outer.position.set(side * 0.5, 0, 0);
        inner.add(outer);
        // the hand, swept back, its tip feathers spread
        const hand = box(0.48, 0.02, 0.22, outer, side * 0.24, 0, -0.04);
        hand.rotation.y = side * 0.18;
        for (let f = 0; f < 3; f++) box(0.14, 0.015, 0.04, outer, side * (0.52 + f * 0.02), 0, -0.1 + f * 0.06);
        wings.push(inner, outer);
      }
      this.birds.push({
        root,
        wings: [wings[0], wings[1], wings[2], wings[3]],
        angle: i * 2.1,
        radius: 9 + i * 3.5,
        speed: 3.4 + i * 0.4,
        height: 13 + i * 2.2,
        beats: 0,
        phase: 0,
        glide: 2 + i * 1.7,
        bob: i * 1.3,
      });
    }
  }

  addTo(scene: Object3D) {
    for (const b of this.birds) scene.add(b.root);
  }

  /** `dc` is how far the listener is from the station. */
  update(dt: number, listener: Vector3, dc: number) {
    const show = HIGH.on && dc < 260;
    const ground = HIGH.on ? terrainHeight(HIGH.x, HIGH.z) : 0;
    for (const [i, b] of this.birds.entries()) {
      b.root.visible = show;
      if (!show) continue;
      // round and round, the circles drifting a little over the ridge
      b.angle += (b.speed / b.radius) * dt * (i === 1 ? -1 : 1);
      const cx = HIGH.x + Math.sin(b.angle * 0.13 + i) * 3;
      const cz = HIGH.z + Math.cos(b.angle * 0.11 + i * 2) * 3 - 2;
      b.bob += dt;
      const x = cx + Math.cos(b.angle) * b.radius;
      const z = cz + Math.sin(b.angle) * b.radius;
      const y = ground + b.height + Math.sin(b.bob * 0.4) * 0.8;
      b.root.position.set(x, y, z);
      // facing along the circle, banked into it
      const dir = i === 1 ? -1 : 1;
      this.tmp.set(-Math.sin(b.angle) * dir, 0, Math.cos(b.angle) * dir);
      b.root.rotation.set(0, Math.atan2(this.tmp.x, this.tmp.z), 0, 'YXZ');
      b.root.rotation.z = -0.38 * dir;
      // glide, then a few slow beats
      let lift: number;
      let fold: number;
      if (b.beats > 0) {
        b.phase += dt * 3.2 * Math.PI * 2;
        if (b.phase > Math.PI * 2) {
          b.phase -= Math.PI * 2;
          b.beats--;
        }
        const s = Math.sin(b.phase);
        lift = s * 0.75;
        fold = Math.max(0, -s) * 0.6;
      } else {
        b.glide -= dt;
        if (b.glide <= 0) {
          b.beats = 2 + Math.floor(Math.random() * 3);
          b.phase = 0;
          b.glide = 4 + Math.random() * 7;
        }
        // stiff and a little raised, trembling in the air
        lift = 0.16 + Math.sin(b.bob * 7) * 0.02;
        fold = -0.08;
      }
      const [li, lo, ri, ro] = b.wings;
      li.rotation.z = -lift;
      lo.rotation.z = -fold - lift * 0.4;
      ri.rotation.z = lift;
      ro.rotation.z = fold + lift * 0.4;
    }
    if (!show || dc > 80) return;
    this.cryTimer -= dt;
    if (this.cryTimer <= 0) {
      this.cryTimer = 7 + Math.random() * 14;
      const b = this.birds[Math.floor(Math.random() * this.birds.length)];
      const d = b.root.position.distanceTo(listener);
      this.audio.birdCry(0.1 / (1 + d * 0.05), Math.max(-0.8, Math.min(0.8, (b.root.position.x - listener.x) / 20)));
    }
  }
}
