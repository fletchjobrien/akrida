import { BoxGeometry, CylinderGeometry, Group, Mesh, Object3D, SphereGeometry, Vector3, type BufferGeometry, type Material, type ShaderMaterial } from 'three';
import { noise1 } from '../core/math';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { terrainHeight } from '../world/terrain';
import type { AudioEngine } from '../audio/AudioEngine';

export type DronePhase = 'idle' | 'approach' | 'stalk' | 'lock' | 'dive';

const EYE_DIM = rgb(0x5a0a08);
const EYE_HOT = rgb(0xff2a18);
const STROBE_ON = rgb(0xf0f4ff);
const STROBE_OFF = rgb(0x1a1c20);

/** How long it stalks the creature before it locks on, and how long it holds the lock. */
const STALK_TIME = 15;
const LOCK_TIME = 2.4;

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/**
 * A loitering munition: a small, matte, angular quadcopter with a warhead
 * slung under its belly and a single red sensor eye in a turret at its nose.
 * No markings but a stencilled yellow band round the warhead.
 *
 * It comes in high over the ridge, the whine of its rotors arriving before it
 * does, then drops to hang round the creature: circling, hunting, twitching
 * in the air, darting in now and then to hover a hand's breadth from its face
 * while the eye studies it and the turret whirs. Then it pulls back and up,
 * stops dead, and its eye burns: a red line reaches out to the creature's
 * chest and a tone climbs faster and faster. Then it dives.
 */
export class Drone {
  readonly root = new Group();
  phase: DronePhase = 'idle';
  /** It has struck: where, and the way it was going. */
  readonly hitAt = new Vector3();
  readonly hitDir = new Vector3();
  hit = false;
  readonly vel = new Vector3();
  readonly eyeGlow = new Glow(rgb(0xff3020), 0.45, { core: 0.7 });

  private readonly frame = new Group();
  private readonly rotors: Object3D[] = [];
  private readonly turret = new Group();
  private readonly eyeMat: ShaderMaterial;
  private readonly strobeMat: ShaderMaterial;
  private readonly laser: Mesh;
  private readonly eye = new Object3D();
  private t = 0;
  private yaw = 0;
  private readonly want = new Vector3();
  private readonly acc = new Vector3();
  private readonly tmp = new Vector3();
  private orbit = 0;
  private orbitDir = 1;
  private dartTimer = 2;
  private inspectTimer = 5;
  private inspecting = 0;
  private beepTimer = 0;
  private chirpTimer = 1;
  private lockFrom = new Vector3();

