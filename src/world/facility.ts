import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  Object3D,
  SphereGeometry,
  Vector3,
  type Material,
  type ShaderMaterial,
} from 'three';
import { clamp, noise1 } from '../core/math';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { bakeStatic } from '../render/bake';
import { SITE4 } from './crater';
import { terrainHeight } from './terrain';
import { footprintOf, type Rocks } from './rocks';
import type { Dust } from './particles';
import type { AudioEngine } from '../audio/AudioEngine';

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

const C = (hex: number) => rgb(hex).toArray();
const SPARK_HOT = C(0xfff4c8);
const SPARK_COOL = C(0xd9824a);
const SMOKE = C(0x3a3432);
const SMOKE_FADE = C(0x8a8078);
const SAND = [C(0xe4c987), C(0xbca872)];
const AMBER_ON = rgb(0xffb040);
const AMBER_OFF = rgb(0x4a2c10);
const RED_ON = rgb(0xff3a2a);
const RED_OFF = rgb(0x4a1210);

/** The hall's cross-section (z out of its front, y up): a tall front wall, chamfered roof edges, its foot sunk deep. */
const HALL: [number, number][] = [
  [7, -3],
  [7, 6],
  [5, 8],
  [-5, 8],
  [-7, 6],
  [-7, -3],
];
const HALL_LEN = 34;

/**
 * A prism: the convex cross-section `profile` (z, y) carried along x from x0
 * to x1, its ends capped. Every face is turned to look outward.
 */
