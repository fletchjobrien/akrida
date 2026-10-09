import {
  BoxGeometry,
  BufferAttribute,
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
import { SITE, SITE2, SKID } from './crater';
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
const ARC_HOT = C(0xf2fbff);
const ARC_COOL = C(0x6aa8ff);
const SMOKE_DARK = C(0x4a4242);
const SMOKE_LIGHT = C(0xb8aea2);
const VAPOUR = C(0xf4f7f8);
const VAPOUR_THIN = C(0xc9d4da);
const SAND = [C(0xe4c987), C(0xbca872)];

const BEACON_ON = rgb(0xff5a3c);
const BEACON_OFF = rgb(0x5a2420);
const AMBER = [rgb(0x4a3418), rgb(0x9c6a24), rgb(0xffb347)];
const LIGHT_STEPS = [rgb(0x0e0b0c), rgb(0x2a3a48), rgb(0x8fb4cc), rgb(0xe8f6ff)];

/** Which wreck: the first (nose down in its crater) or the second (skidded in low, its survivor gone). */
export type PodVariant = 'first' | 'second';

type Mats = Record<'hull' | 'charred' | 'accent' | 'metal' | 'glass' | 'hole', Material>;

/**
 * The wreck of an escape pod. Both pods are the same model; they differ in how
 * they came down, how they broke, what they shed and what still moves:
 *
 * - The first came down steeply: nose-down in an impact crater at the end of
 *   its trench, hatch door hanging and swinging, a torn panel spitting sparks,
 *   smoke, a blinking red beacon on a bent antenna.
 * - The second came in low and skidded: lying almost flat at the end of a long
 *   shallow trench with skip marks before it, nose crumpled into a bank of
 *   sand, hatch blown off, a split coolant line venting in bursts, a severed
 *   cable arcing, a stuttering cabin light, and its beacon snapped off and
 *   dying amber in the sand.
 */
export class CrashSite {
  readonly group = new Group();
  readonly center = new Vector3();
  /** Where someone climbing out of the hatch lands on the sand. */
  readonly hatchGround = new Vector3();
  /** Set for one frame when the creature first comes close enough to see it. */
  justDiscovered = false;
  discovered = false;
  /** The pod's outline on the ground, as a collider. */
  footprint!: ReturnType<typeof footprintOf>;
  /** Distance from the listener last frame. */
  distance = Infinity;

  private readonly pod = new Group();
  private readonly sound: number;
  private readonly lookAt = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private trickleTimer = 2;
  private tickTimer = 0.5;

  // the first pod
  private readonly hinge = new Object3D();
  private beaconMat!: ShaderMaterial;
  private beacon!: Mesh;
  private readonly sparkFrom = new Object3D();
  private readonly smokeFrom: Object3D[] = [];
  private doorAngle = -1.75;
  private doorVel = 0;
  private creakCool = 0;
  private sparkTimer = 3;
  private smokeDebt = 0;
  private beaconCycle = -1;

  // the second pod
  private lightMat!: ShaderMaterial;
  private lightOn = 1;
  private lightTimer = 1;
  private lightMode: 'steady' | 'stutter' | 'out' = 'steady';
  private readonly ventFrom = new Object3D();
  private ventTimer = 2;
  private ventLeft = 0;
  private ventDebt = 0;
  private readonly cable: Object3D[] = [];
  private readonly cableTip = new Object3D();
  private cableAngle = 0.2;
  private cableVel = 0;
  private arcTimer = 4;
  private sandBeacon!: ShaderMaterial;
  private sandBeaconPos = new Vector3();
  private warbleCycle = -1;

  constructor(
    rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    readonly variant: PodVariant = 'first',
  ) {
    this.sound = audio.addSite(variant === 'first' ? 'power' : 'buzz');
    const m: Mats = {
      hull: toonMaterial({ dark: 0x6f6a62, mid: 0xa8a294, light: 0xdcd6c8, litAt: 0.55, outline: 0.6, highlight: 1 }),
      charred: toonMaterial({ dark: 0x2b2424, mid: 0x463c38, light: 0x6a5d55, litAt: 0.55, outline: 0.6, highlight: 0.6 }),
      accent: toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0.6, highlight: 0.8 }),
      glass: toonMaterial({ dark: 0x10141c, mid: 0x1e2a38, light: 0x47677c, litAt: 0.5, outline: 0.6, highlight: 1 }),
      metal: toonMaterial({ dark: 0x2e2a2a, mid: 0x4a4542, light: 0x6e6862, litAt: 0.55, outline: 0.6, highlight: 0.8 }),
      hole: toonMaterial({ dark: 0x0e0b0c, mid: 0x0e0b0c, light: 0x0e0b0c, unlit: true, outline: 0.6 }),
    };
    this.buildHull(m);
    if (variant === 'first') this.buildFirst(m);
    else this.buildSecond(m);

    this.group.updateMatrixWorld(true);
    // only the pod blocks the way; flat scraps of wreckage are stepped over
    this.footprint = footprintOf(this.pod, 1.2);
    rocks.addStatic(this.footprint);
  }

  private add(parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number) {
    const mesh = new Mesh(faceted(geo), mat);
    mesh.position.set(x, y, z);
    mesh.layers.enable(SHADOW_LAYER);
    parent.add(mesh);
    return mesh;
  }

  /** The hull both pods share, built along its local +Y axis (nose at +Y), hatch on +X. */
  private buildHull(m: Mats) {
    const P = this.pod;
    const second = this.variant === 'second';
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
    const shell = new LatheGeometry(profile, 12);
    if (second) {
      // the nose took the skid: shoved back, bent over and caved in on one side
      const pos = shell.getAttribute('position') as BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const k = smoothstep(0.55, 1.19, y);
        const dent = z > 0 ? 1 - 0.45 * k * smoothstep(0, 0.4, z) : 1;
        pos.setXYZ(i, x * (1 - 0.12 * k) - 0.16 * k, y - 0.24 * k, z * dent);
      }
    }
    this.add(P, shell, m.hull, 0, 0, 0);
    if (second) {
      // the heat shield cracked open: a third of it is gone, showing the frame behind
      const shield = new CylinderGeometry(0.62, 0.5, 0.26, 12, 1, false, 2.2, Math.PI * 1.35);
      this.add(P, shield, m.charred, 0, -1.03, 0);
      this.add(P, new CylinderGeometry(0.55, 0.47, 0.22, 12, 1, false, 2.2 + Math.PI * 1.35, Math.PI * 0.65), m.metal, 0, -1.02, 0);
    } else {
      this.add(P, new CylinderGeometry(0.62, 0.5, 0.26, 12), m.charred, 0, -1.03, 0); // heat shield
    }
    this.add(P, new CylinderGeometry(0.5, 0.5, 0.03, 12), m.charred, 0, -1.16, 0);
    this.add(P, new CylinderGeometry(0.633, 0.633, 0.11, 12, 1, true), m.accent, 0, 0.3, 0); // stripe
    this.add(P, new CylinderGeometry(0.633, 0.633, 0.05, 12, 1, true), m.accent, 0, -0.62, 0);
    this.add(P, new BoxGeometry(0.09, 0.64, 0.48), m.hole, 0.6, 0.02, 0); // open hatchway
    this.add(P, new BoxGeometry(0.07, 0.2, 0.24), m.glass, 0.52, 0.64, 0); // window
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.4;
      // the second pod tore one thruster bell off on the sand
      if (second && k === 1) continue;
      this.add(P, new CylinderGeometry(0.07, 0.12, 0.2, 8), m.metal, Math.cos(a) * 0.28, -1.27, Math.sin(a) * 0.28);
    }
  }

  // --------------------------------------------------------------- first pod

  private buildFirst(m: Mats) {
    const P = this.pod;
    this.add(P, new BoxGeometry(0.04, 0.46, 0.32), m.hull, 0, -0.7, 0.76); // the fin that survived
    this.add(P, new BoxGeometry(0.05, 0.18, 0.09), m.charred, 0, -0.74, -0.66); // stub of the lost one
    const torn = this.add(P, new BoxGeometry(0.03, 0.32, 0.26), m.hull, 0.66, -0.36, -0.3); // peeled panel
    torn.rotation.z = -0.65;
    this.sparkFrom.position.set(0.62, -0.38, -0.3);
    P.add(this.sparkFrom);

    // antenna, bent in the crash, with the emergency beacon at its tip
    this.beaconMat = toonMaterial({ dark: 0xff5a3c, mid: 0xff5a3c, light: 0xff5a3c, unlit: true, outline: 0 });
    const mast = new Object3D();
    mast.position.set(0.48, -0.5, 0.32);
    mast.rotation.set(0.35, 0, -0.9);
    P.add(mast);
    this.add(mast, new CylinderGeometry(0.014, 0.014, 0.5, 4), m.metal, 0, 0.25, 0);
    this.beacon = this.add(mast, new BoxGeometry(0.075, 0.075, 0.075), this.beaconMat, 0, 0.52, 0);

    // the hatch door, hanging open from its hinge on the doorway's edge
    this.hinge.position.set(0.63, 0.02, 0.25);
    P.add(this.hinge);
    this.add(this.hinge, new BoxGeometry(0.05, 0.6, 0.47), m.hull, 0, 0, -0.235);
    this.add(this.hinge, new BoxGeometry(0.055, 0.08, 0.47), m.accent, 0, 0.2, -0.235);

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
    this.place(new Vector3(SITE.dx, -0.3, SITE.dz), SITE.x + SITE.dx * 0.5, SITE.z + SITE.dz * 0.5, 0.3);
    this.scatterFirst(m);
  }

  /** Orient the pod along `axis` with its hatch up toward the viewer, and set it down at (x, z). */
  private place(axis: Vector3, x: number, z: number, lift: number) {
    const P = this.pod;
    axis.normalize();
    const want = new Vector3(0, 1, 0.6).normalize();
    const hatch = want.clone().addScaledVector(axis, -want.dot(axis)).normalize();
    const side = new Vector3().crossVectors(hatch, axis);
    P.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(hatch, axis, side));
    P.position.set(x, terrainHeight(x, z) + lift, z);
    P.scale.setScalar(1.15);
    this.group.add(P);
    this.center.set(x, terrainHeight(x, z) + 0.5, z);
    // below the hatch, on the sand
    const out = hatch.clone().setY(0).normalize();
    this.hatchGround.set(x + out.x * 1.05, 0, z + out.z * 1.05);
    this.hatchGround.y = terrainHeight(this.hatchGround.x, this.hatchGround.z);
  }

  /** One random piece of wreckage lying on the sand. */
  private piece(m: Mats, rand: () => number, x: number, z: number, scale: number, kinds: number[]) {
    const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
    const kind = pick(kinds);
    let geo: BufferGeometry;
    let mat: Material;
    switch (kind) {
      case 0: // a torn hull plate
        geo = new BoxGeometry(0.3 + rand() * 0.45, 0.04, 0.2 + rand() * 0.32);
        mat = pick([m.hull, m.hull, m.charred, m.accent]);
        break;
      case 1: // a lump of something
        geo = new IcosahedronGeometry(0.1 + rand() * 0.12, 0);
        geo.scale(1, 0.6, 1.2);
        mat = pick([m.charred, m.metal, m.hull]);
        break;
      case 2: // a strut or pipe
        geo = new CylinderGeometry(0.025, 0.025, 0.35 + rand() * 0.55, 5);
        geo.rotateZ(Math.PI / 2);
        mat = m.metal;
        break;
      case 3: // a bent ring segment from the frame
        geo = new TorusGeometry(0.28 + rand() * 0.15, 0.03, 3, 7, Math.PI * (0.4 + rand() * 0.5));
        geo.rotateX(Math.PI / 2);
        mat = pick([m.metal, m.charred]);
        break;
      case 4: // a pane of glass
        geo = new BoxGeometry(0.16, 0.06, 0.12);
        mat = m.glass;
        break;
      case 5: // a shard of heat shield, curved and charred
        geo = new CylinderGeometry(0.6, 0.55, 0.06 + rand() * 0.05, 6, 1, true, 0, 0.5 + rand() * 0.6);
        mat = m.charred;
        break;
      case 6: // a glittering splinter of window
        geo = new BoxGeometry(0.05 + rand() * 0.06, 0.02, 0.03 + rand() * 0.04);
        mat = m.glass;
        break;
      default: // a loop of cable
        geo = new TorusGeometry(0.1 + rand() * 0.06, 0.012, 3, 8, Math.PI * (1.2 + rand() * 0.7));
        geo.rotateX(Math.PI / 2);
        mat = m.charred;
    }
    const mesh = new Mesh(faceted(geo), mat);
    mesh.scale.setScalar(scale);
    const y = terrainHeight(x, z);
    mesh.position.set(x, y - 0.015 - rand() * 0.04, z);
    mesh.rotation.set((rand() - 0.5) * 0.9, rand() * Math.PI * 2, (rand() - 0.5) * 0.9);
    mesh.layers.enable(SHADOW_LAYER);
    this.group.add(mesh);
    return mesh;
  }

  private scatterFirst(m: Mats) {
    const rand = rng(90210);
    const L = 20;
    const sx = SITE.x - SITE.dx * L;
    const sz = SITE.z - SITE.dz * L;
    const px = -SITE.dz;
    const pz = SITE.dx;
    const kinds = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4];
    // strewn along the trench, thicker near the crater, with a few bits right at its start
    for (let i = 0; i < 30; i++) {
      const t = i < 4 ? 0.02 + rand() * 0.1 : 0.12 + 0.85 * Math.pow(rand(), 0.65);
      const spread = (0.6 + 1.3 * t) * (rand() < 0.2 ? 3 : 1);
      const s = (rand() - 0.5) * 2 * spread;
      this.piece(m, rand, sx + SITE.dx * t * L + px * s, sz + SITE.dz * t * L + pz * s, 0.8 + rand() * 0.6, kinds);
    }
    // thrown forward over the rim
    const fwd = Math.atan2(SITE.dz, SITE.dx);
    for (let i = 0; i < 16; i++) {
      const a = fwd + (rand() - 0.5) * 2.4;
      const r = 3.6 + rand() * 4.5;
      this.piece(m, rand, SITE.x + Math.cos(a) * r, SITE.z + Math.sin(a) * r, 0.7 + rand() * 0.7, kinds);
    }
    // the fin that tore off, lying where it landed
    const fx = SITE.x - SITE.dx * 5.5 + px * 1.6;
    const fz = SITE.z - SITE.dz * 5.5 + pz * 1.6;
    this.fin(m, fx, fz, 1.1);
  }

  private fin(m: Mats, x: number, z: number, yaw: number) {
    const fin = new Group();
    const plate = new Mesh(faceted(new BoxGeometry(0.32, 0.04, 0.46)), m.hull);
    const edge = new Mesh(faceted(new BoxGeometry(0.33, 0.045, 0.06)), m.accent);
    edge.position.z = 0.2;
    fin.add(plate, edge);
    fin.position.set(x, terrainHeight(x, z) + 0.01, z);
    fin.rotation.set(0.25, yaw, -0.15);
    fin.traverse((o) => o.layers.enable(SHADOW_LAYER));
    this.group.add(fin);
  }

  // -------------------------------------------------------------- second pod

  private buildSecond(m: Mats) {
    const P = this.pod;
    // it skidded in low: almost flat, the crumpled nose shoved into the sand it ploughed up
    this.place(new Vector3(SITE2.dx, -0.07, SITE2.dz), SITE2.x, SITE2.z, 0.36);
    // which of its sides (local ±Z) faces the viewer, so the gash shows
    const facing = new Vector3(0, 0, 1).applyQuaternion(P.quaternion).z >= 0 ? 1 : -1;
    // it lost the other fin
    this.add(P, new BoxGeometry(0.04, 0.46, 0.32), m.hull, 0, -0.7, -0.76);
    this.add(P, new BoxGeometry(0.05, 0.14, 0.09), m.charred, 0, -0.76, 0.66);
    // a crack across the window
    this.add(P, new BoxGeometry(0.075, 0.025, 0.2), m.hull, 0.525, 0.66, 0).rotation.x = 0.6;
    // the antenna snapped off at its root
    this.add(P, new CylinderGeometry(0.02, 0.02, 0.07, 4), m.metal, 0.5, -0.5, 0.3).rotation.z = -0.9;

    // a cabin light, still stuttering on somewhere inside the open hatchway
    this.lightMat = toonMaterial({ dark: 0x8fb4cc, mid: 0x8fb4cc, light: 0x8fb4cc, unlit: true, outline: 0 });
    this.add(P, new BoxGeometry(0.02, 0.07, 0.34), this.lightMat, 0.648, 0.24, 0);
    this.add(P, new BoxGeometry(0.02, 0.2, 0.05), this.lightMat, 0.648, 0.05, -0.19);

    // a gash ripped along its flank, the skin peeled back around it
    const gash = new Object3D();
    gash.position.set(0.42, -0.25, 0.44 * facing);
    gash.rotation.y = (-Math.PI / 4) * facing;
    P.add(gash);
    this.add(gash, new BoxGeometry(0.06, 0.5, 0.11), m.hole, 0, 0, 0);
    const lipA = this.add(gash, new BoxGeometry(0.025, 0.46, 0.08), m.hull, 0.04, 0.02, 0.09);
    lipA.rotation.y = 0.9;
    const lipB = this.add(gash, new BoxGeometry(0.025, 0.3, 0.07), m.charred, 0.035, -0.06, -0.09);
    lipB.rotation.y = -0.8;
    // the split coolant line vents from the top of the gash
    this.add(gash, new CylinderGeometry(0.018, 0.018, 0.16, 5), m.metal, 0.05, 0.27, 0.02).rotation.x = 1.2;
    this.ventFrom.position.set(0.07, 0.3, 0.09);
    gash.add(this.ventFrom);
    // a severed cable hangs out of it, swinging
    let parent: Object3D = gash;
    for (let i = 0; i < 3; i++) {
      const seg = new Object3D();
      seg.position.set(i === 0 ? 0.05 : 0, i === 0 ? -0.2 : -0.13, 0);
      parent.add(seg);
      this.add(seg, new BoxGeometry(0.022, 0.13, 0.022), m.charred, 0, -0.065, 0);
      this.cable.push(seg);
      parent = seg;
    }
    this.cableTip.position.set(0, -0.13, 0);
    parent.add(this.cableTip);
    this.scatterSecond(m);
  }

  private scatterSecond(m: Mats) {
    const rand = rng(31337);
    const dx = SITE2.dx;
    const dz = SITE2.dz;
    const px = -dz;
    const pz = dx;
    // the side toward the viewer, where things are easy to see
    const near = pz >= 0 ? 1 : -1;
    const at = (a: number, s: number) => [SITE2.x + dx * a + px * s, SITE2.z + dz * a + pz * s] as const;
    // where it first touched down and skipped: a spray of small, light bits
    for (const c of [-SKID - 5.4, -SKID - 2.3]) {
      for (let i = 0; i < 5; i++) {
        const [x, z] = at(c + (rand() - 0.3) * 2.5, (rand() - 0.5) * 2.2);
        this.piece(m, rand, x, z, 0.6 + rand() * 0.4, [0, 6, 6, 7, 2]);
      }
    }
    // along the skid: shield shards and window glass early, heavier pieces near the end
    for (let i = 0; i < 34; i++) {
      const t = Math.pow(rand(), 0.8);
      const spread = (0.5 + 1.5 * t) * (rand() < 0.15 ? 2.6 : 1);
      const [x, z] = at(-SKID * (1 - t) - 1.2, (rand() - 0.5) * 2 * spread);
      this.piece(m, rand, x, z, 0.7 + rand() * 0.6, t < 0.5 ? [5, 5, 6, 6, 6, 0, 7] : [0, 0, 1, 2, 3, 5, 6, 7]);
    }
    // the hatch door, blown off and thrown clear
    const [hx, hz] = at(-7.5, near * 3.1);
    const door = new Group();
    door.add(new Mesh(faceted(new BoxGeometry(0.05, 0.6, 0.47)), m.hull));
    const band = new Mesh(faceted(new BoxGeometry(0.055, 0.08, 0.47)), m.accent);
    band.position.y = 0.2;
    door.add(band);
    door.scale.setScalar(1.15);
    door.position.set(hx, terrainHeight(hx, hz) + 0.02, hz);
    door.rotation.set(Math.PI / 2 - 0.15, 0.7, 0.2, 'YXZ');
    door.traverse((o) => o.layers.enable(SHADOW_LAYER));
    this.group.add(door);
    // the fin, torn off at the first skip
    const [fx, fz] = at(-SKID - 3.5, -near * 1.4);
    this.fin(m, fx, fz, 2.4);
    // a coolant canister that rolled away
    const [cx, cz] = at(-11, -near * 2.6);
    const can = new Group();
    const body = new Mesh(faceted(new CylinderGeometry(0.1, 0.1, 0.42, 7)), m.metal);
    const stripe = new Mesh(faceted(new CylinderGeometry(0.105, 0.105, 0.06, 7)), m.accent);
    can.add(body, stripe);
    can.position.set(cx, terrainHeight(cx, cz) + 0.07, cz);
    can.rotation.set(Math.PI / 2, 0, 0.8);
    can.traverse((o) => o.layers.enable(SHADOW_LAYER));
    this.group.add(can);
    // the antenna, snapped off, its beacon lying in the sand still blinking
    const [bx, bz] = at(-2.4, near * 1.7);
    const mast = this.add(this.group, new CylinderGeometry(0.016, 0.016, 0.55, 4), m.metal, bx, terrainHeight(bx, bz) + 0.02, bz);
    mast.rotation.set(Math.PI / 2, 0, 0.5);
    this.sandBeacon = toonMaterial({ dark: 0x4a3418, mid: 0x4a3418, light: 0x4a3418, unlit: true, outline: 0 });
    this.sandBeaconPos.set(bx + Math.sin(0.5) * 0.3, terrainHeight(bx, bz) + 0.03, bz + Math.cos(0.5) * 0.3);
    const b = this.add(this.group, new BoxGeometry(0.11, 0.09, 0.11), this.sandBeacon, 0, 0, 0);
    b.position.copy(this.sandBeaconPos);
    b.rotation.set(0.4, 0.3, 0.5);
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
    const level = near ? 1 / (1 + (d / 5) * (d / 5)) : 0;
    const pan = clamp((this.center.x - listener.x) / 9, -0.85, 0.85);
    const clarity = 1 - smoothstep(3, 28, d);
    if (this.variant === 'first') this.updateFirst(dt, time, wind, near, level, pan, clarity);
    else this.updateSecond(dt, time, wind, near, level, pan, clarity);
    if (!near) return;

    // ---- loose sand slips back into the hollow it made
    this.trickleTimer -= dt;
    if (this.trickleTimer <= 0) {
      this.trickleTimer = 1.2 + Math.random() * 3;
      let x: number;
      let z: number;
      let vx: number;
      let vz: number;
      if (this.variant === 'first') {
        const a = Math.random() * Math.PI * 2;
        x = SITE.x + Math.cos(a) * 3.3;
        z = SITE.z + Math.sin(a) * 3.3;
        vx = -Math.cos(a);
        vz = -Math.sin(a);
      } else {
        // down the bank of sand heaped against the nose, or the trench walls
        const side = Math.random() < 0.5 ? -1 : 1;
        const a = Math.random() < 0.4 ? 1.6 : -1 - Math.random() * 8;
        const s = a > 0 ? (Math.random() - 0.5) * 1.6 : side * 1.1;
        x = SITE2.x + SITE2.dx * a - SITE2.dz * s;
        z = SITE2.z + SITE2.dz * a + SITE2.dx * s;
        vx = a > 0 ? -SITE2.dx : SITE2.dz * side;
        vz = a > 0 ? -SITE2.dz : -SITE2.dx * side;
      }
      const y = terrainHeight(x, z) + 0.03;
      for (let i = 0; i < 8; i++) {
        const k = 0.5 + Math.random() * 0.6;
        this.dust.spawn(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3, vx * k, 0.1, vz * k, 1 + Math.random() * 0.8, SAND[i % 2], 1, {
          g: 3,
          drag: 0.6,
          windK: 0.2,
        });
      }
    }

    // ---- hot metal ticking as it cools
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) {
      this.tickTimer = (this.variant === 'first' ? 0.12 : 0.6) + Math.random() * (this.variant === 'first' ? 1.1 : 2.5);
      this.audio.siteTick(this.sound, (0.18 + Math.random() * 0.3) * (this.variant === 'first' ? 1 : 0.6));
    }
  }

  private updateFirst(dt: number, time: number, wind: Wind, near: boolean, level: number, pan: number, clarity: number) {
    const hum = 0.7 + 0.3 * noise1(time * 3.1, 77);
    this.audio.setSite(this.sound, level * 1.6, pan, clarity, hum);

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
      if (!skip && near) this.audio.siteBeep(this.sound, 0.5, roll > 0.75 ? 0.97 : 1);
    }
    if (doubled && near && ph > 0.22 && ph - dt <= 0.22) this.audio.siteBeep(this.sound, 0.4, 0.97);
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
      if (hit > 0.2 && near) this.audio.siteClank(this.sound, Math.min(0.6, hit * 0.45));
    }
    this.hinge.rotation.y = this.doorAngle;
    this.creakCool -= dt;
    if (Math.abs(this.doorVel) > 0.32 && this.creakCool <= 0 && near) {
      this.audio.siteCreak(this.sound, Math.min(0.45, Math.abs(this.doorVel) * 0.35), 0.8 + Math.abs(this.doorVel) * 0.3);
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
      this.audio.siteSpark(this.sound, 0.55);
      if (Math.random() < 0.5) this.sparkTimer = 0.18; // a second, smaller spit
    }
  }

  private updateSecond(dt: number, time: number, wind: Wind, near: boolean, level: number, pan: number, clarity: number) {
    // ---- the cabin light: a dying fluorescent tube, steady for a while, then stuttering, then out
    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      const r = Math.random();
      this.lightMode = r < 0.45 ? 'steady' : r < 0.85 ? 'stutter' : 'out';
      this.lightTimer = this.lightMode === 'stutter' ? 0.6 + Math.random() * 1.6 : 1.5 + Math.random() * 4;
    }
    let light = 0;
    if (this.lightMode === 'steady') light = noise1(time * 30, 5) > -0.85 ? 2 : 1;
    else if (this.lightMode === 'stutter') {
      // the tube strikes and fails, strikes and fails
      this.lightOn -= dt;
      if (this.lightOn <= 0) this.lightOn = 0.03 + Math.random() * 0.12;
      light = Math.sin(time * 37 + noise1(time * 9, 8) * 6) > 0.1 ? 3 : Math.random() < 0.5 ? 1 : 0;
    }
    (this.lightMat.uniforms.uLight.value as Vector3).copy(LIGHT_STEPS[light]);
    this.audio.setSite(this.sound, level * 1.6, pan, clarity, light >= 2 ? (light === 3 ? 1 : 0.55) : 0);

    // ---- the beacon in the sand: a slow amber pulse that sometimes falters
    const period = 2.6;
    const cycle = Math.floor(time / period);
    const ph = (time - cycle * period) / period;
    const roll = noise1(cycle * 0.91, 44) * 0.5 + 0.5;
    const pulse = roll < 0.18 ? 0 : Math.sin(Math.min(1, ph / 0.35) * Math.PI) * (roll < 0.35 ? 0.5 : 1);
    (this.sandBeacon.uniforms.uLight.value as Vector3).copy(AMBER[pulse > 0.7 ? 2 : pulse > 0.15 ? 1 : 0]);
    if (cycle !== this.warbleCycle) {
      this.warbleCycle = cycle;
      if (near && roll >= 0.18) this.audio.siteWarble(this.sound, roll < 0.35 ? 0.12 : 0.22, 0.97 + roll * 0.06);
    }

    // ---- the severed cable sways in the wind; when it swings in close it arcs to the hull
    const push = wind.strength * (0.7 + 0.6 * noise1(time * 1.1, 52)) + wind.flutter * 0.3;
    const acc = -9 * (this.cableAngle - 0.15) - 0.8 * this.cableVel + push * 2.4;
    this.cableVel += acc * dt;
    this.cableAngle += this.cableVel * dt;
    this.cable[0].rotation.z = this.cableAngle;
    this.cable[1].rotation.z = this.cableAngle * 0.5 + Math.sin(time * 2.3) * 0.08;
    this.cable[2].rotation.z = this.cableAngle * 0.3 + Math.sin(time * 3.1 + 1) * 0.12;

    if (!near) return;

    this.arcTimer -= dt;
    if (this.arcTimer <= 0) {
      this.arcTimer = 1.8 + Math.random() * 5.5;
      this.cableTip.getWorldPosition(this.tmp);
      const n = 6 + Math.floor(Math.random() * 8);
      for (let i = 0; i < n; i++) {
        this.dust.spawn(
          this.tmp.x,
          this.tmp.y,
          this.tmp.z,
          (Math.random() - 0.5) * 2.2,
          0.4 + Math.random() * 1.6,
          (Math.random() - 0.5) * 2.2,
          0.12 + Math.random() * 0.3,
          ARC_HOT,
          1,
          { g: 7, drag: 2, windK: 0.05, c2: ARC_COOL },
        );
      }
      this.audio.siteZap(this.sound, 0.5);
      // the light gutters with every arc
      this.lightMode = 'stutter';
      this.lightTimer = 0.4;
      if (Math.random() < 0.35) this.arcTimer = 0.1 + Math.random() * 0.15;
    }

    // ---- the split coolant line: bursts of white vapour that sink and roll along the sand
    this.ventTimer -= dt;
    if (this.ventTimer <= 0 && this.ventLeft <= 0) {
      this.ventLeft = 1.1 + Math.random() * 1.6;
      this.ventTimer = this.ventLeft + 2.5 + Math.random() * 5;
      this.audio.siteHiss(this.sound, 0.12, this.ventLeft);
    }
    const venting = this.ventLeft > 0;
    if (venting) this.ventLeft -= dt;
    this.ventDebt += dt * (venting ? 70 * Math.min(1, this.ventLeft * 2 + 0.3) : 2.5);
    if (this.ventDebt >= 1) {
      this.ventFrom.getWorldPosition(this.tmp);
      // the jet points out of the gash, flattened: it is heavy and cold
      this.tmp2.set(1, 0, 0.4).applyQuaternion(this.ventFrom.getWorldQuaternion(this.pod.quaternion.clone()));
      this.tmp2.y = 0.12;
      this.tmp2.normalize();
      while (this.ventDebt >= 1) {
        this.ventDebt -= 1;
        const sp = venting ? 1.8 + Math.random() * 1.6 : 0.3;
        this.dust.spawn(
          this.tmp.x,
          this.tmp.y,
          this.tmp.z,
          this.tmp2.x * sp + (Math.random() - 0.5) * 0.5,
          this.tmp2.y * sp + (Math.random() - 0.5) * 0.3,
          this.tmp2.z * sp + (Math.random() - 0.5) * 0.5,
          venting ? 2.2 + Math.random() * 2 : 1.2 + Math.random(),
          VAPOUR,
          venting && Math.random() < 0.4 ? 3 : 2,
          // colder than the air: it falls and spreads out low over the sand
          { g: 1.2, drag: 1.3, windK: 0.6, c2: VAPOUR_THIN, soft: true },
        );
      }
    }
  }
}