  constructor(private readonly audio: AudioEngine) {
    const t = (dark: number, mid: number, light: number, outline = 0.8, highlight = 0.7) =>
      toonMaterial({ dark, mid, light, litAt: 0.55, outline, highlight });
    const hull = t(0x15171a, 0x24272c, 0x3c4148);
    const metal = t(0x0e0f11, 0x1a1c1f, 0x2e3136);
    const olive = t(0x22261c, 0x353a2a, 0x4c533c);
    const band = t(0x5a4a10, 0x8a7418, 0xb89a28, 0.6, 0.3);
    const blade = t(0x0a0a0c, 0x141418, 0x22232a, 0.4, 0.2);
    this.eyeMat = toonMaterial({ dark: 0x5a0a08, mid: 0x5a0a08, light: 0x5a0a08, unlit: true, outline: 0 });
    this.strobeMat = toonMaterial({ dark: 0x1a1c20, mid: 0x1a1c20, light: 0x1a1c20, unlit: true, outline: 0 });
    const laserMat = toonMaterial({ dark: 0xff2010, mid: 0xff2010, light: 0xff2010, unlit: true, outline: 0 });
    const add = (parent: Object3D, g: BufferGeometry, m: Material, x: number, y: number, z: number, shadow = true) => {
      const mesh = new Mesh(faceted(g), m);
      mesh.position.set(x, y, z);
      if (shadow) mesh.layers.enable(SHADOW_LAYER);
      parent.add(mesh);
      return mesh;
    };
    this.root.add(this.frame);
    // about a body's length across: small enough to be quick, big enough to see coming
    this.frame.scale.setScalar(1.6);
    const F = this.frame;
    // the fuselage: a flat, faceted wedge, its nose low and sharp
    const body = add(F, new CylinderGeometry(0.11, 0.14, 0.34, 6).rotateX(Math.PI / 2), hull, 0, 0, 0);
    body.scale.set(1, 0.55, 1);
    add(F, new BoxGeometry(0.16, 0.05, 0.2), metal, 0, 0.045, -0.02);
    add(F, new BoxGeometry(0.1, 0.04, 0.12), hull, 0, -0.02, 0.17).rotation.x = 0.35;
    // a whip antenna and the strobe that blinks on its tail
    add(F, new CylinderGeometry(0.006, 0.006, 0.22, 3), metal, -0.04, 0.14, -0.14, false).rotation.x = -0.35;
    add(F, new BoxGeometry(0.03, 0.02, 0.03), this.strobeMat, 0.04, 0.06, -0.16, false);
    // four arms in an X, motors at their tips, two-bladed props spinning on them
    for (const [sx, sz] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const arm = add(F, new BoxGeometry(0.035, 0.025, 0.3), hull, sx * 0.13, 0.01, sz * 0.13);
      arm.rotation.y = Math.atan2(sx, sz);
      const mx = sx * 0.24;
      const mz = sz * 0.24;
      add(F, new CylinderGeometry(0.035, 0.04, 0.07, 6), metal, mx, 0.03, mz);
      add(F, new CylinderGeometry(0.012, 0.012, 0.09, 4), metal, mx, -0.04, mz);
      const rotor = new Group();
      rotor.position.set(mx, 0.075, mz);
      F.add(rotor);
      add(rotor, new BoxGeometry(0.3, 0.006, 0.035), blade, 0, 0, 0, false);
      this.rotors.push(rotor);
    }
    // the warhead slung beneath: a stubby olive cylinder, a yellow band, a fuze at its nose
    const war = add(F, new CylinderGeometry(0.045, 0.045, 0.24, 8).rotateX(Math.PI / 2), olive, 0, -0.08, 0.0);
    war.scale.set(1, 1, 1);
    add(F, new CylinderGeometry(0.047, 0.047, 0.03, 8).rotateX(Math.PI / 2), band, 0, -0.08, 0.06);
    add(F, new CylinderGeometry(0.012, 0.03, 0.05, 6).rotateX(Math.PI / 2), metal, 0, -0.08, 0.145);
    for (const x of [-0.035, 0.035]) add(F, new BoxGeometry(0.01, 0.04, 0.03), metal, x, -0.04, 0);
    // the sensor turret under the nose, its one red eye
    this.turret.position.set(0, -0.05, 0.15);
    F.add(this.turret);
    add(this.turret, new SphereGeometry(0.045, 6, 4), metal, 0, 0, 0);
    add(this.turret, new BoxGeometry(0.03, 0.03, 0.02), this.eyeMat, 0, 0, 0.04, false);
    this.eye.position.set(0, 0, 0.05);
    this.turret.add(this.eye);
    // the targeting line (a thin beam, stretched to the target while locked)
    this.laser = new Mesh(new BoxGeometry(0.012, 0.012, 1).translate(0, 0, 0.5), laserMat);
    this.laser.visible = false;
    this.root.visible = false;
    this.eyeGlow.strength = 0;
  }

  addTo(scene: Object3D) {
    scene.add(this.root, this.laser, this.eyeGlow);
  }

  /** Put it away (for a respawn). */
  reset() {
    this.phase = 'idle';
    this.hit = false;
    this.root.visible = false;
    this.laser.visible = false;
    this.eyeGlow.strength = 0;
    this.audio.setDrone(0, 0, 0, 0);
  }

  /** It comes: from high over the ridge behind the station, `from` being where to come from. */
  launch(from: Vector3) {
    this.phase = 'approach';
    this.t = 0;
    this.hit = false;
    this.root.position.copy(from);
    this.vel.set(0, 0, 0);
    this.root.visible = true;
    this.orbit = Math.random() * Math.PI * 2;
    this.inspectTimer = 4 + Math.random() * 2;
    this.audio.dread();
  }

  get active() {
    return this.phase !== 'idle';
  }

