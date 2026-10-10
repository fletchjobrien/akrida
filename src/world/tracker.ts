import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Vector2,
  Vector3,
  type Camera,
  type Material,
  type ShaderMaterial,
} from 'three';
import { clamp, saturate, smoothstep } from '../core/math';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { terrainHeight } from './terrain';
import { pushOutOfRock, type RockInfo } from './rocks';
import type { Ship } from './ship';
import type { Dust } from './particles';
import type { AudioEngine } from '../audio/AudioEngine';
import type { Creature } from '../character/Creature';

/**
 * Where the tracker leads, from the ship's centre: 50 units to the north-east
 * (screen up and right: +x, -z).
 */
export const TRACK_OFFSET = new Vector2(50 * Math.SQRT1_2, -50 * Math.SQRT1_2);
/** Within this angle of the way to go it holds a solid light; it lets go a little wider (hysteresis). */
const HOT_IN = (26 * Math.PI) / 180;
const HOT_OUT = (34 * Math.PI) / 180;
/** This close to the place, it shows solid whichever way it points. */
const ARRIVE = 3;

// the device, in its own space: x across its face, y up toward the antenna, z out of its face
const W = 0.13;
const H = 0.21;
const D = 0.066;
/** Drawn larger than life, so it reads at the pixel scale. */
const SCALE = 1.3;
/** Its centre's height above the ground when it lies on its back. */
const REST_LIFT = (D / 2) * SCALE + 0.004;
const TIP = new Vector3(-0.032, H / 2 + 0.165, 0);
const LED = new Vector3(0, -0.028, D / 2 + 0.008);

/**
 * The light's colour in five steps, dark to white-hot, quantised so it reads
 * as pixel art: red while it searches, green when it points true.
 */
const GREEN = [0x0c1a10, 0x1b4a26, 0x2f8f45, 0x6fe07a, 0xd8ffcc].map(rgb);
const RED = [0x1c0c0c, 0x4a1714, 0x9a2a22, 0xec5a48, 0xffd2c6].map(rgb);
const GLOW_GREEN = rgb(0x3fdc5a);
const GLOW_RED = rgb(0xff4632);
const SAND = [rgb(0xe4c987).toArray(), rgb(0xbca872).toArray()];

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/** In the hand: the grip in the hoof, antenna forward along it, face turned out. */
const GRIP = new Matrix4()
  .makeBasis(new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(-1, 0, 0))
  .setPosition(0, -0.015, 0.068);
/** Held out to look at, in the chest's space: tipped back, its face up toward the eyes, antenna ahead. */
const INSPECT = new Matrix4()
  .makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0.53, 0.85).normalize(), new Vector3(0, 0.85, -0.53).normalize())
  .setPosition(0, 0.19, 0.34);

const _m = new Matrix4();
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _p2 = new Vector3();
const _q2 = new Quaternion();
const _v = new Vector3();
const _dq = new Quaternion();
const _ax = new Vector3();
const _n = new Vector2();
const _c = new Vector3();
const _gripP = new Vector3();
const _gripQ = new Quaternion();
GRIP.decompose(_gripP, _gripQ, _s);

export type TrackerState = 'placed' | 'carried' | 'falling' | 'ground';

/**
 * A hand-held tracker from the ship, about the size of a walkie-talkie: an
 * off-white shell banded like the pods, a grille, a small light on its face
 * and a glowing antenna tip. It knows where something lies. Pointed the wrong
 * way, its light throbs slowly red; pointed the right way, it burns a solid
 * green and hums softly.
 */
export class Tracker {
  readonly group = new Group();
  readonly target = new Vector3();
  state: TrackerState = 'placed';
  /** Picked up at least once: awake, and searching in earnest. */
  awake = false;
  /** Pointing the right way (with hysteresis). */
  hot = false;
  /** 0..1, eased toward `hot`. */
  heat = 0;
  /** 0..1 brightness of its light now. */
  light = 0;
  /** Where it lies when nobody holds it. */
  readonly rest = new Vector3();
  /** Its light is visible (not shut away behind the ship's door). */
  shown = false;
  /** Into the ship, from its door, and along the hull toward the stern. */
  readonly doorFacing = new Vector3();
  readonly doorAlong = new Vector3();
  /** 0..1: set by a scene to have it held up in both hands to look at. */
  inspect = 0;

