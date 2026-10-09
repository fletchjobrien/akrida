import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  Object3D,
  TorusGeometry,
  Vector2,
  Vector3,
  type Material,
  type ShaderMaterial,
} from 'three';
import { clamp, noise1, rng, smoothstep } from '../core/math';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { SITE } from './crater';
import { terrainHeight } from './terrain';
import { footprintOf, type Rocks } from './rocks';
import type { Dust } from './particles';
import type { Wind } from './wind';
import type { AudioEngine } from '../audio/AudioEngine';

/** Flat-shaded copy of a geometry, so curved hulls read as pixel-art facets. */
function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

const C = (hex: number) => rgb(hex).toArray();
const SPARK_HOT = C(0xfff4c8);
const SPARK_COOL = C(0xd9824a);
const SMOKE_DARK = C(0x4a4242);
const SMOKE_LIGHT = C(0xb8aea2);
const SAND = [C(0xe4c987), C(0xbca872)];

const BEACON_ON = rgb(0xff5a3c);
const BEACON_OFF = rgb(0x5a2420);

/**
 * The wreck of an escape pod at the end of its skid trench: the pod nose-down
 * in the crater with its hatch hanging open, wreckage strewn along the trench
 * and past the rim, a smoking, sparking, beeping, slowly cooling scene.
 */
export class CrashSite {
  readonly group = new Group();
  readonly center = new Vector3();
  /** Set for one frame when the creature first comes close enough to see it. */
  justDiscovered = false;
  discovered = false;
  /** The pod's outline on the ground, as a collider. */
  footprint!: ReturnType<typeof footprintOf>;
  /** Distance from the listener last frame. */
  distance = Infinity;

  private readonly pod = new Group();
  private readonly hinge = new Object3D();
  private readonly beaconMat: ShaderMaterial;
  private readonly beacon: Mesh;
  private readonly sparkFrom = new Object3D();
  private readonly smokeFrom: Object3D[] = [];
  private readonly lookAt = new Vector3();

  private doorAngle = -1.75;
  private doorVel = 0;
  private creakCool = 0;
  private sparkTimer = 3;
  private tickTimer = 0.5;
  private trickleTimer = 2;
  private smokeDebt = 0;
  private beaconCycle = -1;
  private readonly tmp = new Vector3();