  /** Where it is (for the creature to look at). */
  get position() {
    return this.root.position;
  }

  /**
   * Fly. `chest` is the creature's chest in the world, `vel` its velocity;
   * `avoid` lifts it clear of the station (centre and radius).
   */
  update(dt: number, chest: Vector3, cvel: Vector3, listener: Vector3, avoid: Vector3 | null) {
    if (this.phase === 'idle') return;
    this.t += dt;
    const P = this.root.position;
    const time = performance.now() / 1000;
    let maxAcc = 22;
    let maxSpeed = 11;
    const ground = terrainHeight(P.x, P.z);
    const dx = chest.x - P.x;
    const dz = chest.z - P.z;
    const flat = Math.hypot(dx, dz) || 1;
    let eye = 0.35 + 0.15 * Math.sin(time * 3);

    if (this.phase === 'approach') {
      // straight in, high, then down toward it
      this.want.set(chest.x - (dx / flat) * 4, chest.y + 2.4, chest.z - (dz / flat) * 4);
      maxSpeed = 13;
      if (flat < 6) {
        this.phase = 'stalk';
        this.t = 0;
      }
    } else if (this.phase === 'stalk') {
      // circling it, hunting this way and that, now and then darting to a new side
      this.dartTimer -= dt;
      if (this.dartTimer <= 0) {
        this.dartTimer = 1.2 + Math.random() * 2.5;
        this.orbit += (Math.random() - 0.5) * 2.4;
        if (Math.random() < 0.3) this.orbitDir = -this.orbitDir;
      }
      this.orbit += dt * 0.35 * this.orbitDir;
      const r = 3.2 + Math.sin(this.t * 0.7) * 0.9;
      this.want.set(chest.x + Math.cos(this.orbit) * r, chest.y + 1.6 + Math.sin(this.t * 1.3) * 0.45, chest.z + Math.sin(this.orbit) * r);
      // keep up with it
      this.want.addScaledVector(cvel, 0.5);
      // closing in to study it: right up to its face, the eye flaring, the turret whirring
      this.inspectTimer -= dt;
      if (this.inspectTimer <= 0 && this.inspecting <= 0) {
        this.inspecting = 1.6;
        this.inspectTimer = 4 + Math.random() * 2.5;
        this.audio.droneChirp(this.level(listener) * 0.9);
      }
      if (this.inspecting > 0) {
        this.inspecting -= dt;
        const a = Math.atan2(-dz, -dx);
        this.want.set(chest.x + Math.cos(a) * 1.25, chest.y + 0.35, chest.z + Math.sin(a) * 1.25);
        eye = 0.9 + 0.1 * Math.sin(time * 30);
        maxAcc = 30;
      }
      this.chirpTimer -= dt;
      if (this.chirpTimer <= 0) {
        this.chirpTimer = 2.5 + Math.random() * 3;
        if (Math.random() < 0.5) this.audio.droneChirp(this.level(listener) * 0.4);
      }
      if (this.t > STALK_TIME) {
        this.phase = 'lock';
        this.t = 0;
        this.inspecting = 0;
        // back and up, away from it
        this.lockFrom.set(chest.x - (dx / flat) * 5.5, chest.y + 4.2, chest.z - (dz / flat) * 5.5);
        this.audio.droneLock(this.level(listener));
      }
    } else if (this.phase === 'lock') {
      // hanging dead still, staring; the tone climbs
      this.want.copy(this.lockFrom);
      maxSpeed = 9;
      eye = 1;
      this.beepTimer -= dt;
      if (this.beepTimer <= 0) {
        const k = this.t / LOCK_TIME;
        this.beepTimer = Math.max(0.05, 0.42 * (1 - k) * (1 - k) + 0.05);
        this.audio.droneBeep(0.12 + k * 0.08, 1 + k * 0.5);
      }
      if (this.t > LOCK_TIME) {
        this.phase = 'dive';
        this.t = 0;
        this.audio.droneDive(this.level(listener));
      }
    } else if (this.phase === 'dive') {
      // straight at its chest, as hard as it can
      this.want.copy(chest);
      maxAcc = 70;
      maxSpeed = 30;
      eye = 1;
      if (P.distanceTo(chest) < 0.5 || this.t > 3) {
        this.hit = true;
        this.hitAt.copy(P);
        this.hitDir.copy(this.vel).normalize();
        this.phase = 'idle';
        this.root.visible = false;
        this.laser.visible = false;
        this.eyeGlow.strength = 0;
        this.audio.setDrone(0, 0, 0, 0);
        return;
      }
    }

    // never below head height over the ground, and clear over the station
    if (this.phase !== 'dive') {
      this.want.y = Math.max(this.want.y, terrainHeight(this.want.x, this.want.z) + 1.3);
      if (avoid && Math.hypot(this.want.x - avoid.x, this.want.z - avoid.z) < 9) this.want.y = Math.max(this.want.y, avoid.y + 4.4);
    }
    // a twitchy, hunting hover: never quite still
    const jit = this.phase === 'lock' ? 0.03 : 0.18;
    this.want.x += noise1(time * 1.7, 3) * jit;
    this.want.y += noise1(time * 2.1, 5) * jit * 0.7;
    this.want.z += noise1(time * 1.9, 7) * jit;

    // fly to it: a stiff spring, its push limited, its speed limited
    this.acc.subVectors(this.want, P).multiplyScalar(this.phase === 'dive' ? 60 : 9).addScaledVector(this.vel, this.phase === 'dive' ? -1 : -5.5);
    if (this.acc.length() > maxAcc) this.acc.setLength(maxAcc);
    this.vel.addScaledVector(this.acc, dt);
    if (this.vel.length() > maxSpeed) this.vel.setLength(maxSpeed);
    P.addScaledVector(this.vel, dt);
    if (this.phase !== 'dive') P.y = Math.max(P.y, ground + 0.6);

    // facing its prey, tipped into the way it is pushing, like any quadcopter
    const wantYaw = Math.atan2(dx, dz);
    let dy = wantYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * (this.phase === 'lock' ? 8 : 4));
    this.root.rotation.set(0, this.yaw, 0);
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const fwd = this.acc.x * s + this.acc.z * c;
    const side = this.acc.x * c - this.acc.z * s;
    this.frame.rotation.set(Math.max(-0.7, Math.min(0.7, fwd * 0.035)), 0, Math.max(-0.6, Math.min(0.6, -side * 0.035)));
    // props spin; the turret tracks its target's face
    for (const [i, r] of this.rotors.entries()) r.rotation.y += dt * (i % 2 ? -1 : 1) * (70 + this.vel.length() * 3);
    this.root.updateMatrixWorld(true);
    this.turret.lookAt(chest);