  private readonly restQ = new Quaternion();
  private readonly ledMat: ShaderMaterial;
  private readonly tipMat: ShaderMaterial;
  private readonly tip = new Object3D();
  private readonly led = new Object3D();
  private readonly tipGlow = new Glow(GLOW_GREEN, 0.2, { core: 0.7 });
  private readonly ledGlow = new Glow(GLOW_GREEN, 0.12, { core: 0.6 });
  private readonly pool = new Glow(GLOW_GREEN, 0.75, { flat: true, core: 0 });
  private phase = 0.15;
  private flash = 0;
  /** In the hand: where the hoof closed on it, easing into the grip as it is lifted. */
  private readonly takeP = new Vector3();
  private readonly takeQ = new Quaternion();
  private takeT = 1;
  /** Seconds of sand still trickling off it after it was taken up. */
  private shed = 0;
  private shedTimer = 0;
  private readonly vel = new Vector3();
  private readonly spin = new Vector3();
  private bounces = 0;
  private settle = -1;
  private readonly settleFrom = new Quaternion();
  private floor = 0;
  private inShip = true;
  private readonly screen = new Vector3();

  constructor(
    private readonly ship: Ship,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    private readonly rocks: RockInfo[],
  ) {
    this.target.set(ship.center.x + TRACK_OFFSET.x, 0, ship.center.z + TRACK_OFFSET.y);
    this.target.y = terrainHeight(this.target.x, this.target.z);
    this.ledMat = toonMaterial({ dark: 0x0c1a10, mid: 0x0c1a10, light: 0x0c1a10, unlit: true, outline: 0 });
    this.tipMat = toonMaterial({ dark: 0x0c1a10, mid: 0x0c1a10, light: 0x0c1a10, unlit: true, outline: 0 });
    this.build();
    this.group.scale.setScalar(SCALE);

    // it lies on the airlock floor just inside the door, its antenna pointing into the ship
    ship.thresholdPoint(-0.12, 0.1, this.rest);
    this.floor = this.rest.y;
    this.doorFacing.copy(ship.doorNormal).negate();
    this.doorAlong.copy(ship.slideDir);
    this.rest.y += REST_LIFT;
    const h = _v.copy(ship.slideDir).multiplyScalar(0.9).addScaledVector(ship.doorNormal, -0.45).normalize();
    this.flatQ(h, this.restQ);
    this.group.position.copy(this.rest);
    this.group.quaternion.copy(this.restQ);
  }