function extrude(profile: [number, number][], x0: number, x1: number, scale = 1): BufferGeometry {
  const pts = profile.map(([z, y]) => [z * scale, y * scale] as const);
  const cz = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const cx = (x0 + x1) / 2;
  const pos: number[] = [];
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const tri = (p: number[], q: number[], r: number[]) => {
    a.set(p[0], p[1], p[2]);
    b.set(q[0], q[1], q[2]);
    c.set(r[0], r[1], r[2]);
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    const out = new Vector3((p[0] + q[0] + r[0]) / 3 - cx, (p[1] + q[1] + r[1]) / 3 - cy, (p[2] + q[2] + r[2]) / 3 - cz);
    if (n.dot(out) < 0) pos.push(...p, ...r, ...q);
    else pos.push(...p, ...q, ...r);
  };
  for (let i = 0; i < pts.length; i++) {
    const [z0, y0] = pts[i];
    const [z1, y1] = pts[(i + 1) % pts.length];
    tri([x0, y0, z0], [x1, y0, z0], [x1, y1, z1]);
    tri([x0, y0, z0], [x1, y1, z1], [x0, y1, z1]);
  }
  for (const x of [x0, x1]) {
    for (let i = 0; i < pts.length; i++) {
      const [z0, y0] = pts[i];
      const [z1, y1] = pts[(i + 1) % pts.length];
      // the caps' triangles fan from their middle; they face along x
      const p = [x, cy, cz];
      const q = [x, y0, z0];
      const r = [x, y1, z1];
      a.set(p[0], p[1], p[2]);
      b.set(q[0], q[1], q[2]);
      c.set(r[0], r[1], r[2]);
      const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
      if (n.x * (x - cx) < 0) pos.push(...p, ...r, ...q);
      else pos.push(...p, ...q, ...r);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A vast installation far out in the desert east of the station, built by the
 * same hands as the ship, its pods and the station: off-white plated walls
 * banded in orange, dark metal and glass. What it was for is not clear. A
 * long, high hall lies half sunk under a great drift of sand that has heaped
 * over its back and its ends; two towers stand behind it, one snapped off;
 * two domes rise from its roof, one cracked open. Along its front, a row of
 * capsules has been torn out through a breach and lies spilled in the sand,
 * each sized for a body, each with a numbered window: one shattered and
 * empty, one still faintly lit.
 *
 * It was attacked. Mortar shells have cratered the sand in front of it and
 * blown holes in its front wall; the great door is forced half open, one leaf
 * buckled in. A makeshift barricade of crates and torn plating stands at the
 * foot of the ramp. A beacon over the door still turns, amber; a red light
 * blinks on the tower; deep inside the door something glows a cold blue. Torn
 * cable sparks in a breach, smoke threads from another. The wind moans
 * through it, its plating groans, and now and then a failing announcement
 * chime sounds from somewhere inside.
 *
 * Local frame: +z out of its front (toward the way the creature comes), +x to
 * its right as seen from outside, +y up; the origin is on the hall's floor
 * line under the middle of its front, the door's threshold at about (0, 0, 7).
 */
export class Facility {
  readonly group = new Group();
  readonly center = new Vector3();
  readonly yaw: number;
  /** In front of the door, for the creature to look at (world space). */
  readonly lookPoint = new Vector3();
  /** The door's threshold (world space). */
  readonly door = new Vector3();
  /** Its site sound (see AudioEngine.addSite); the dead and the dog near it share it. */
  readonly sound: number;
  distance = Infinity;

  private readonly m: Record<'hull' | 'panel' | 'accent' | 'metal' | 'dark' | 'glass' | 'hole' | 'charred' | 'soot' | 'hazard' | 'brass', Material>;
  private readonly cos: number;
  private readonly sin: number;
  private readonly beaconMat: ShaderMaterial;
  private readonly beaconGlow = new Glow(rgb(0xffa030), 1.1, { core: 0.6 });
  private readonly beaconAt = new Object3D();
  private readonly redMat: ShaderMaterial;
  private readonly redGlow = new Glow(rgb(0xff4a32), 0.6, { core: 0.8 });
  private readonly redAt = new Object3D();
  private readonly deepGlow = new Glow(rgb(0x5ad8ff), 3.2, { core: 0.2 });
  private readonly deepAt = new Object3D();
  private readonly lampMat: ShaderMaterial;
  private readonly lampGlow = new Glow(rgb(0xffc870), 0.7, { core: 0.6 });
  private readonly lampAt = new Object3D();
  private readonly podMat: ShaderMaterial;
  private readonly podGlow = new Glow(rgb(0x7aff9a), 0.5, { core: 0.5 });
  private readonly podAt = new Object3D();
  private readonly sparkAt = new Object3D();
  private readonly smokeAt: Object3D[] = [];
  private readonly blockers: Object3D[] = [];
  private sparkTimer = 2;
  private smokeTimer = 0.5;
  private groanTimer = 5;
  private creakTimer = 3;
  private chimeTimer = 8;
  private clankTimer = 9;
  private readonly tmp = new Vector3();

  constructor(
    private readonly rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    this.sound = audio.addSite('vast');
    const t = (dark: number, mid: number, light: number, outline = 0.6, highlight = 1) => toonMaterial({ dark, mid, light, litAt: 0.55, outline, highlight });
    this.m = {
      hull: t(0x6f6a62, 0xa8a294, 0xdcd6c8),
      panel: t(0x625d56, 0x958f83, 0xc9c3b5),
      accent: t(0x7a3a24, 0xb85a34, 0xd9824a, 0.6, 0.8),
      metal: t(0x2e2a2a, 0x4a4542, 0x6e6862, 0.6, 0.8),
      dark: t(0x1c1a1a, 0x2a2626, 0x3e3836, 0.6, 0.6),
      glass: t(0x10141c, 0x1e2a38, 0x47677c, 0.6, 1),
      hole: toonMaterial({ dark: 0x0b0909, mid: 0x0b0909, light: 0x0b0909, unlit: true, outline: 0.6 }),
      charred: t(0x2b2424, 0x463c38, 0x6a5d55, 0.6, 0.6),
      soot: t(0x1c1817, 0x2e2826, 0x433a36, 0.3, 0.3),
      hazard: t(0x1a1816, 0x24201e, 0x34302c, 0.4, 0.4),
      brass: t(0x5a4418, 0x8a6a2a, 0xc09a48, 0.3, 1),
    };
    this.beaconMat = toonMaterial({ dark: 0x4a2c10, mid: 0x4a2c10, light: 0x4a2c10, unlit: true, outline: 0 });
    this.redMat = toonMaterial({ dark: 0x4a1210, mid: 0x4a1210, light: 0x4a1210, unlit: true, outline: 0 });
    this.lampMat = toonMaterial({ dark: 0x3a3630, mid: 0x3a3630, light: 0x3a3630, unlit: true, outline: 0 });
    this.podMat = toonMaterial({ dark: 0x1a3a22, mid: 0x1a3a22, light: 0x1a3a22, unlit: true, outline: 0 });
    this.beaconGlow.strength = 0;
    this.redGlow.strength = 0;
    this.deepGlow.strength = 0;
    this.lampGlow.strength = 0;
    this.podGlow.strength = 0;

    this.yaw = Math.atan2(SITE4.dx, SITE4.dz);
    this.cos = Math.cos(this.yaw);
    this.sin = Math.sin(this.yaw);
    // its floor line sits a little under the sand at the foot of the ramp
    const doorFloor = this.groundAt(0, 7.6);
    this.group.position.set(SITE4.x, doorFloor - 0.25, SITE4.z);
    this.group.rotation.y = this.yaw;
    this.center.copy(this.group.position);
    this.group.updateMatrixWorld(true);
    this.group.localToWorld(this.door.set(0, 0.25, 7.6));
    this.group.localToWorld(this.lookPoint.set(0, 2.2, 7));
  }

  /** A point of the facility's frame (x, z on the ground, lifted y) in the world. */
  place(x: number, y: number, z: number, out = new Vector3()) {
    out.set(SITE4.x + x * this.cos + z * this.sin, 0, SITE4.z - x * this.sin + z * this.cos);
    out.y = terrainHeight(out.x, out.z) + y;
    return out;
  }

  /** The ground's height (world) under a point of the facility's frame. */
  private groundAt(x: number, z: number) {
    return terrainHeight(SITE4.x + x * this.cos + z * this.sin, SITE4.z - x * this.sin + z * this.cos);
  }

  /** The ground's height under (x, z) of its frame, in its frame. */
  private floor(x: number, z: number) {
    return this.groundAt(x, z) - this.group.position.y;
  }

  private add(parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, shadow = true) {
    const m = new Mesh(geo.attributes.normal && !geo.index ? geo : faceted(geo), mat);
    m.position.set(x, y, z);
    if (shadow) m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  }

  private box(parent: Object3D, w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, shadow = true) {
    return this.add(parent, new BoxGeometry(w, h, d), mat, x, y, z, shadow);
  }

  addTo(scene: Object3D) {
    scene.add(this.group, this.beaconGlow, this.redGlow, this.deepGlow, this.lampGlow, this.podGlow);
  }

  /** Build it a part at a time (see core/builder.ts), then merge it into one mesh per material. */
  *build(): Generator<unknown, void, unknown> {
    this.buildHall();
    yield;
    this.buildEntrance();
    yield;
    this.buildDamage();
    yield;
    this.buildTowers();
    this.buildDomes();
    yield;
    this.buildCapsules();
    yield;
    this.buildBarricade();
    this.buildDebris();
    yield;
    this.group.updateMatrixWorld(true);
    for (const b of this.blockers) this.rocks.addStatic(footprintOf(b, 3));
    yield;
    bakeStatic(this.group, [this.beaconAt, this.redAt, this.deepAt, this.lampAt, this.podAt, this.sparkAt, ...this.smokeAt]);
  }

  // ------------------------------------------------------------------ build

  /** The long, high hall, sunk to the knees in sand, its front wall plated and ribbed. */
  private buildHall() {
    const m = this.m;
    const G = this.group;
    const hall = this.add(G, extrude(HALL, -HALL_LEN / 2, HALL_LEN / 2), m.hull, 0, 0, 0);
    this.blockers.push(hall);
    // ribs of orange round it, and darker end plates
    for (const x of [-12, -6, 6, 12]) this.add(G, extrude(HALL, x - 0.25, x + 0.25, 1.025), m.accent, 0, 0, 0);
    for (const x of [-HALL_LEN / 2, HALL_LEN / 2]) this.add(G, extrude(HALL, x - 0.3, x + 0.3, 1.035), m.panel, 0, 0, 0);
    // a plinth course along the foot of the front wall
    this.box(G, HALL_LEN, 0.5, 0.3, m.panel, 0, 0.25, 7.1);
    // panel seams over the front wall and the roof
    for (let x = -15; x <= 15; x += 3) {
      if (Math.abs(x) < 4) continue;
      this.box(G, 0.05, 6, 0.04, m.metal, x, 3, 7.02, false);
    }
    this.box(G, HALL_LEN - 0.4, 0.05, 0.04, m.metal, 0, 3.2, 7.02, false);
    for (let x = -14; x <= 14; x += 4) this.box(G, 0.06, 0.04, 10, m.metal, x, 8.02, 0, false);
    // a row of narrow windows high on the front wall, some blown in
    let k = 0;
    for (let x = -15.2; x <= 15.2; x += 2.2) {
      if (Math.abs(x) < 4.5) continue;
      const broken = k % 4 === 1 || k === 6;
      this.box(G, 1.3, 0.42, 0.06, m.metal, x, 4.9, 7.02, false);
      this.box(G, 1.1, 0.3, 0.06, broken ? m.hole : m.glass, x, 4.9, 7.05, false);
      if (broken) {
        // shards left in the frame
        const s = this.box(G, 0.3, 0.08, 0.04, m.glass, x - 0.35, 4.98, 7.08, false);
        s.rotation.z = 0.6;
      }
      k++;
    }
    // gear on the roof: radiator fins, a hatch, a broken antenna
    for (const x of [-11.5, 11.5]) {
      for (let k = 0; k < 6; k++) this.box(G, 1.8, 0.7, 0.06, m.metal, x, 8.35, -0.6 + k * 0.32);
      this.box(G, 2.0, 0.12, 2.0, m.panel, x, 8.05, 0.2);
    }
    this.box(G, 1.2, 0.3, 1.2, m.panel, -1.2, 8.15, 1.6);
    this.box(G, 0.9, 0.06, 0.9, m.dark, -1.2, 8.32, 1.6, false);
    this.box(G, 0.12, 2.2, 0.12, m.metal, 2.6, 9.1, 2.0).rotation.z = 0.25;
    this.box(G, 0.12, 1.2, 0.12, m.metal, 2.9, 8.2, 3.2).rotation.set(1.1, 0, 0.3);
    // sand blown up onto the roof and lying in drifts against its gear
    for (const [x, z, sx, sz] of [
      [-9, -2.8, 4.5, 1.6],
      [-2, -3.4, 6, 1.4],
      [5, -3, 4, 1.6],
      [13, -1.5, 3, 2.2],
      [-14.5, -1, 2.4, 2.6],
      [-11.5, 1.6, 1.6, 0.6],
      [11.5, 1.6, 1.4, 0.6],
      [0.5, 2.5, 1.2, 0.5],
    ]) {
      const d = this.add(G, new SphereGeometry(1, 8, 4), this.sandMat, x, 7.85, z);
      d.scale.set(sx, 0.35, sz);
    }
    // grime streaked down the front wall from the roof's edge
    for (let k = 0; k < 14; k++) {
      const x = -16 + ((k * 5.37) % 32);
      if (Math.abs(x) < 4.2) continue;
      this.box(G, 0.25 + (k % 3) * 0.15, 1.2 + (k % 4) * 0.5, 0.02, m.charred, x, 5.4 - (k % 4) * 0.25, 7.022, false);
    }
    // vents along the roof's front chamfer
    for (const x of [-13, -9, 9, 13]) {
      const v = this.box(G, 1.4, 0.5, 0.2, m.metal, x, 7.0, 6.05);
      v.rotation.x = -Math.PI / 4;
    }
    // stencilled marks on the front wall: a great number on the left, its insignia on the right
    for (const [w, h, x, y] of [
      [0.3, 1.6, -12.6, 2.2],
      [0.9, 0.3, -12.0, 2.85],
      [0.3, 1.6, -11.4, 2.2],
      [0.9, 0.3, -12.0, 1.55],
      [0.3, 1.6, -10.4, 2.2],
      [0.6, 0.3, -10.1, 2.85],
    ] as const)
      this.box(G, w, h, 0.03, m.hazard, x, y, 7.04, false);
    const ring = new CylinderGeometry(0.85, 0.85, 0.03, 12).rotateX(Math.PI / 2);
    this.add(G, ring, m.accent, 11.2, 2.4, 7.04, false);
    this.add(G, new CylinderGeometry(0.62, 0.62, 0.03, 12).rotateX(Math.PI / 2), m.hull, 11.2, 2.4, 7.05, false);
    const tri = new CylinderGeometry(0.45, 0.45, 0.03, 3).rotateX(Math.PI / 2);
    this.add(G, tri, m.accent, 11.2, 2.35, 7.06, false);
  }

  /** The great door, forced: a deep portal between two pylons, one leaf slid half open, the other buckled in. */
  private buildEntrance() {
    const m = this.m;
    const G = this.group;
    // the dark beyond the door
    this.box(G, 4.8, 4.6, 0.1, m.hole, 0, 2.3, 7.04, false);
    this.box(G, 4.8, 0.1, 2.6, m.hole, 0, 0.05, 5.8, false);
    // pylons either side, standing proud of the wall, capped in orange
    for (const sx of [-1, 1]) {
      const p = this.box(G, 1.3, 6.4, 1.6, m.panel, sx * 3.1, 3.0, 7.6);
      this.blockers.push(p);
      this.box(G, 1.36, 0.35, 1.66, m.accent, sx * 3.1, 5.6, 7.6);
      this.box(G, 1.36, 0.6, 1.66, m.metal, sx * 3.1, 0.3, 7.6);
      // hazard chevrons down the inside edge
      for (let y = 0.6; y < 4.6; y += 0.5) {
        const c = this.box(G, 0.04, 0.24, 0.5, (Math.round(y * 2) % 2 ? m.accent : m.hazard), sx * 2.43, y, 7.9, false);
        c.rotation.x = 0.5;
      }
    }
    // the lintel and its canopy
    this.box(G, 7.6, 1.0, 1.7, m.panel, 0, 5.1, 7.6);
    this.box(G, 7.8, 0.3, 2.6, m.hull, 0, 5.75, 8.0);
    this.box(G, 7.84, 0.12, 2.64, m.accent, 0, 5.55, 8.0);
    // the sign over the door: a dark plate with its marks, unreadable
    this.box(G, 3.2, 0.6, 0.06, m.hazard, 0, 5.1, 8.47, false);
    for (let k = 0; k < 6; k++) this.box(G, 0.12 + (k % 3) * 0.1, 0.32, 0.03, m.hull, -1.2 + k * 0.48, 5.1, 8.5, false);
    // the right leaf, slid most of the way into its pocket
    this.box(G, 1.4, 4.5, 0.4, m.metal, 2.0, 2.25, 7.2);
    this.box(G, 0.06, 4.4, 0.42, m.accent, 1.33, 2.25, 7.2, false);
    // the left leaf, wrenched off its track and buckled in: two plates folded at a crease
    const leaf = new Group();
    leaf.position.set(-2.35, 0, 7.05);
    leaf.rotation.y = 0.45;
    G.add(leaf);
    const lo = this.box(leaf, 2.2, 2.3, 0.35, m.metal, 1.1, 1.15, 0);
    lo.rotation.z = -0.05;
    const hi = this.box(leaf, 2.2, 2.2, 0.35, m.metal, 1.05, 3.35, -0.25);
    hi.rotation.x = 0.25;
    this.box(leaf, 0.06, 4.3, 0.37, m.accent, 2.18, 2.2, -0.1, false);
    // a blackened blast mark on it, and a hole punched through
    this.add(leaf, new CylinderGeometry(0.5, 0.55, 0.02, 7).rotateX(Math.PI / 2), m.charred, 1.0, 2.6, 0.19, false);
    this.add(leaf, new CylinderGeometry(0.2, 0.2, 0.02, 6).rotateX(Math.PI / 2), m.hole, 1.0, 2.6, 0.21, false);
    // a plate over the threshold, and the cold light far inside
    this.box(G, 4.6, 0.12, 1.2, m.metal, 0, 0.12, 7.6);
    this.deepAt.position.set(0, 1.8, 5.2);
    G.add(this.deepAt);
    // the beacon over the door
    this.box(G, 0.5, 0.25, 0.5, m.metal, 0, 6.03, 8.6);
    const beacon = this.add(G, new CylinderGeometry(0.2, 0.22, 0.32, 8), this.beaconMat, 0, 6.32, 8.6, false);
    void beacon;
    this.beaconAt.position.set(0, 6.35, 8.6);
    G.add(this.beaconAt);
    // two lamp posts at the foot of the ramp: one knocked down, one still flickering
    for (const sx of [-1, 1]) {
      const post = new Group();
      const gx = sx * 3.8;
      const gz = 12.5;
      post.position.set(gx, this.floor(gx, gz) - 0.2, gz);
      if (sx < 0) {
        post.rotation.z = 1.25;
        post.rotation.y = 0.4;
      }
      G.add(post);
      this.box(post, 0.18, 3.2, 0.18, m.metal, 0, 1.6, 0);
      this.box(post, 0.5, 0.2, 0.3, m.panel, 0, 3.2, 0);
      if (sx > 0) {
        this.add(post, new BoxGeometry(0.36, 0.08, 0.2), this.lampMat, 0, 3.08, 0, false);
        this.lampAt.position.set(gx, post.position.y + 3.0, gz);
        G.add(this.lampAt);
      } else this.box(post, 0.36, 0.08, 0.2, m.hole, 0, 3.08, 0, false);
    }
  }

  /** What the shells did to it: holes blown through the front wall, plating peeled back round them, scorch. */
  private buildDamage() {
    const m = this.m;
    const G = this.group;
    const breach = (x: number, y: number, r: number, smoke: boolean, spark: boolean) => {
      this.add(G, new CylinderGeometry(r * 1.9, r * 2.1, 0.02, 8).rotateX(Math.PI / 2), m.soot, x, y, 7.03, false);
      this.add(G, new CylinderGeometry(r * 1.35, r * 1.45, 0.02, 7).rotateX(Math.PI / 2), m.charred, x, y, 7.045, false);
      this.add(G, new CylinderGeometry(r, r * 1.05, 0.02, 7).rotateX(Math.PI / 2), m.hole, x, y, 7.06, false);
      // the plating peeled back round it like petals
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2 + x;
        const p = this.box(G, r * 0.55, 0.06, r * 0.7, k % 3 ? m.hull : m.charred, x + Math.cos(a) * r * 1.05, y + Math.sin(a) * r * 1.05, 7.25);
        p.rotation.set(Math.PI / 2 - 0.9, 0, a - Math.PI / 2);
      }
      // bent ribs of the frame behind it
      for (let k = 0; k < 3; k++) {
        const rod = this.box(G, 0.05, r * 1.4, 0.05, m.metal, x - r * 0.4 + k * r * 0.4, y + 0.1 * k, 7.1, false);
        rod.rotation.set(0.6, 0, 0.3 - k * 0.3);
      }
      // the blast's smudge up the wall over it
      this.box(G, r * 1.2, r * 2.6, 0.02, m.soot, x + 0.15, y + r * 1.9, 7.025, false).rotation.z = 0.08;
      if (smoke) {
        const o = new Object3D();
        o.position.set(x, y, 7.2);
        G.add(o);
        this.smokeAt.push(o);
      }
      if (spark) {
        // torn cable hanging out of it, sparking
        const cable = this.box(G, 0.05, 1.4, 0.05, m.dark, x + r * 0.5, y - r * 0.9, 7.35, false);
        cable.rotation.z = 0.35;
        this.sparkAt.position.set(x + r * 0.2, y - r * 1.55, 7.4);
        G.add(this.sparkAt);
      }
    };
    breach(-8.6, 2.6, 1.25, true, false);
    breach(12.2, 4.3, 0.85, false, true);
    // shrapnel scars across the front wall
    for (let k = 0; k < 26; k++) {
      const x = -15 + ((k * 7.31) % 30);
      const y = 0.6 + ((k * 3.17) % 4.8);
      if (Math.abs(x) < 4) continue;
      this.box(G, 0.12 + (k % 3) * 0.05, 0.08, 0.02, m.soot, x, y, 7.03, false).rotation.z = k;
    }
  }

  /** Two towers behind the hall: one standing with its mast and red light, one snapped off, its top in the sand. */
  private buildTowers() {
    const m = this.m;
    const G = this.group;
    const tower = (x: number, z: number, h: number, whole: boolean) => {
      const T = new Group();
      T.position.set(x, -3, z);
      G.add(T);
      const body = this.add(T, new CylinderGeometry(1.5, 1.7, h, 10), m.hull, 0, h / 2, 0);
      this.blockers.push(body);
      for (let y = 4; y < h - 0.5; y += 3.2) this.add(T, new CylinderGeometry(1.56, 1.56, 0.35, 10), m.accent, 0, y, 0);
      // a ladder cage up its side
      this.box(T, 0.5, h - 1, 0.08, m.metal, 0, h / 2, 1.62, false);
      if (whole) {
        this.add(T, new CylinderGeometry(1.2, 1.55, 0.8, 10), m.panel, 0, h + 0.4, 0);
        this.box(T, 0.16, 3.2, 0.16, m.metal, 0.3, h + 2.2, 0);
        this.box(T, 1.0, 0.08, 0.08, m.metal, 0.3, h + 3.2, 0);
        this.add(T, new BoxGeometry(0.22, 0.22, 0.22), this.redMat, 0.3, h + 3.9, 0, false);
        this.redAt.position.set(x + 0.3, -3 + h + 3.9, z);
        G.add(this.redAt);
      } else {
        // the jagged, blackened stump where it broke
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const tooth = this.box(T, 0.8, 0.4 + (k % 3) * 0.45, 0.12, k % 2 ? m.charred : m.hull, Math.cos(a) * 1.45, h + 0.1, Math.sin(a) * 1.45);
          tooth.rotation.y = -a + Math.PI / 2;
          tooth.rotation.x = (k % 2) * 0.3;
        }
        this.add(T, new CylinderGeometry(1.3, 1.3, 0.05, 10), m.hole, 0, h - 0.1, 0, false);
      }
    };
    tower(-14, -3.5, 20, true);
    tower(13.5, -4.5, 14, false);
    // the snapped-off top, lying half buried in the drift
    const top = new Group();
    const tx = 19;
    const tz = -12;
    top.position.set(tx, this.floor(tx, tz) - 0.7, tz);
    top.rotation.set(0.15, 0.7, Math.PI / 2 - 0.12);
    G.add(top);
    const piece = this.add(top, new CylinderGeometry(1.5, 1.5, 6, 10), m.hull, 0, 0, 0);
    this.add(top, new CylinderGeometry(1.56, 1.56, 0.35, 10), m.accent, 0, 1.4, 0);
    this.add(top, new CylinderGeometry(1.2, 1.55, 0.8, 10), m.panel, 0, 3.4, 0);
    this.add(top, new CylinderGeometry(1.3, 1.3, 0.05, 10), m.hole, 0, -3.02, 0, false);
    this.blockers.push(piece);
  }

  /** Two domes on the roof, half drowned in the drift; one is cracked open. */
  private buildDomes() {
    const m = this.m;
    const G = this.group;
    for (const [x, cracked] of [
      [-6.5, false],
      [6.5, true],
    ] as const) {
      const D = new Group();
      D.position.set(x, 8, 0.6);
      G.add(D);
      this.add(D, new SphereGeometry(2.8, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), m.panel, 0, 0, 0);
      this.add(D, new CylinderGeometry(2.9, 2.95, 0.4, 10), m.accent, 0, 0.2, 0);
      this.add(D, new CylinderGeometry(1.9, 2.5, 0.3, 10, 1, true), m.glass, 0, 1.8, 0, false);
      if (cracked) {
        this.add(D, new SphereGeometry(1.0, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), m.hole, 0.8, 1.9, 1.3, false).scale.set(1, 0.4, 1);
        for (let k = 0; k < 5; k++) {
          const c = this.box(D, 0.08, 0.04, 1.6, m.hole, 0.8 + Math.cos(k * 1.3) * 0.9, 2.0 + (k % 2) * 0.2, 1.3 + Math.sin(k * 1.3) * 0.9, false);
          c.rotation.y = k * 1.3;
        }
        // a slab of it fallen onto the roof
        const slab = this.box(G, 1.4, 0.15, 1.1, m.panel, x + 2.4, 8.2, 2.8);
        slab.rotation.set(0.2, 0.6, 0.15);
      }
    }
  }

  /**
   * The capsules: torn out through the breach and spilled across the sand in
   * front of it, each sized for a body. One shattered and empty; one still
   * faintly lit, something dark curled behind its frosted window.
   */
  private buildCapsules() {
    const m = this.m;
    const G = this.group;
    const spots: [number, number, number, number, number][] = [
      // x, z, turn, tip, kind (0 shut, 1 shattered, 2 lit)
      [-10.2, 9.0, 0.3, 1.35, 0],
      [-12.6, 10.4, -0.5, 1.5, 1],
      [-8.0, 11.2, 1.1, 1.42, 2],
      [-14.2, 8.4, 0.9, 0.35, 0],
    ];
    for (const [x, z, turn, tip, kind] of spots) {
      const P = new Group();
      P.position.set(x, this.floor(x, z) + 0.15, z);
      P.rotation.set(0, turn, tip, 'YXZ');
      G.add(P);
      const body = this.add(P, new CylinderGeometry(0.5, 0.5, 1.7, 10), m.hull, 0, 0, 0);
      this.add(P, new SphereGeometry(0.5, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2), m.panel, 0, 0.85, 0);
      this.add(P, new SphereGeometry(0.5, 10, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), m.panel, 0, -0.85, 0);
      this.add(P, new CylinderGeometry(0.53, 0.53, 0.14, 10), m.accent, 0, 0.55, 0);
      this.add(P, new CylinderGeometry(0.53, 0.53, 0.1, 10), m.metal, 0, -0.6, 0);
      // its window, and the number stencilled under it
      if (kind === 1) {
        this.box(P, 0.5, 0.9, 0.1, m.hole, 0, 0.05, 0.46, false);
        for (let k = 0; k < 4; k++) this.box(P, 0.12, 0.25, 0.03, m.glass, -0.2 + k * 0.13, -0.38 + (k % 2) * 0.75, 0.5, false).rotation.z = k * 0.9;
      } else {
        this.box(P, 0.5, 0.9, 0.1, m.glass, 0, 0.05, 0.46, false);
        if (kind === 2) {
          this.box(P, 0.36, 0.6, 0.06, this.podMat, 0, 0.05, 0.47, false);
          // the dark shape inside, curled
          this.box(P, 0.22, 0.3, 0.04, m.hole, 0.03, 0.12, 0.5, false).rotation.z = 0.4;
          this.podAt.position.set(0, 0.05, 0.6);
          P.add(this.podAt);
        }
      }
      this.box(P, 0.18, 0.1, 0.03, m.hazard, -0.1, -0.5, 0.5, false);
      this.box(P, 0.1, 0.1, 0.03, m.hazard, 0.1, -0.5, 0.5, false);
      this.blockers.push(body);
      // sand drifted against it
      const sd = this.add(G, new SphereGeometry(0.6, 6, 3), m.panel, x - 0.5, P.position.y - 0.35, z + 0.2);
      sd.material = this.sandMat;
      sd.scale.set(1.4, 0.45, 0.9);
    }
    // glass glittering in the sand round the shattered one
    for (let k = 0; k < 12; k++) {
      const gx = -12.6 + Math.cos(k * 2.1) * (0.8 + (k % 4) * 0.3);
      const gz = 10.4 + Math.sin(k * 2.1) * (0.8 + (k % 4) * 0.3);
      this.box(G, 0.1, 0.02, 0.07, m.glass, gx, this.floor(gx, gz) + 0.01, gz, false).rotation.y = k;
    }
  }

  private readonly sandMat = toonMaterial({ dark: 0xbca872, mid: 0xd7bf86, light: 0xe8d39a, litAt: 0.55, outline: 0, highlight: 0 });

  /** The barricade at the foot of the ramp: crates, a tipped cargo box and plates torn off the wall, propped up for cover. */
  private buildBarricade() {
    const m = this.m;
    const G = this.group;
    const crate = (x: number, z: number, w: number, h: number, d: number, turn: number, tilt = 0) => {
      const c = new Group();
      c.position.set(x, this.floor(x, z) + h / 2 - 0.1, z);
      c.rotation.set(0, turn, tilt);
      G.add(c);
      const b = this.box(c, w, h, d, m.panel, 0, 0, 0);
      this.box(c, w + 0.02, 0.12, d + 0.02, m.accent, 0, h * 0.25, 0);
      this.box(c, w + 0.02, h + 0.02, 0.06, m.metal, 0, 0, d / 2 - 0.05);
      this.blockers.push(b);
      return c;
    };
    crate(-4.6, 10.3, 1.2, 0.9, 0.9, 0.2);
    crate(-3.3, 10.6, 1.0, 0.8, 0.8, -0.3);
    crate(-4.1, 10.2, 0.8, 0.6, 0.7, 0.6).position.y += 0.75;
    crate(4.4, 10.6, 1.4, 1.0, 1.0, 0.1, 0.1);
    crate(3.0, 11.2, 0.9, 0.7, 0.8, 0.8);
    // plates torn off the wall, propped up against the crates
    for (const [x, z, turn] of [
      [-2.4, 11.0, 0.25],
      [5.6, 10.9, -0.4],
      [-5.8, 10.9, 0.5],
    ]) {
      const p = this.box(G, 1.5, 1.4, 0.08, m.hull, x, this.floor(x, z) + 0.6, z);
      p.rotation.set(-0.35, turn, 0.05);
      this.box(G, 1.52, 0.12, 0.1, m.accent, x, this.floor(x, z) + 1.05, z - 0.15).rotation.set(-0.35, turn, 0.05);
      this.blockers.push(p);
    }
    // spent cells from the fighting, scattered behind the barricade
    for (let k = 0; k < 26; k++) {
      const a = k * 2.39;
      const r = 0.3 + (k % 7) * 0.22;
      const x = -3.9 + Math.cos(a) * r;
      const z = 9.6 + Math.sin(a) * r * 0.7;
      const cell = this.add(G, new CylinderGeometry(0.025, 0.025, 0.09, 6), m.brass, x, this.floor(x, z) + 0.03, z, false);
      cell.rotation.set(Math.PI / 2, k, 0);
    }
  }

  /** Plating, a girder and cable strewn over the sand. */
  private buildDebris() {
    const m = this.m;
    const G = this.group;
    const bits: [number, number, number, number, number][] = [
      [-7.5, 13.5, 1.2, 0.8, 0.4],
      [6.8, 14.8, 0.9, 1.1, 1.3],
      [9.5, 9.5, 1.4, 0.6, 2.1],
      [-16.5, 13.5, 1.0, 0.9, 0.2],
      [-1.5, 19.5, 0.8, 0.7, 2.6],
      [14.5, 13, 1.1, 0.8, 0.9],
      [-11, 16.5, 0.7, 0.5, 1.7],
      [3.5, 21.5, 0.9, 0.6, 0.5],
    ];
    for (const [x, z, w, d, turn] of bits) {
      const p = this.box(G, w, 0.06, d, turn > 1.5 ? m.charred : m.hull, x, this.floor(x, z) + 0.05, z, false);
      p.rotation.set(0.12, turn, -0.1);
    }
    // a bent girder blown out of the wall
    const gx = -6.5;
    const gz = 15;
    const g1 = this.box(G, 0.25, 0.25, 2.8, m.metal, gx, this.floor(gx, gz) + 0.15, gz);
    g1.rotation.set(0.05, 0.9, 0.1);
    const g2 = this.box(G, 0.25, 0.25, 1.8, m.metal, gx + 1.6, this.floor(gx + 1.6, gz + 1.3) + 0.5, gz + 1.3);
    g2.rotation.set(-0.4, 1.4, 0.2);
    // a cable snaking out of the door and into the sand
    let px = 1.2;
    let pz = 8.2;
    for (let k = 0; k < 9; k++) {
      const nx = px + Math.sin(k * 1.4) * 0.5 + 0.15;
      const nz = pz + 0.6;
      const len = Math.hypot(nx - px, nz - pz);
      const c = this.box(G, 0.07, 0.05, len + 0.04, m.dark, (px + nx) / 2, this.floor((px + nx) / 2, (pz + nz) / 2) + 0.03, (pz + nz) / 2, false);
      c.rotation.y = Math.atan2(nx - px, nz - pz);
      px = nx;
      pz = nz;
    }
  }

  // ------------------------------------------------------------------ alive

  update(dt: number, time: number, listener: Vector3) {
    const d = Math.hypot(listener.x - this.center.x, listener.z - this.center.z);
    this.distance = d;
    const level = d < 110 ? 1 / (1 + (d / 16) * (d / 16)) : 0;
    const pan = clamp((this.center.x - listener.x) / 18, -0.8, 0.8);
    this.audio.setSite(this.sound, level, pan, 1 - clamp(d / 80, 0, 1), 0.7);
    if (d > 120) {
      for (const g of [this.beaconGlow, this.redGlow, this.deepGlow, this.lampGlow, this.podGlow]) g.strength = 0;
      return;
    }
    this.group.updateMatrixWorld();
    // the beacon over the door still turns: its light sweeps round and round
    const sweep = Math.pow(Math.max(0, Math.cos(time * 3.4)), 6);
    (this.beaconMat.uniforms.uLight.value as Vector3).lerpVectors(AMBER_OFF, AMBER_ON, 0.35 + 0.65 * sweep);
    this.beaconAt.getWorldPosition(this.beaconGlow.position);
    this.beaconGlow.strength = 0.25 + sweep * 1.2;
    // the red light on the tower: a slow blink
    const on = time % 3 < 0.3;
    (this.redMat.uniforms.uLight.value as Vector3).copy(on ? RED_ON : RED_OFF);
    this.redAt.getWorldPosition(this.redGlow.position);
    this.redGlow.strength = on ? 1 : 0;
    // the cold glow deep inside the door, breathing slowly, stuttering now and then
    this.deepAt.getWorldPosition(this.deepGlow.position);
    const stut = noise1(time * 4, 9) > 0.55 ? 0.3 : 1;
    this.deepGlow.strength = (0.22 + 0.08 * Math.sin(time * 0.7)) * stut;
    // the lamp at the foot of the ramp, failing
    const n = noise1(time * 7, 21);
    const lit = n > 0.1 || (n > -0.25 && Math.random() < 0.25);
    (this.lampMat.uniforms.uLight.value as Vector3).set(lit ? 1 : 0.23, lit ? 0.84 : 0.2, lit ? 0.55 : 0.18);
    this.lampAt.getWorldPosition(this.lampGlow.position);
    this.lampGlow.strength = lit ? 0.45 : 0;
    // the capsule still lit, its light pulsing weakly
    const pp = 0.5 + 0.5 * Math.sin(time * 1.3);
    (this.podMat.uniforms.uLight.value as Vector3).set(0.1 + 0.25 * pp, 0.3 + 0.45 * pp, 0.15 + 0.25 * pp);
    this.podAt.getWorldPosition(this.podGlow.position);
    this.podGlow.strength = 0.15 + 0.25 * pp;
    if (d > 80) return;

    // torn cable sparking in the breach
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 1.2 + Math.random() * 4;
      this.sparkAt.getWorldPosition(this.tmp);
      const burst = 8 + Math.floor(Math.random() * 12);
      for (let i = 0; i < burst; i++) {
        this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, (Math.random() - 0.5) * 2.2, Math.random() * 1.6, (Math.random() - 0.5) * 2.2, 0.4 + Math.random() * 0.5, SPARK_HOT, 1, {
          g: 9,
          drag: 0.6,
          windK: 0,
          c2: SPARK_COOL,
        });
      }
      this.audio.siteZap(this.sound, 0.5);
    }
    // a thread of smoke from the other breach
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0 && this.smokeAt.length) {
      this.smokeTimer = 0.25 + Math.random() * 0.35;
      this.smokeAt[0].getWorldPosition(this.tmp);
      this.dust.spawn(this.tmp.x + (Math.random() - 0.5) * 0.5, this.tmp.y + Math.random() * 0.3, this.tmp.z, 0, 0.35 + Math.random() * 0.2, 0, 4 + Math.random() * 2, SMOKE, 3, {
        g: -0.15,
        drag: 0.6,
        windK: 0.7,
        c2: SMOKE_FADE,
        soft: true,
      });
    }
    // sand pours off the drift's lip onto the roof now and then
    if (Math.random() < dt * 0.6) {
      const lx = (Math.random() - 0.5) * 26;
      const p = this.group.localToWorld(this.tmp.set(lx, 8.3, -4.5));
      for (let i = 0; i < 6; i++) this.dust.spawn(p.x + (Math.random() - 0.5) * 0.4, p.y, p.z, (Math.random() - 0.5) * 0.2, -0.2, (Math.random() - 0.5) * 0.2, 1.2, SAND[i % 2], 1, { g: 4, drag: 1, windK: 0.4, soft: true });
    }
    // its sounds: the plating groans and creaks in the heat, something clanks deep inside,
    // and a failing announcement chime plays to nobody
    this.groanTimer -= dt;
    if (this.groanTimer <= 0) {
      this.groanTimer = 7 + Math.random() * 9;
      this.audio.shipGroan(this.sound, 0.35 + Math.random() * 0.25);
    }
    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.creakTimer = 2.5 + Math.random() * 5;
      this.audio.siteCreak(this.sound, 0.3, 0.5 + Math.random() * 0.4);
    }
    this.clankTimer -= dt;
    if (this.clankTimer <= 0) {
      this.clankTimer = 8 + Math.random() * 14;
      this.audio.siteClank(this.sound, 0.25);
    }
    this.chimeTimer -= dt;
    if (this.chimeTimer <= 0) {
      this.chimeTimer = 16 + Math.random() * 10;
      this.audio.facilityChime(this.sound, 0.45);
    }
  }
}