    // the eye, the strobe, the targeting line
    (this.eyeMat.uniforms.uLight.value as Vector3).lerpVectors(EYE_DIM, EYE_HOT, eye);
    this.eye.getWorldPosition(this.eyeGlow.position);
    this.eyeGlow.strength = 0.3 + eye * 0.9;
    const strobe = time % 1.1 < 0.05;
    (this.strobeMat.uniforms.uLight.value as Vector3).copy(strobe ? STROBE_ON : STROBE_OFF);
    const beam = this.phase === 'lock' || this.phase === 'dive';
    this.laser.visible = beam && (this.phase === 'dive' || this.t > 0.4);
    if (this.laser.visible) {
      this.laser.position.copy(this.eyeGlow.position);
      this.laser.lookAt(chest);
      this.laser.scale.set(1, 1, this.laser.position.distanceTo(chest));
    }

    // the whine of its props: louder close, higher as it works, screaming in the dive
    const throttle = Math.min(1, this.acc.length() / 25);
    this.tmp.subVectors(listener, P);
    const toward = this.tmp.lengthSq() > 0.01 ? this.vel.dot(this.tmp.normalize()) : 0;
    this.audio.setDrone(
      this.level(listener),
      Math.max(-0.9, Math.min(0.9, (P.x - listener.x) / 6)),
      throttle + Math.max(-0.2, Math.min(0.4, toward / 25)),
      this.phase === 'dive' ? 1 : 0,
    );
  }

  private level(listener: Vector3) {
    const d = this.root.position.distanceTo(listener);
    return 1 / (1 + (d * d) / 30);
  }
}