  private build() {
    const shell = toonMaterial({ dark: 0x77736a, mid: 0xbdb6a6, light: 0xece6d8, litAt: 0.55, outline: 0.7, highlight: 1 });
    const back = toonMaterial({ dark: 0x625d56, mid: 0x958f83, light: 0xc9c3b5, litAt: 0.55, outline: 0.7, highlight: 0.8 });
    const accent = toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0.7, highlight: 0.8 });
    const rubber = toonMaterial({ dark: 0x1e1b1b, mid: 0x2e2a29, light: 0x45403d, litAt: 0.55, outline: 0.7, highlight: 0.5 });
    const metal = toonMaterial({ dark: 0x2e2a2a, mid: 0x4a4542, light: 0x7a746c, litAt: 0.55, outline: 0.7, highlight: 0.9 });
    const glass = toonMaterial({ dark: 0x0b1210, mid: 0x13201b, light: 0x2a4a3c, litAt: 0.5, outline: 0.6, highlight: 1 });
    const G = this.group;
    const add = (geo: BufferGeometry, mat: Material, x: number, y: number, z: number, shadow = true) => {
      const m = new Mesh(faceted(geo), mat);
      m.position.set(x, y, z);
      if (shadow) m.layers.enable(SHADOW_LAYER);
      G.add(m);
      return m;
    };
    // the shell: a face and a slightly smaller back, so its edges read as bevelled
    add(new BoxGeometry(W, H, D * 0.62), shell, 0, 0, D * 0.19);
    add(new BoxGeometry(W - 0.014, H - 0.012, D * 0.4), back, 0, 0, -D * 0.3);
    // rubber grip round the lower body, an orange band above it
    add(new BoxGeometry(W + 0.008, 0.07, D + 0.006), rubber, 0, -H / 2 + 0.05, 0);
    add(new BoxGeometry(W + 0.006, 0.02, D + 0.004), accent, 0, H / 2 - 0.035, 0);
    // a speaker grille: a dark plate with three raised ribs
    add(new BoxGeometry(0.088, 0.058, 0.006), metal, 0, 0.042, D / 2 + 0.002, false);
    for (let k = 0; k < 3; k++) add(new BoxGeometry(0.076, 0.008, 0.005), back, 0, 0.026 + k * 0.016, D / 2 + 0.006, false);
    // the light, in a small dark window under the grille
    add(new BoxGeometry(0.06, 0.042, 0.006), glass, 0, LED.y, D / 2 + 0.002, false);
    const led = new Mesh(faceted(new BoxGeometry(0.026, 0.026, 0.012)), this.ledMat);
    led.position.set(0, LED.y, D / 2 + 0.004);
    G.add(led);
    this.led.position.copy(LED);
    G.add(this.led);
    // side keys
    add(new BoxGeometry(0.012, 0.045, 0.026), metal, W / 2 + 0.004, 0.02, 0, false);
    add(new BoxGeometry(0.012, 0.02, 0.026), accent, W / 2 + 0.004, -0.02, 0, false);
    // on top: a ridged dial and the antenna in its collar
    add(new CylinderGeometry(0.017, 0.017, 0.028, 8), accent, 0.036, H / 2 + 0.014, 0);
    add(new CylinderGeometry(0.02, 0.023, 0.034, 6), metal, TIP.x, H / 2 + 0.017, 0);
    add(new CylinderGeometry(0.0085, 0.011, 0.075, 6), metal, TIP.x, H / 2 + 0.07, 0);
    add(new CylinderGeometry(0.006, 0.0075, 0.07, 6), back, TIP.x, H / 2 + 0.135, 0);
    const tip = new Mesh(faceted(new IcosahedronGeometry(0.024, 0)), this.tipMat);
    tip.position.copy(TIP);
    G.add(tip);
    this.tip.position.copy(TIP);
    G.add(this.tip);
    // a belt clip on the back
    add(new BoxGeometry(0.05, 0.1, 0.012), metal, 0, 0.01, -D / 2 - 0.006, false);
  }

  addTo(scene: Object3D) {
    scene.add(this.group, this.tipGlow, this.ledGlow, this.pool);
  }

  /** Lying on its back, its antenna along the ground direction `h`. */
  private flatQ(h: Vector3, out: Quaternion) {
    _v.set(h.x, 0, h.z).normalize();
    _m.makeBasis(_ax.set(-_v.z, 0, _v.x), _v, _p.set(0, 1, 0));
    return out.setFromRotationMatrix(_m);
  }

  /** The device's centre, in world space. */
  get position() {
    return this.group.position;
  }

  get carried() {
    return this.state === 'carried';
  }

  /** It can be taken from where it lies. */
  get takeable() {
    return (this.state === 'placed' && this.ship.state === 'open' && this.ship.doorOpen > 0.6) || this.state === 'ground';
  }

  /** Where a hand closes on it, in world space. */
  grabPoint(out: Vector3) {
    return out.copy(this.rest).setY(this.rest.y + 0.07);
  }

  /** It lies in the ship's doorway (so whoever takes it faces into the ship). */
  get inDoorway() {
    return this.state === 'placed';
  }

  /** A light touch before the hoof closes on it: it shifts a little where it lies. */
  nudge(dx: number, dz: number) {
    if (this.state !== 'placed' && this.state !== 'ground') return;
    this.group.position.x += dx;
    this.group.position.z += dz;
    this.rest.x += dx;
    this.rest.z += dz;
    _dq.setFromAxisAngle(_ax.set(0, 1, 0), (Math.random() - 0.5) * 0.12);
    this.group.quaternion.premultiply(_dq);
    this.restQ.copy(this.group.quaternion);
    this.audio.trackerGrab(0.1);
    this.sandPuff(2);
  }

  /**
   * Into the hand: it stays where the hoof closed on it, and settles into the
   * grip over the lift instead of jumping there.
   */
  take(creature: Creature) {
    this.state = 'carried';
    this.inShip = false;
    this.settle = -1;
    const hand = creature.rig.arms[1].hand;
    creature.rig.root.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    _m.copy(hand.matrixWorld).invert().multiply(this.group.matrixWorld).decompose(this.takeP, this.takeQ, _s);
    this.takeT = 0;
    this.shed = 1.1;
    this.audio.trackerGrab(0.3);
  }

  /** A few grains of sand shaken off it. */
  sandPuff(count: number) {
    const p = this.group.position;
    for (let i = 0; i < count; i++) {
      this.dust.spawn(
        p.x + (Math.random() - 0.5) * 0.12,
        p.y - 0.02,
        p.z + (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.35,
        Math.random() * 0.4,
        (Math.random() - 0.5) * 0.35,
        0.6 + Math.random() * 0.5,
        SAND[i & 1],
        1,
        { g: 6, drag: 1.2, windK: 0.25 },
      );
    }
  }

  /** Wake it, the first time it is held. */
  wake() {
    if (this.awake) return;
    this.awake = true;
    this.flash = 1;
    this.phase = 0.6;
    this.audio.trackerWake(0.5);
  }

  /** Let go of it: it falls from where it is with the creature's motion. */
  drop(creature: Creature) {
    if (this.state !== 'carried') return;
    this.state = 'falling';
    this.bounces = 0;
    const fx = Math.sin(creature.yaw);
    const fz = Math.cos(creature.yaw);
    this.vel.set(creature.vel.x * 0.7 + fx * 0.3, 0.9, creature.vel.z * 0.7 + fz * 0.3);
    this.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 9);
  }

  /** Distance in CSS pixels from `mouse` to the device on screen. */
  screenDistance(mouse: Vector2, camera: Camera) {
    this.screen.copy(this.group.position).project(camera);
    const x = ((this.screen.x + 1) / 2) * window.innerWidth;
    const y = ((1 - this.screen.y) / 2) * window.innerHeight;
    return Math.hypot(mouse.x - x, mouse.y - y);
  }

  update(dt: number, creature: Creature, listener: Vector3) {
    const G = this.group;
    // ---- where it is
    if (this.state === 'carried') {
      const rig = creature.rig;
      rig.root.updateMatrixWorld(true);
      if (this.takeT < 1) {
        // from where the hoof closed on it into the grip, as it comes up
        this.takeT = Math.min(1, this.takeT + dt / 0.9);
        const e = smoothstep(0, 1, this.takeT);
        _p.lerpVectors(this.takeP, _gripP, e);
        _q.slerpQuaternions(this.takeQ, _gripQ, e);
        _m.compose(_p, _q, _c.set(1, 1, 1));
        _m.premultiply(rig.arms[1].hand.matrixWorld).decompose(_p, _q, _s);
      } else _m.multiplyMatrices(rig.arms[1].hand.matrixWorld, GRIP).decompose(_p, _q, _s);
      const w = smoothstep(0, 1, saturate(Math.max(creature.holdDyn.y, this.inspect)));
      if (w > 0.001) {
        _m.multiplyMatrices(rig.chest.matrixWorld, INSPECT).decompose(_p2, _q2, _s);
        _p.lerp(_p2, w);
        _q.slerp(_q2, w);
      }
      G.position.copy(_p);
      G.quaternion.copy(_q);
    } else if (this.state === 'falling') {
      this.fall(dt);
    }

    // ---- which way it points, and whether that is the way
    if (this.state === 'carried') _v.set(Math.sin(creature.yaw), 0, Math.cos(creature.yaw));
    else _v.set(0, 1, 0).applyQuaternion(G.quaternion).setY(0);
    const tx = this.target.x - G.position.x;
    const tz = this.target.z - G.position.z;
    const dist = Math.hypot(tx, tz);
    const len = Math.max(1e-6, Math.hypot(_v.x, _v.z));
    const cos = (_v.x * tx + _v.z * tz) / (len * Math.max(1e-6, dist));
    const angle = Math.acos(clamp(cos, -1, 1));
    const wasHot = this.hot;
    if (dist < ARRIVE) this.hot = true;
    else this.hot = this.hot ? angle < HOT_OUT : angle < HOT_IN;
    if (!this.awake) this.hot = false;
    const held = this.state === 'carried';
    const holdW = held ? saturate(Math.max(creature.holdDyn.y, this.inspect)) : 0;
    if (this.hot !== wasHot && held) {
      if (this.hot) {
        this.flash = 1;
        this.audio.trackerLock(0.05 + 0.04 * holdW);
      } else this.audio.trackerLose(0.05 + 0.04 * holdW);
    }
    this.heat = this.hot ? Math.min(1, this.heat + dt * 7) : Math.max(0, this.heat - dt * 2.5);
    this.flash = Math.max(0, this.flash - dt * 2.2);

    // ---- the slow throb while it searches: a little quicker the nearer it points
    this.shown = !this.inShip || this.ship.doorOpen > 0.25;
    const warmth = 1 - angle / Math.PI;
    const period = this.awake ? 3.4 - 1.1 * warmth : 3.8;
    const before = this.phase;
    this.phase = (this.phase + dt / period) % 1;
    const throb = Math.pow(0.5 - 0.5 * Math.cos(this.phase * Math.PI * 2), 1.6);
    // the swell of its sound peaks with the light
    const cue = 0.41;
    if (before < cue && this.phase >= cue && this.heat < 0.5 && this.shown) {
      const level = held ? 0.2 + 0.18 * holdW : this.awake ? 0.3 : 0.2;
      this.audio.trackerPulse(level);
    }
    const sleepy = this.awake ? 1 : 0.6;
    const searching = (0.06 + 0.94 * throb) * sleepy;
    this.light = searching + (1 - searching) * this.heat;
    const palette = this.heat > 0.5 ? GREEN : RED;
    const step = (v: number) => palette[Math.max(0, Math.min(4, Math.round(v * 3.6 + this.flash * 1.4)))];
    (this.ledMat.uniforms.uLight.value as Vector3).copy(step(this.light));
    (this.tipMat.uniforms.uLight.value as Vector3).copy(step(Math.min(1, this.light * 1.05)));
    for (const g of [this.tipGlow, this.ledGlow, this.pool]) g.color.lerpVectors(GLOW_RED, GLOW_GREEN, this.heat);

    // ---- glows: halos on the light and the tip, and a pool of green on whatever is under it
    G.updateMatrixWorld(true);
    this.tip.getWorldPosition(this.tipGlow.position);
    this.led.getWorldPosition(this.ledGlow.position);
    const lit = this.shown ? this.light : 0;
    this.tipGlow.strength = lit * (0.75 + 0.35 * this.flash) * (0.85 + 0.25 * holdW);
    this.ledGlow.strength = lit * 0.6 * (0.8 + 0.3 * holdW);
    const ground = this.inShip ? this.floor : terrainHeight(G.position.x, G.position.z);
    const above = G.position.y - ground;
    this.pool.position.set(G.position.x, ground + 0.012, G.position.z);
    this.pool.strength = lit * 0.32 * saturate(1.4 - above * 0.9);

    // ---- sand trickles off it for a moment after it is taken up
    if (this.shed > 0 && held) {
      this.shed -= dt;
      this.shedTimer -= dt;
      if (this.shedTimer <= 0) {
        this.shedTimer = 0.05 + Math.random() * 0.08;
        this.sandPuff(1);
      }
    }

    // ---- its sound: close and clear in the hand, louder held out; small and placed on the ground
    let level: number;
    let clarity: number;
    let pan: number;
    if (held) {
      level = 0.55 + 0.45 * holdW;
      clarity = 1;
      pan = 0;
    } else {
      const d = Math.hypot(G.position.x - listener.x, G.position.z - listener.z);
      level = this.shown ? (this.awake ? 0.9 : 0.6) / (1 + d * d * 0.05) : 0;
      clarity = 1 / (1 + d * 0.25);
      pan = clamp((G.position.x - listener.x) * 0.18, -0.8, 0.8);
    }
    const hum = this.heat * (held ? 0.45 + 0.55 * holdW : 0.35);
    const fizz = this.awake ? (1 - this.heat) * (held ? 0.25 + 0.75 * holdW : 0.12) : 0;
    this.audio.setTracker(level, pan, clarity, hum, fizz);
  }

  private fall(dt: number) {
    const G = this.group;
    this.vel.y -= 9.8 * dt;
    G.position.addScaledVector(this.vel, dt);
    if (this.settle >= 0) {
      // rolling over onto its back
      this.settle = Math.min(1, this.settle + dt * 4);
      G.quaternion.slerpQuaternions(this.settleFrom, this.restQ, smoothstep(0, 1, this.settle));
      G.position.y = this.rest.y;
      G.position.x += (this.rest.x - G.position.x) * Math.min(1, dt * 12);
      G.position.z += (this.rest.z - G.position.z) * Math.min(1, dt * 12);
      if (this.settle >= 1) {
        G.position.copy(this.rest);
        this.state = 'ground';
      }
      return;
    }
    const len = this.spin.length();
    if (len > 1e-4) {
      _dq.setFromAxisAngle(_ax.copy(this.spin).divideScalar(len), len * dt);
      G.quaternion.premultiply(_dq);
    }
    // it glances off the hull and the rocks
    for (const r of this.rocks) {
      if (r.height > 0.2 && pushOutOfRock(r, G.position, 0.07, _n)) {
        const into = this.vel.x * _n.x + this.vel.z * _n.y;
        if (into < 0) {
          this.vel.x -= 1.4 * into * _n.x;
          this.vel.z -= 1.4 * into * _n.y;
        }
      }
    }
    const ground = terrainHeight(G.position.x, G.position.z) + REST_LIFT;
    if (G.position.y > ground || this.vel.y > 0) return;
    G.position.y = ground;
    if (this.bounces === 0) {
      // first knock: a clatter, a puff of sand, a small hop
      this.bounces = 1;
      this.audio.trackerDrop(0.32);
      const sp = Math.max(0.001, Math.hypot(this.vel.x, this.vel.z));
      this.dust.kick(G.position.x, ground - REST_LIFT, G.position.z, this.vel.x / sp, this.vel.z / sp, 4, 0.45);
      this.vel.set(this.vel.x * 0.4, Math.abs(this.vel.y) * 0.26, this.vel.z * 0.4);
      this.spin.multiplyScalar(0.45);
      return;
    }
    // down to stay: lie on its back with the antenna where it ended up pointing
    this.audio.trackerDrop(0.12);
    _v.set(0, 1, 0).applyQuaternion(G.quaternion);
    if (Math.hypot(_v.x, _v.z) < 0.2) _v.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    this.flatQ(_v, this.restQ);
    this.rest.set(G.position.x + this.vel.x * 0.06, 0, G.position.z + this.vel.z * 0.06);
    this.rest.y = terrainHeight(this.rest.x, this.rest.z) + REST_LIFT;
    this.settleFrom.copy(G.quaternion);
    this.settle = 0;
    this.vel.set(0, 0, 0);
  }
}