  constructor(
    rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    const hull = toonMaterial({ dark: 0x6f6a62, mid: 0xa8a294, light: 0xdcd6c8, litAt: 0.55, outline: 0.6, highlight: 1 });
    const charred = toonMaterial({ dark: 0x2b2424, mid: 0x463c38, light: 0x6a5d55, litAt: 0.55, outline: 0.6, highlight: 0.6 });
    const accent = toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0.6, highlight: 0.8 });
    const glass = toonMaterial({ dark: 0x10141c, mid: 0x1e2a38, light: 0x47677c, litAt: 0.5, outline: 0.6, highlight: 1 });
    const metal = toonMaterial({ dark: 0x2e2a2a, mid: 0x4a4542, light: 0x6e6862, litAt: 0.55, outline: 0.6, highlight: 0.8 });
    const hole = toonMaterial({ dark: 0x0e0b0c, mid: 0x0e0b0c, light: 0x0e0b0c, unlit: true, outline: 0.6 });
    this.beaconMat = toonMaterial({ dark: 0xff5a3c, mid: 0xff5a3c, light: 0xff5a3c, unlit: true, outline: 0 });

    const add = (parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number) => {
      const m = new Mesh(faceted(geo), mat);
      m.position.set(x, y, z);
      m.layers.enable(SHADOW_LAYER);
      parent.add(m);
      return m;
    };

    // ---- the pod, built along its local +Y axis (nose at +Y), hatch on +X
    const P = this.pod;
    const profile = [
      [0.56, -0.9],
      [0.62, -0.7],
      [0.62, 0.15],
      [0.56, 0.55],
      [0.44, 0.85],
      [0.26, 1.05],
      [0.08, 1.17],
      [0.0, 1.19],
    ].map(([r, y]) => new Vector2(r, y));
    add(P, new LatheGeometry(profile, 12), hull, 0, 0, 0);
    add(P, new CylinderGeometry(0.62, 0.5, 0.26, 12), charred, 0, -1.03, 0); // heat shield
    add(P, new CylinderGeometry(0.5, 0.5, 0.03, 12), charred, 0, -1.16, 0);
    add(P, new CylinderGeometry(0.633, 0.633, 0.11, 12, 1, true), accent, 0, 0.3, 0); // stripe
    add(P, new CylinderGeometry(0.633, 0.633, 0.05, 12, 1, true), accent, 0, -0.62, 0);
    add(P, new BoxGeometry(0.09, 0.64, 0.48), hole, 0.6, 0.02, 0); // open hatchway
    add(P, new BoxGeometry(0.07, 0.2, 0.24), glass, 0.52, 0.64, 0); // window
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      add(P, new CylinderGeometry(0.07, 0.12, 0.2, 8), metal, Math.cos(a) * 0.28, -1.27, Math.sin(a) * 0.28);
    }
    add(P, new BoxGeometry(0.04, 0.46, 0.32), hull, 0, -0.7, 0.76); // the fin that survived
    add(P, new BoxGeometry(0.05, 0.18, 0.09), charred, 0, -0.74, -0.66); // stub of the lost one
    const torn = add(P, new BoxGeometry(0.03, 0.32, 0.26), hull, 0.66, -0.36, -0.3); // peeled panel
    torn.rotation.z = -0.65;
    this.sparkFrom.position.set(0.62, -0.38, -0.3);
    P.add(this.sparkFrom);

    // antenna, bent in the crash, with the emergency beacon at its tip
    const mast = new Object3D();
    mast.position.set(0.48, -0.5, 0.32);
    mast.rotation.set(0.35, 0, -0.9);
    P.add(mast);
    add(mast, new CylinderGeometry(0.014, 0.014, 0.5, 4), metal, 0, 0.25, 0);
    this.beacon = add(mast, new BoxGeometry(0.075, 0.075, 0.075), this.beaconMat, 0, 0.52, 0);

    // the hatch door, hanging open from its hinge on the doorway's edge
    this.hinge.position.set(0.63, 0.02, 0.25);
    P.add(this.hinge);
    add(this.hinge, new BoxGeometry(0.05, 0.6, 0.47), hull, 0, 0, -0.235);
    add(this.hinge, new BoxGeometry(0.055, 0.08, 0.47), accent, 0, 0.2, -0.235);

    // smoke drifts out of the hatchway and off the scorched heat shield
    for (const [x, y, z] of [
      [0.62, 0.1, 0],
      [0.3, -1.1, 0.2],
    ]) {
      const o = new Object3D();
      o.position.set(x, y, z);
      P.add(o);
      this.smokeFrom.push(o);
    }

    // it slewed sideways at the end of the skid: nose-down in the crater, lying across
    // the view, rolled so the hatch faces up and toward the viewer
    const axis = new Vector3(1, -0.3, -0.12).normalize();
    const want = new Vector3(0, 1, 0.6).normalize();
    const hatch = want.clone().addScaledVector(axis, -want.dot(axis)).normalize();
    const side = new Vector3().crossVectors(hatch, axis);
    P.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(hatch, axis, side));
    const px = SITE.x + SITE.dx * 0.5;
    const pz = SITE.z + SITE.dz * 0.5;
    P.position.set(px, terrainHeight(px, pz) + 0.3, pz);
    P.scale.setScalar(1.15);
    this.group.add(P);
    this.center.set(px, terrainHeight(px, pz) + 0.5, pz);

    this.scatterDebris({ hull, charred, accent, metal, glass });

    this.group.updateMatrixWorld(true);
    // only the pod blocks the way; flat scraps of wreckage are stepped over
    this.footprint = footprintOf(P, 1.2);
    rocks.addStatic(this.footprint);
  }

  private scatterDebris(m: Record<'hull' | 'charred' | 'accent' | 'metal' | 'glass', Material>) {
    const rand = rng(90210);
    const L = 20;
    const sx = SITE.x - SITE.dx * L;
    const sz = SITE.z - SITE.dz * L;
    const px = -SITE.dz;
    const pz = SITE.dx;
    const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];

    const piece = (x: number, z: number, scale: number) => {
      const kind = rand();
      let geo: BufferGeometry;
      let mat: Material;
      if (kind < 0.38) {
        // a torn hull plate
        geo = new BoxGeometry(0.3 + rand() * 0.45, 0.04, 0.2 + rand() * 0.32);
        mat = pick([m.hull, m.hull, m.charred, m.accent]);
      } else if (kind < 0.6) {
        geo = new IcosahedronGeometry(0.1 + rand() * 0.12, 0);
        geo.scale(1, 0.6, 1.2);
        mat = pick([m.charred, m.metal, m.hull]);
      } else if (kind < 0.78) {
        // a strut or pipe
        geo = new CylinderGeometry(0.025, 0.025, 0.35 + rand() * 0.55, 5);
        geo.rotateZ(Math.PI / 2);
        mat = m.metal;
      } else if (kind < 0.9) {
        // a bent ring segment from the frame
        geo = new TorusGeometry(0.28 + rand() * 0.15, 0.03, 3, 7, Math.PI * (0.4 + rand() * 0.5));
        geo.rotateX(Math.PI / 2);
        mat = pick([m.metal, m.charred]);
      } else {
        geo = new BoxGeometry(0.16, 0.06, 0.12);
        mat = m.glass;
      }
      const mesh = new Mesh(faceted(geo), mat);
      mesh.scale.setScalar(scale);
      const y = terrainHeight(x, z);
      mesh.position.set(x, y - 0.015 - rand() * 0.04, z);
      mesh.rotation.set((rand() - 0.5) * 0.9, rand() * Math.PI * 2, (rand() - 0.5) * 0.9);
      mesh.layers.enable(SHADOW_LAYER);
      this.group.add(mesh);
    };

    // strewn along the trench, thicker near the crater, with a few bits right at its start
    for (let i = 0; i < 30; i++) {
      const t = i < 4 ? 0.02 + rand() * 0.1 : 0.12 + 0.85 * Math.pow(rand(), 0.65);
      const spread = (0.6 + 1.3 * t) * (rand() < 0.2 ? 3 : 1);
      const s = (rand() - 0.5) * 2 * spread;
      piece(sx + SITE.dx * t * L + px * s, sz + SITE.dz * t * L + pz * s, 0.8 + rand() * 0.6);
    }
    // thrown forward over the rim
    const fwd = Math.atan2(SITE.dz, SITE.dx);
    for (let i = 0; i < 16; i++) {
      const a = fwd + (rand() - 0.5) * 2.4;
      const r = 3.6 + rand() * 4.5;
      piece(SITE.x + Math.cos(a) * r, SITE.z + Math.sin(a) * r, 0.7 + rand() * 0.7);
    }
    // the fin that tore off, lying where it landed
    const fx = SITE.x - SITE.dx * 5.5 + px * 1.6;
    const fz = SITE.z - SITE.dz * 5.5 + pz * 1.6;
    const fin = new Group();
    const finPlate = new Mesh(faceted(new BoxGeometry(0.32, 0.04, 0.46)), m.hull);
    const finEdge = new Mesh(faceted(new BoxGeometry(0.33, 0.045, 0.06)), m.accent);
    finEdge.position.z = 0.2;
    fin.add(finPlate, finEdge);
    fin.position.set(fx, terrainHeight(fx, fz) + 0.01, fz);
    fin.rotation.set(0.25, 1.1, -0.15);
    fin.traverse((o) => o.layers.enable(SHADOW_LAYER));
    this.group.add(fin);
  }

  /** Where the creature looks when it notices the wreck. */
  get lookPoint() {
    return this.lookAt.copy(this.center);
  }

  update(dt: number, time: number, wind: Wind, listener: Vector3) {
    this.justDiscovered = false;
    const d = Math.hypot(listener.x - this.center.x, listener.z - this.center.z);
    this.distance = d;
    if (!this.discovered && d < 11) {
      this.discovered = true;
      this.justDiscovered = true;
    }
    const near = d < 60;
    this.pod.updateMatrixWorld(true);

    // ---- sound placement
    const level = near ? 1 / (1 + (d / 5) * (d / 5)) : 0;
    const pan = clamp((this.center.x - listener.x) / 9, -0.85, 0.85);
    const clarity = 1 - smoothstep(3, 28, d);
    const hum = 0.7 + 0.3 * noise1(time * 3.1, 77);
    this.audio.setSite(level * 1.6, pan, clarity, hum);

    // ---- emergency beacon: a red blink with a beep, sometimes doubled, sometimes missed
    const period = 1.7;
    const cycle = Math.floor(time / period);
    const ph = time - cycle * period;
    const roll = noise1(cycle * 1.37, 13) * 0.5 + 0.5;
    const skip = roll < 0.12;
    const doubled = roll > 0.82;
    const on = !skip && (ph < 0.12 || (doubled && ph > 0.22 && ph < 0.32));
    (this.beaconMat.uniforms.uLight.value as Vector3).copy(on ? BEACON_ON : BEACON_OFF);
    if (cycle !== this.beaconCycle) {
      this.beaconCycle = cycle;
      if (!skip && near) this.audio.siteBeep(0.5, roll > 0.75 ? 0.97 : 1);
    }
    if (doubled && near && ph > 0.22 && ph - dt <= 0.22) this.audio.siteBeep(0.4, 0.97);
    this.beacon.scale.setScalar(on ? 1.15 : 1);

    // ---- the hatch door swings on its hinge in the gusts, knocking back against the hull
    const push = wind.strength * (0.8 + 0.6 * noise1(time * 0.9, 31)) + wind.flutter * 0.25;
    const rest = -1.7;
    const acc = -7 * (this.doorAngle - rest) - 1.1 * this.doorVel - push * 2.2;
    this.doorVel += acc * dt;
    this.doorAngle += this.doorVel * dt;
    const stop = -2.3;
    if (this.doorAngle < stop) {
      const hit = Math.abs(this.doorVel);
      this.doorAngle = stop;
      this.doorVel = hit * 0.35;
      if (hit > 0.2 && near) this.audio.siteClank(Math.min(0.6, hit * 0.45));
    }
    this.hinge.rotation.y = this.doorAngle;
    this.creakCool -= dt;
    if (Math.abs(this.doorVel) > 0.32 && this.creakCool <= 0 && near) {
      this.audio.siteCreak(Math.min(0.45, Math.abs(this.doorVel) * 0.35), 0.8 + Math.abs(this.doorVel) * 0.3);
      this.creakCool = 0.9 + Math.random() * 0.8;
    }

    if (!near) return;

    // ---- smoke: a thin plume, darker near the wreck, carried off by the wind
    this.smokeDebt += dt * 16;
    while (this.smokeDebt >= 1) {
      this.smokeDebt -= 1;
      const src = this.smokeFrom[Math.random() < 0.7 ? 0 : 1];
      src.getWorldPosition(this.tmp);
      this.dust.spawn(
        this.tmp.x + (Math.random() - 0.5) * 0.15,
        this.tmp.y,
        this.tmp.z + (Math.random() - 0.5) * 0.15,
        (Math.random() - 0.5) * 0.15,
        0.55 + Math.random() * 0.45,
        (Math.random() - 0.5) * 0.15,
        3.5 + Math.random() * 2.5,
        SMOKE_DARK,
        Math.random() < 0.3 ? 3 : 2,
        { g: -0.25, drag: 0.45, windK: 0.9, c2: SMOKE_LIGHT },
      );
    }

    // ---- sparks spit from the torn panel now and then
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 2.2 + Math.random() * 5;
      this.sparkFrom.getWorldPosition(this.tmp);
      const n = 7 + Math.floor(Math.random() * 10);
      for (let i = 0; i < n; i++) {
        this.dust.spawn(
          this.tmp.x,
          this.tmp.y,
          this.tmp.z,
          (Math.random() - 0.5) * 3,
          1 + Math.random() * 2.2,
          (Math.random() - 0.5) * 3,
          0.25 + Math.random() * 0.4,
          SPARK_HOT,
          1,
          { g: 9, drag: 1.2, windK: 0.1, c2: SPARK_COOL },
        );
      }
      this.audio.siteSpark(0.55);
      if (Math.random() < 0.5) this.sparkTimer = 0.18; // a second, smaller spit
    }

    // ---- hot metal ticking as it cools
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) {
      this.tickTimer = 0.12 + Math.random() * 1.1;
      this.audio.siteTick(0.18 + Math.random() * 0.3);
    }

    // ---- loose sand slips down the crater walls
    this.trickleTimer -= dt;
    if (this.trickleTimer <= 0) {
      this.trickleTimer = 1.2 + Math.random() * 3;
      const a = Math.random() * Math.PI * 2;
      const r = 3.3;
      const x = SITE.x + Math.cos(a) * r;
      const z = SITE.z + Math.sin(a) * r;
      const y = terrainHeight(x, z) + 0.03;
      for (let i = 0; i < 8; i++) {
        this.dust.spawn(
          x + (Math.random() - 0.5) * 0.3,
          y,
          z + (Math.random() - 0.5) * 0.3,
          -Math.cos(a) * (0.5 + Math.random() * 0.6),
          0.1,
          -Math.sin(a) * (0.5 + Math.random() * 0.6),
          1 + Math.random() * 0.8,
          SAND[i % 2],
          1,
          { g: 3, drag: 0.6, windK: 0.2 },
        );
      }
    }
  }
}
