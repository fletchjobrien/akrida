import {
  BoxGeometry,
  Group,
  IcosahedronGeometry,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { noise1 } from '../core/math';
import { toonMaterial } from '../render/shared';
import { PALETTE, rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { terrainHeight } from '../world/terrain';
import { pushOutOfRock, type RockInfo } from '../world/rocks';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';

type State = 'feed' | 'alert' | 'flee' | 'dig' | 'gone';

interface Leg {
  hip: Group;
  side: number;
  /** Which of the two tripods it steps with. */
  set: number;
  hind: boolean;
}

interface Bug {
  root: Group;
  body: Group;
  head: Group;
  abdomen: Group;
  mand: Object3D[];
  ant: Object3D[];
  wings: Object3D[];
  legs: Leg[];
  state: State;
  t: number;
  /** Where it is (its feet), the way it faces, its height over the sand (on a body). */
  pos: Vector3;
  yaw: number;
  perch: number;
  home: number;
  delay: number;
  peck: number;
  peckT: number;
  chew: number;
  hopTimer: number;
  hop: { t: number; dur: number; h: number; from: number; to: number; vx: number; vz: number } | null;
  /** Scuttling over to another place on the dead: where to, how high it sits there, the way it set out from. */
  walk: { x: number; z: number; y: number; from: number; total: number; pause: number; burst: number } | null;
  heading: number;
  /** Which way it breaks when it runs. */
  side: number;
  speed: number;
  top: number;
  run: number;
  gait: number;
  zig: number;
  track: number;
  trackSide: number;
  puff: number;
  seed: number;
}

const COUNT = 14;
const SAND = rgb(PALETTE.sandMid).toArray();
const SAND_FADE = rgb(PALETTE.sandLit).toArray();
const SAND_DARK = rgb(PALETTE.sandShade).toArray();
const BITS = rgb(0x26303c).toArray();

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/**
 * Carrion locusts: a swarm of big alien hoppers, bronze and olive, with amber
 * compound eyes, folded veined wings and the great kinked hind legs of their
 * kind, crawling over the three dead and eating them. Heads jerk down, jaws
 * work, abdomens pulse; now and then one hops to a better place.
 *
 * When the creature comes near they freeze, turn to face it, wings half
 * lifting, and a dry rattle runs through them. Then they break: scuttling
 * away across the sand in every direction, zigzagging, hopping on buzzing
 * wings, leaving fine tracks and little puffs of sand. Each one, once clear,
 * stops, tips its head down and digs in, wriggling under in a spray of sand,
 * and is gone, leaving a small churned mound with a hole in it.
 *
 * Long after the creature has gone, they come back.
 */
export class Locusts {
  readonly group = new Group();
  private readonly bugs: Bug[] = [];
  private readonly tracks: InstancedMesh;
  private readonly mounds: InstancedMesh;
  private readonly holes: InstancedMesh;
  private readonly spoil: InstancedMesh;
  private trackN = 0;
  private moundN = 0;
  private readonly center = new Vector3();
  private noticed = false;
  private awayTime = 0;
  private chewTimer = 0;
  private chitterTimer = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly v = new Vector3();
  private readonly push = new Vector2();

  constructor(
    private readonly feed: Vector3[],
    private readonly rocks: () => RockInfo[],
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    const t = (dark: number, mid: number, light: number, outline = 0.6, highlight = 0.5) => toonMaterial({ dark, mid, light, litAt: 0.5, midAt: -0.1, outline, highlight });
    const M = {
      chitin: t(0x1e1a0a, 0x3e3412, 0x6a5a1e),
      pale: t(0x4e3e1e, 0x7a6232, 0xa88a48),
      band: t(0x16140b, 0x2a2614, 0x3e381e),
      eye: t(0x4a2006, 0x9a4e0c, 0xf0a02c, 0.5, 1),
      wing: t(0x2c2a24, 0x48443a, 0x6a6454, 0.4, 0.3),
      vein: t(0x16140e, 0x221e16, 0x30291e, 0.2, 0),
      leg: t(0x2e2914, 0x544a22, 0x7a6c34),
      jaw: t(0x0e0a08, 0x1a120e, 0x2a1e18),
    };
    for (let i = 0; i < COUNT; i++) this.bugs.push(this.makeBug(M, i));
    // tracks in the sand, the mounds they dig, the holes in them
    const trackMat = toonMaterial({ dark: PALETTE.sandDeep, mid: PALETTE.sandDeep, light: PALETTE.sandShade, litAt: 0.7, outline: 0, highlight: 0 });
    this.tracks = new InstancedMesh(new BoxGeometry(0.03, 0.004, 0.04), trackMat, 900);
    this.tracks.count = 0;
    this.tracks.frustumCulled = false;
    const moundMat = toonMaterial({ dark: PALETTE.sandShade, mid: PALETTE.sandMid, light: PALETTE.sandLit, litAt: 0.55, outline: 0.3, highlight: 0.2 });
    this.mounds = new InstancedMesh(faceted(new IcosahedronGeometry(1, 0)), moundMat, COUNT);
    this.mounds.count = 0;
    this.mounds.frustumCulled = false;
    const holeMat = toonMaterial({ dark: 0x2a2014, mid: 0x3a2c1c, light: 0x4a3a26, litAt: 0.6, outline: 0, highlight: 0 });
    this.holes = new InstancedMesh(new CylinderGeometry(1, 1, 0.01, 6), holeMat, COUNT);
    this.holes.count = 0;
    this.holes.frustumCulled = false;
    // the fan of darker, damp sand it threw out behind it
    this.spoil = new InstancedMesh(new CylinderGeometry(1, 1, 0.006, 7), trackMat, COUNT);
    this.spoil.count = 0;
    this.spoil.frustumCulled = false;
    this.group.add(this.tracks, this.spoil, this.mounds, this.holes);
    for (const p of feed) this.center.add(p);
    this.center.divideScalar(Math.max(1, feed.length));
    this.settle();
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }

  /** Build one: about a third of a unit long, nose along +z. */
  private makeBug(M: Record<string, Material>, i: number): Bug {
    const root = new Group();
    const body = new Group();
    body.position.y = 0.075;
    root.add(body);
    const box = (parent: Object3D, w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, shadow = false) => {
      const b = new Mesh(faceted(new BoxGeometry(w, h, d)), mat);
      b.position.set(x, y, z);
      if (shadow) b.layers.enable(SHADOW_LAYER);
      parent.add(b);
      return b;
    };
    /** A limb segment from a to b. */
    const seg = (parent: Object3D, a: Vector3, b: Vector3, th: number, mat: Material) => {
      const d = b.clone().sub(a);
      const m = new Mesh(faceted(new BoxGeometry(th, th, d.length())), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), d.normalize());
      parent.add(m);
      return m;
    };
    // thorax under its saddle plate, a pale stripe down each side
    box(body, 0.075, 0.07, 0.09, M.chitin, 0, 0, 0.03, true);
    box(body, 0.088, 0.024, 0.1, M.chitin, 0, 0.042, 0.035);
    box(body, 0.09, 0.012, 0.07, M.pale, 0, 0.03, 0.03);
    // the abdomen, banded, its tip curling up a little
    const abdomen = new Group();
    abdomen.position.set(0, -0.005, -0.015);
    body.add(abdomen);
    box(abdomen, 0.07, 0.06, 0.07, M.chitin, 0, 0, -0.035, true);
    box(abdomen, 0.072, 0.02, 0.012, M.band, 0, 0.012, -0.07);
    box(abdomen, 0.06, 0.052, 0.07, M.pale, 0, 0.002, -0.1, true);
    box(abdomen, 0.062, 0.018, 0.012, M.band, 0, 0.014, -0.135);
    box(abdomen, 0.045, 0.04, 0.06, M.chitin, 0, 0.008, -0.16);
    box(abdomen, 0.028, 0.028, 0.03, M.band, 0, 0.016, -0.2).rotation.x = -0.3;
    // the head: a blunt face, big amber eyes, jaws, and long feelers
    const head = new Group();
    head.position.set(0, 0.008, 0.075);
    body.add(head);
    box(head, 0.068, 0.075, 0.06, M.chitin, 0, 0, 0.028, true);
    box(head, 0.05, 0.05, 0.01, M.pale, 0, -0.008, 0.06);
    for (const sx of [-1, 1]) box(head, 0.022, 0.036, 0.032, M.eye, sx * 0.037, 0.016, 0.032);
    const mand: Object3D[] = [];
    for (const sx of [-1, 1]) {
      const j = new Group();
      j.position.set(sx * 0.014, -0.034, 0.058);
      head.add(j);
      box(j, 0.014, 0.012, 0.03, M.jaw, sx * 0.004, 0, 0.012).rotation.y = -sx * 0.4;
      mand.push(j);
    }
    const ant: Object3D[] = [];
    for (const sx of [-1, 1]) {
      const a = new Group();
      a.position.set(sx * 0.016, 0.035, 0.05);
      a.rotation.set(-0.55, sx * 0.35, 0);
      head.add(a);
      box(a, 0.006, 0.006, 0.16, M.band, 0, 0, 0.08);
      ant.push(a);
    }
    // wings folded along its back, veined
    const wings: Object3D[] = [];
    for (const sx of [-1, 1]) {
      const w = new Group();
      w.position.set(sx * 0.018, 0.05, 0.03);
      w.rotation.y = sx * 0.07;
      body.add(w);
      box(w, 0.046, 0.006, 0.22, M.wing, sx * 0.012, 0, -0.11);
      box(w, 0.006, 0.008, 0.2, M.vein, sx * 0.022, 0.001, -0.11);
      for (const z of [-0.06, -0.12, -0.18]) box(w, 0.04, 0.008, 0.006, M.vein, sx * 0.012, 0.001, z);
      wings.push(w);
    }
    // six legs: the front four slender, the hind pair great kinked levers
    const legs: Leg[] = [];
    const legDefs: [number, boolean, number][] = [
      [0.06, false, 0],
      [0.02, false, 1],
      [-0.01, true, 0],
    ];
    for (const [z, hind, set0] of legDefs) {
      for (const side of [-1, 1]) {
        const hip = new Group();
        hip.position.set(side * 0.034, -0.015, z);
        body.add(hip);
        if (!hind) {
          const knee = new Vector3(side * 0.06, 0.035, z > 0.04 ? 0.025 : -0.005);
          const foot = new Vector3(side * 0.095, -0.06, z > 0.04 ? 0.05 : -0.01);
          seg(hip, new Vector3(0, 0, 0), knee, 0.012, M.leg);
          seg(hip, knee, foot, 0.009, M.band);
        } else {
          const knee = new Vector3(side * 0.05, 0.075, -0.12);
          const foot = new Vector3(side * 0.065, -0.06, -0.15);
          seg(hip, new Vector3(0, 0, 0), knee, 0.024, M.pale);
          seg(hip, knee, foot, 0.01, M.leg);
          box(hip, 0.012, 0.012, 0.03, M.band, side * 0.066, -0.058, -0.135);
        }
        legs.push({ hip, side, set: (set0 + (side > 0 ? 1 : 0)) % 2, hind });
      }
    }
    // a touch bigger than life, so it reads at this scale
    root.scale.setScalar(1.75);
    this.group.add(root);
    return {
      root,
      body,
      head,
      abdomen,
      mand,
      ant,
      wings,
      legs,
      state: 'feed',
      t: 0,
      pos: new Vector3(),
      yaw: 0,
      perch: 0,
      home: i % Math.max(1, this.feed.length),
      delay: 0,
      peck: Math.random(),
      peckT: 0,
      chew: 0,
      hopTimer: 3 + Math.random() * 8,
      hop: null,
      walk: null,
      heading: 0,
      side: 1,
      speed: 0,
      top: 3.5 + Math.random() * 2,
      run: 0,
      gait: Math.random() * 10,
      zig: Math.random() * 10,
      track: 0,
      trackSide: 1,
      puff: 0,
      seed: i * 7.31,
    };
  }

  /** Back on the dead, eating, as if they had never been disturbed. */
  private settle() {
    this.noticed = false;
    this.trackN = 0;
    this.moundN = 0;
    this.tracks.count = 0;
    this.mounds.count = 0;
    this.holes.count = 0;
    this.spoil.count = 0;
    for (const [i, b] of this.bugs.entries()) {
      const p = this.feed[b.home] ?? this.center;
      const a = i * 2.4;
      b.pos.set(p.x + Math.cos(a) * 0.09, 0, p.z + Math.sin(a) * 0.09);
      b.perch = Math.max(0, p.y - terrainHeight(b.pos.x, b.pos.z));
      b.yaw = Math.atan2(p.x - b.pos.x, p.z - b.pos.z) + (Math.random() - 0.5) * 1.2;
      b.state = 'feed';
      b.t = 0;
      b.hop = null;
      b.walk = null;
      b.speed = 0;
      b.root.visible = true;
      b.root.position.set(b.pos.x, p.y, b.pos.z);
    }
  }

  /** `listener` is the creature, `speed` how fast it moves; `sees` is false when walls are between them. */
  update(dt: number, listener: Vector3, speed: number, sees = true) {
    const d = Math.hypot(listener.x - this.center.x, listener.z - this.center.z);
    const near = d < 60;
    this.group.visible = near;
    // long after it has gone, they come back
    if (this.noticed && d > 32) {
      this.awayTime += dt;
      if (this.awayTime > 12) this.settle();
    } else this.awayTime = 0;
    if (!near) return;
    // they notice it: close, or nearer than that if it comes running
    if (!this.noticed && sees && (d < 6.5 || (d < 10 && speed > 3.2))) {
      this.noticed = true;
      for (const b of this.bugs) {
        b.state = 'alert';
        b.t = 0;
        b.delay = Math.random() * 0.35;
      }
      this.audio.locustAlarm(this.level(listener, this.center) * 1.2, this.pan(listener, this.center));
      // and a frightened squealing breaks out through them
      for (let k = 0; k < 5; k++) {
        setTimeout(() => this.audio.locustSqueal(this.level(listener, this.center) * 0.9, (Math.random() - 0.5) * 1.2), k * 90 + Math.random() * 120);
      }
    }
    const time = performance.now() / 1000;
    let running = 0;
    let chewing = 0;
    for (const b of this.bugs) {
      if (b.state === 'gone') continue;
      b.t += dt;
      if (b.state === 'feed') {
        this.feedOne(b, dt, time, listener);
        chewing++;
      } else if (b.state === 'alert') this.alertOne(b, dt, time, listener);
      else if (b.state === 'flee') {
        this.fleeOne(b, dt, time, listener);
        running++;
      } else if (b.state === 'dig') this.digOne(b, dt, time, listener);
      this.place(b);
    }
    // the sound of them: jaws working while they eat, a patter of feet as they run
    this.chitterTimer -= dt;
    if (chewing > 0 && this.chitterTimer <= 0) {
      this.chitterTimer = 0.12 + Math.random() * 0.45;
      this.audio.locustChitter(this.level(listener, this.center) * Math.min(1, 0.4 + chewing / 10), this.pan(listener, this.center) + (Math.random() - 0.5) * 0.4);
    }
    this.chewTimer -= dt;
    if (chewing > 0 && this.chewTimer <= 0) {
      this.chewTimer = 0.05 + Math.random() * 0.12;
      this.audio.locustChew(this.level(listener, this.center) * Math.min(1, chewing / 6), this.pan(listener, this.center));
    }
    if (running > 0 && Math.random() < 0.7) this.audio.locustPatter(this.level(listener, this.center) * Math.min(1, running / 4) * 0.8, this.pan(listener, this.center));
    this.tracks.instanceMatrix.needsUpdate = true;
  }

  private level(l: Vector3, p: Vector3) {
    const d = Math.hypot(l.x - p.x, l.z - p.z);
    return 1 / (1 + (d * d) / 18);
  }

  private pan(l: Vector3, p: Vector3) {
    return Math.max(-0.8, Math.min(0.8, (p.x - l.x) / 6));
  }

  /** Feeding: the head jerks down to tear, the jaws work, the abdomen pulses; now and then it moves. */
  private feedOne(b: Bug, dt: number, time: number, listener: Vector3) {
    b.peck -= dt;
    if (b.peck <= 0) {
      b.peck = 0.18 + Math.random() * 0.5;
      b.peckT = 1;
      if (Math.random() < 0.08) {
        // a shred torn loose
        this.dust.spawn(b.root.position.x, b.root.position.y + 0.05, b.root.position.z, (Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4, 0.5, BITS, 1, { g: 8, drag: 0.5, windK: 0 });
      }
    }
    b.peckT = Math.max(0, b.peckT - dt * 6);
    b.chew += dt * 38;
    b.head.rotation.x = 0.35 + b.peckT * 0.5 + noise1(time * 3, b.seed) * 0.05;
    b.head.rotation.y = noise1(time * 1.3, b.seed + 2) * 0.25;
    for (const [k, j] of b.mand.entries()) j.rotation.y = (k ? -1 : 1) * (0.15 + 0.25 * Math.abs(Math.sin(b.chew)));
    b.abdomen.scale.y = 1 + Math.sin(time * 5 + b.seed) * 0.08;
    for (const [k, a] of b.ant.entries()) a.rotation.x = -0.4 + noise1(time * 4, b.seed + k * 3) * 0.3;
    for (const w of b.wings) w.rotation.z = 0;
    this.legsStill(b, time, 0.04);
    b.body.rotation.set(0.12, 0, 0);
    // now and then, scuttle over to another place on the dead
    if (b.walk) this.walkOn(b, dt, time, listener);
    else if (b.hop) this.hopOn(b, dt);
    else {
      b.hopTimer -= dt;
      if (b.hopTimer <= 0 && this.feed.length > 1) {
        b.hopTimer = 3 + Math.random() * 7;
        const p = this.feed[Math.floor(Math.random() * this.feed.length)];
        const tx = p.x + (Math.random() - 0.5) * 0.14;
        const tz = p.z + (Math.random() - 0.5) * 0.14;
        const total = Math.hypot(tx - b.pos.x, tz - b.pos.z);
        if (total > 0.15) {
          b.walk = { x: tx, z: tz, y: p.y, from: b.perch, total, pause: 0, burst: 0.3 + Math.random() * 0.5 };
        } else {
          // just a shuffle round on the spot
          b.yaw += (Math.random() - 0.5) * 1.5;
        }
      }
    }
  }

  /**
   * Scuttling between the bodies: down off one, across the sand in jerky
   * bursts, stopping dead, feelers twitching, then on, and up onto the next.
   */
  private walkOn(b: Bug, dt: number, time: number, listener: Vector3) {
    const w = b.walk!;
    const dx = w.x - b.pos.x;
    const dz = w.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (w.pause > 0) {
      w.pause -= dt;
      this.legsStill(b, time, 0.1);
      for (const [k, a] of b.ant.entries()) a.rotation.x = -0.6 + noise1(time * 9, b.seed + k) * 0.5;
      b.head.rotation.x = 0.1;
      return;
    }
    w.burst -= dt;
    if (w.burst <= 0) {
      w.burst = 0.25 + Math.random() * 0.6;
      if (Math.random() < 0.55) w.pause = 0.1 + Math.random() * 0.45;
    }
    // a little wander in its line, and turning sharply toward where it is going
    const want = Math.atan2(dx, dz) + noise1(time * 4, b.seed) * 0.5;
    let dy = want - b.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    b.yaw += dy * Math.min(1, dt * 12);
    const speed = 1.1 + Math.sin(time * 13 + b.seed) * 0.25;
    const step = Math.min(d, speed * dt);
    const ox = b.pos.x;
    const oz = b.pos.z;
    b.pos.x += Math.sin(b.yaw) * step;
    b.pos.z += Math.cos(b.yaw) * step;
    // down off the body at the start, up onto the next at the end
    const gone = w.total - d;
    const g = terrainHeight(b.pos.x, b.pos.z);
    const down = w.from * Math.max(0, 1 - gone / 0.3);
    const up = Math.max(0, w.y - g) * Math.max(0, 1 - d / 0.3);
    b.perch = Math.max(down, up);
    b.body.rotation.set(up > down ? -0.5 : down > 0.01 ? 0.45 : 0.02, 0, Math.sin(time * 40) * 0.04);
    b.gait += dt * speed * 10;
    this.legsRun(b);
    b.head.rotation.x = 0.05;
    for (const a of b.ant) a.rotation.x = -0.3 + Math.sin(time * 20 + b.seed) * 0.15;
    b.abdomen.scale.y = 1;
    // its feet leave fine prints across the sand
    if (b.perch < 0.02) {
      b.track += Math.hypot(b.pos.x - ox, b.pos.z - oz);
      while (b.track > 0.055) {
        b.track -= 0.055;
        b.trackSide = -b.trackSide;
        this.print(b.pos.x + Math.cos(b.yaw) * 0.03 * b.trackSide, b.pos.z - Math.sin(b.yaw) * 0.03 * b.trackSide, b.yaw);
      }
    }
    if (Math.random() < dt * 8) this.audio.locustPatter(this.level(listener, b.pos) * 0.35, this.pan(listener, b.pos));
    if (d < 0.02) {
      b.walk = null;
      b.perch = Math.max(0, w.y - g);
    }
  }

  /** Startled: frozen, turned to face it, feelers up, wings half lifted, trembling. */
  private alertOne(b: Bug, dt: number, time: number, listener: Vector3) {
    if (b.t < b.delay) return;
    const want = Math.atan2(listener.x - b.pos.x, listener.z - b.pos.z);
    let dy = want - b.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    b.yaw += dy * Math.min(1, dt * 14);
    b.head.rotation.x = -0.25;
    for (const a of b.ant) a.rotation.x = -0.95;
    for (const [k, w] of b.wings.entries()) w.rotation.z = (k ? -1 : 1) * 0.25;
    b.body.rotation.set(-0.1 + Math.sin(time * 70) * 0.03, 0, Math.sin(time * 60 + b.seed) * 0.03);
    this.legsStill(b, time, 0);
    if (b.t > b.delay + 0.2 + (b.seed % 1) * 0.25) {
      b.state = 'flee';
      b.t = 0;
      // away from it, scattering
      // breaking to one side or the other, so they scatter rather than pile up
      b.side = Math.random() < 0.5 ? -1 : 1;
      b.heading = Math.atan2(b.pos.x - listener.x, b.pos.z - listener.z) + b.side * (0.6 + Math.random() * 0.9);
      b.speed = 0;
      b.top = 3.5 + Math.random() * 2.2;
      b.run = 1.8 + Math.random() * 2;
      b.hopTimer = 0.2 + Math.random() * 0.5;
      // off the body first, in one leap
      if (b.perch > 0.05) {
        const tx = b.pos.x + Math.sin(b.heading) * 0.8;
        const tz = b.pos.z + Math.cos(b.heading) * 0.8;
        this.startHop(b, tx, tz, terrainHeight(tx, tz), 0.35, 0.35, listener);
      }
    }
  }

  /** Running: a fast tripod scuttle, zigzagging, hopping on buzzing wings, tracking the sand. */
  private fleeOne(b: Bug, dt: number, time: number, listener: Vector3) {
    if (b.hop) {
      this.hopOn(b, dt);
      this.legsStill(b, time, 0);
      for (const [k, w] of b.wings.entries()) w.rotation.z = (k ? -1 : 1) * (1.0 + Math.sin(time * 90) * 0.5);
      return;
    }
    for (const w of b.wings) w.rotation.z *= 0.6;
    // still heading away from the creature, but dodging
    const away = Math.atan2(b.pos.x - listener.x, b.pos.z - listener.z) + b.side * 0.6;
    let dh = away - b.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.heading += dh * dt * 1.2;
    b.zig += dt * 7;
    const dir = b.heading + Math.sin(b.zig) * 0.55;
    b.yaw = dir;
    b.speed = Math.min(b.top, b.speed + dt * 18);
    const ox = b.pos.x;
    const oz = b.pos.z;
    b.pos.x += Math.sin(dir) * b.speed * dt;
    b.pos.z += Math.cos(dir) * b.speed * dt;
    // walls and rocks turn it aside
    // a wall or a rock in the way: veer off along it, to its own side
    for (const r of this.rocks()) {
      if (pushOutOfRock(r, b.pos, 0.09, this.push)) {
        const along = Math.atan2(this.push.x, this.push.y) + b.side * Math.PI * 0.5;
        b.heading = along;
      }
    }
    b.perch = 0;
    // its legs a blur
    b.gait += dt * b.speed * 9;
    this.legsRun(b);
    b.head.rotation.x = 0;
    for (const a of b.ant) a.rotation.x = -0.15;
    b.body.rotation.set(-0.05, 0, 0);
    b.body.position.y = 0.075 + Math.abs(Math.sin(b.gait * Math.PI)) * 0.008;
    // tracks: a fine double line of prints, and puffs of sand kicked up
    const moved = Math.hypot(b.pos.x - ox, b.pos.z - oz);
    b.track += moved;
    while (b.track > 0.055) {
      b.track -= 0.055;
      b.trackSide = -b.trackSide;
      this.print(b.pos.x + Math.cos(dir) * 0.03 * b.trackSide, b.pos.z - Math.sin(dir) * 0.03 * b.trackSide, dir);
    }
    b.puff -= dt;
    if (b.puff <= 0) {
      b.puff = 0.08 + Math.random() * 0.12;
      this.dust.spawn(b.pos.x, terrainHeight(b.pos.x, b.pos.z) + 0.02, b.pos.z, -Math.sin(dir) * 0.4, 0.15 + Math.random() * 0.2, -Math.cos(dir) * 0.4, 0.4 + Math.random() * 0.3, SAND, 1, {
        g: 2,
        drag: 2,
        windK: 0.3,
        c2: SAND_FADE,
        soft: true,
      });
    }
    // a hop now and then, wings buzzing
    b.hopTimer -= dt;
    if (b.hopTimer <= 0) {
      b.hopTimer = 0.5 + Math.random() * 1.2;
      if (Math.random() < 0.55) {
        const len = 0.7 + Math.random() * 0.8;
        const tx = b.pos.x + Math.sin(dir) * len;
        const tz = b.pos.z + Math.cos(dir) * len;
        this.startHop(b, tx, tz, terrainHeight(tx, tz), 0.3 + Math.random() * 0.3, 0.32, listener);
      }
    }
    // clear of it: time to go under
    if (b.t > b.run && !b.hop) {
      b.state = 'dig';
      b.t = 0;
      this.dust.kick(b.pos.x, terrainHeight(b.pos.x, b.pos.z), b.pos.z, Math.sin(dir), Math.cos(dir), 2, 0.4);
      this.audio.locustDig(this.level(listener, b.pos) * 0.9, this.pan(listener, b.pos));
    }
  }

  /** Digging in: nose down, wriggling, legs paddling, sand flung up behind, sinking out of sight. */
  private digOne(b: Bug, dt: number, time: number, listener: Vector3) {
    const k = smooth(0, 1, b.t / 1.1);
    b.speed *= Math.exp(-dt * 20);
    b.body.rotation.set(0.75 * smooth(0, 0.2, b.t), Math.sin(time * 110) * 0.25 * (1 - k), Math.sin(time * 80 + b.seed) * 0.15);
    b.gait += dt * 30;
    this.legsRun(b);
    b.body.position.y = 0.075 - k * 0.26;
    const g = terrainHeight(b.pos.x, b.pos.z);
    if (Math.random() < 0.9) {
      for (let i = 0; i < 2; i++) {
        const back = b.yaw + Math.PI + (Math.random() - 0.5) * 1.4;
        this.dust.spawn(b.pos.x, g + 0.03, b.pos.z, Math.sin(back) * (0.4 + Math.random() * 0.9), 0.7 + Math.random() * 1.1, Math.cos(back) * (0.4 + Math.random() * 0.9), 0.4 + Math.random() * 0.3, i ? SAND : SAND_DARK, 1, {
          g: 9,
          drag: 0.6,
          windK: 0.2,
          c2: SAND_FADE,
        });
      }
    }
    if (b.t > 1.15) {
      b.state = 'gone';
      b.root.visible = false;
      this.mound(b.pos.x, b.pos.z, b.yaw);
      this.dust.kick(b.pos.x, g, b.pos.z, 0, 0, 3, 0.4);
      void listener;
    }
  }

  private startHop(b: Bug, tx: number, tz: number, ty: number, h: number, dur: number, listener: Vector3) {
    const fromY = b.root.position.y;
    b.hop = { t: 0, dur, h, from: fromY, to: ty, vx: (tx - b.pos.x) / dur, vz: (tz - b.pos.z) / dur };
    this.audio.locustBuzz(this.level(listener, b.pos) * 0.8, this.pan(listener, b.pos));
  }

  private hopOn(b: Bug, dt: number) {
    const h = b.hop!;
    h.t += dt;
    const k = Math.min(1, h.t / h.dur);
    b.pos.x += h.vx * dt;
    b.pos.z += h.vz * dt;
    const g = terrainHeight(b.pos.x, b.pos.z);
    const y = h.from + (h.to - h.from) * k + Math.sin(k * Math.PI) * h.h;
    b.perch = Math.max(0, y - g);
    b.body.rotation.x = -0.3 + k * 0.5;
    if (k >= 1) {
      b.hop = null;
      b.perch = Math.max(0, h.to - g);
      if (b.perch < 0.02) this.dust.kick(b.pos.x, g, b.pos.z, h.vx * 0.2, h.vz * 0.2, 1, 0.3);
    }
  }

  /** Legs at rest, shifting a little. */
  private legsStill(b: Bug, time: number, shuffle: number) {
    for (const [k, l] of b.legs.entries()) {
      l.hip.rotation.set(0, noise1(time * 2, b.seed + k) * shuffle * 4, 0);
    }
  }

  /** Legs running: two tripods, each swinging forward lifted while the other pushes back. */
  private legsRun(b: Bug) {
    for (const l of b.legs) {
      const ph = b.gait * Math.PI * 2 + l.set * Math.PI;
      const swing = Math.sin(ph) * (l.hind ? 0.25 : 0.45);
      const lift = Math.max(0, Math.cos(ph)) * (l.hind ? 0.15 : 0.35);
      l.hip.rotation.set(0, -l.side * swing, l.side * lift);
    }
  }

  private place(b: Bug) {
    const g = terrainHeight(b.pos.x, b.pos.z);
    b.root.position.set(b.pos.x, g + b.perch, b.pos.z);
    b.root.rotation.set(0, b.yaw, 0);
  }

  private print(x: number, z: number, yaw: number) {
    if (this.trackN >= 900) return;
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), yaw);
    this.m.compose(this.v.set(x, terrainHeight(x, z) + 0.003, z), this.q, this.s.set(1, 1, 1));
    this.tracks.setMatrixAt(this.trackN++, this.m);
    this.tracks.count = this.trackN;
  }

  /** A small heap of churned sand with a dark hole in it, where one went under. */
  private mound(x: number, z: number, yaw: number) {
    if (this.moundN >= COUNT) return;
    const g = terrainHeight(x, z);
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), yaw);
    this.m.compose(this.v.set(x - Math.sin(yaw) * 0.1, g - 0.02, z - Math.cos(yaw) * 0.1), this.q, this.s.set(0.22, 0.075, 0.17));
    this.mounds.setMatrixAt(this.moundN, this.m);
    this.m.compose(this.v.set(x, g + 0.05, z), this.q, this.s.set(0.05, 1, 0.045));
    this.holes.setMatrixAt(this.moundN, this.m);
    this.m.compose(this.v.set(x - Math.sin(yaw) * 0.3, g + 0.004, z - Math.cos(yaw) * 0.3), this.q, this.s.set(0.24, 1, 0.34));
    this.spoil.setMatrixAt(this.moundN, this.m);
    this.moundN++;
    for (const im of [this.mounds, this.holes, this.spoil]) {
      im.count = this.moundN;
      im.instanceMatrix.needsUpdate = true;
    }
  }
}
