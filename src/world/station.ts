import {
  Matrix4,
  Raycaster,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  SphereGeometry,
  TorusGeometry,
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
import { HIGH } from './highlands';
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
const RED_ON = rgb(0xff3a2a);
const RED_OFF = rgb(0x4a1210);
const LAMP_ON = rgb(0xfff0c8);
const LAMP_OFF = rgb(0x3a3630);

/**
 * The research station on the mountain's summit, built by the same hands as
 * the ship and its pods: off-white plated modules banded in orange, dark
 * metal and glass. A long habitat with a row of windows and an airlock, a
 * domed lab joined to it by a tube, a lattice comms mast with a dish and a
 * slow red light, fuel tanks, a solar array, and stacked cargo.
 *
 * It has been raided: the airlock is forced half open, windows are smashed,
 * the dome is cracked, a solar panel lies on the ground, crates are spilled,
 * and laser fire has scorched the wall where three of the creature's kind
 * were lined up and shot (see story/Fallen.ts). A lamp flickers, wiring
 * sparks in a broken window, and a broken alarm chirps now and then.
 *
 * Local frame: +z faces down the road (toward the ship), +x to its right as
 * seen from the road, +y up; the origin is the middle of the summit.
 */
export class Station {
  readonly group = new Group();
  readonly center = new Vector3();
  /** Where the three were shot: the middle of the row, at the foot of the wall, in world space. */
  readonly wallRow = new Vector3();
  /** The row's direction (unit, along the wall) and out from the wall (unit), in world space. */
  readonly rowDir = new Vector3();
  readonly rowOut = new Vector3();
  /** The station's turn about the vertical (radians). */
  readonly yaw: number;
  distance = Infinity;

  private readonly m: Record<'hull' | 'panel' | 'accent' | 'metal' | 'glass' | 'hole' | 'charred' | 'soot' | 'solar' | 'pad', Material>;
  private readonly sound: number;
  private readonly redMat: ShaderMaterial;
  private readonly redGlow = new Glow(rgb(0xff4a32), 0.5, { core: 0.8 });
  private readonly redTip = new Object3D();
  private readonly lampMats: ShaderMaterial[] = [];
  private readonly lampGlows: Glow[] = [];
  private readonly lampHeads: Object3D[] = [];
  private readonly doorLight: ShaderMaterial;
  private readonly sparkFrom = new Object3D();
  private sparkTimer = 2;
  private beepTimer = 4;
  private creakTimer = 6;
  private readonly tmp = new Vector3();

  constructor(
    private readonly rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    this.sound = audio.addSite('power');
    this.m = {
      hull: toonMaterial({ dark: 0x6f6a62, mid: 0xa8a294, light: 0xdcd6c8, litAt: 0.55, outline: 0.6, highlight: 1 }),
      panel: toonMaterial({ dark: 0x625d56, mid: 0x958f83, light: 0xc9c3b5, litAt: 0.55, outline: 0.6, highlight: 1 }),
      accent: toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0.6, highlight: 0.8 }),
      metal: toonMaterial({ dark: 0x2e2a2a, mid: 0x4a4542, light: 0x6e6862, litAt: 0.55, outline: 0.6, highlight: 0.8 }),
      glass: toonMaterial({ dark: 0x10141c, mid: 0x1e2a38, light: 0x47677c, litAt: 0.5, outline: 0.6, highlight: 1 }),
      hole: toonMaterial({ dark: 0x0e0b0c, mid: 0x0e0b0c, light: 0x0e0b0c, unlit: true, outline: 0.6 }),
      charred: toonMaterial({ dark: 0x2b2424, mid: 0x463c38, light: 0x6a5d55, litAt: 0.55, outline: 0.6, highlight: 0.6 }),
      soot: toonMaterial({ dark: 0x1c1817, mid: 0x2e2826, light: 0x433a36, litAt: 0.55, outline: 0.3, highlight: 0.3 }),
      solar: toonMaterial({ dark: 0x141c2c, mid: 0x223250, light: 0x46648c, litAt: 0.45, outline: 0.6, highlight: 1 }),
      pad: toonMaterial({ dark: 0x4a4542, mid: 0x6a645e, light: 0x8e877e, litAt: 0.55, outline: 0.4, highlight: 0.5 }),
    };
    this.redMat = toonMaterial({ dark: 0x4a1210, mid: 0x4a1210, light: 0x4a1210, unlit: true, outline: 0 });
    this.doorLight = toonMaterial({ dark: 0x7a1010, mid: 0x7a1010, light: 0x7a1010, unlit: true, outline: 0 });

    this.yaw = Math.atan2(HIGH.ox, HIGH.oz);
    const ground = terrainHeight(HIGH.x, HIGH.z);
    this.group.position.set(HIGH.x, ground, HIGH.z);
    this.group.rotation.y = this.yaw;
    this.center.set(HIGH.x, ground, HIGH.z);

    // the wall where they were shot: left of the airlock, seen from the road
    this.group.updateMatrixWorld(true);
    this.group.localToWorld(this.wallRow.set(-3.6, 0, 0.75));
    this.rowDir.set(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), this.yaw);
    this.rowOut.set(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), this.yaw);
  }

  /** Build it a part at a time (see core/builder.ts), then merge it into one mesh per material. */
  *build(): Generator<unknown, void, unknown> {
    const blockers: Object3D[] = [];
    blockers.push(this.buildHab());
    yield;
    blockers.push(this.buildLab(), this.buildTanks());
    yield;
    this.buildMast();
    blockers.push(...this.buildSolar(), ...this.buildCrates());
    yield;
    this.buildLamps();
    this.group.updateMatrixWorld(true);
    for (const b of blockers) this.rocks.addStatic(footprintOf(b, 2));
    // the tower's legs stand together as one obstacle
    this.rocks.addStatic(footprintOf(this.mastBase, 3));
    yield;
    bakeStatic(this.group);
  }

  /** Put a part's group at (x, z) in the station's frame, sitting on the highest ground under it (within r). */
  private seat(G: Object3D, x: number, z: number, r: number) {
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    let top = -Infinity;
    for (const [dx, dz] of [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      const lx = x + dx;
      const lz = z + dz;
      const wx = this.center.x + lx * c + lz * sn;
      const wz = this.center.z - lx * sn + lz * c;
      top = Math.max(top, terrainHeight(wx, wz));
    }
    G.position.set(x, top - this.center.y, z);
  }

  private add(parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, shadow = true) {
    const m = new Mesh(faceted(geo), mat);
    m.position.set(x, y, z);
    if (shadow) m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  }

  /** An octagonal prism along x (chamfered box): length, width (z), height (y). */
  private prism(parent: Object3D, len: number, w: number, h: number, mat: Material, x: number, y: number, z: number) {
    const g = new CylinderGeometry(1, 1, len, 8, 1);
    g.rotateZ(Math.PI / 2);
    g.rotateX(Math.PI / 8);
    g.scale(1, h / 2 / Math.cos(Math.PI / 8), w / 2 / Math.cos(Math.PI / 8));
    return this.add(parent, g, mat, x, y, z);
  }

  private habHull!: Mesh;
  private readonly ray = new Raycaster();

  /**
   * A flat mark laid on the habitat's front wall where it really is (the wall
   * slopes in toward its foot): found by casting a ray at the hull from in
   * front. Size w by h, turned by `spin`, lifted `lift` off the surface.
   */
  private wallMark(G: Object3D, x: number, y: number, w: number, h: number, mat: Material, spin: number, lift = 0.002) {
    // the parts are new: bring their place in the world up to date before casting at them
    this.habHull.updateWorldMatrix(true, false);
    const origin = G.localToWorld(new Vector3(x, y, 5));
    const dir = new Vector3(0, 0, -1).transformDirection(G.matrixWorld);
    this.ray.set(origin, dir);
    const hit = this.ray.intersectObject(this.habHull, false)[0];
    if (!hit || !hit.face) return;
    const n = hit.face.normal.clone().transformDirection(this.habHull.matrixWorld);
    const p = hit.point.clone().addScaledVector(n, lift);
    const mark = new Mesh(new BoxGeometry(w, h, 0.006), mat);
    G.add(mark);
    mark.position.copy(G.worldToLocal(p));
    // face along the wall's normal, then turn about it
    const ln = n.clone().transformDirection(new Matrix4().copy(G.matrixWorld).invert());
    mark.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), ln);
    mark.rotateZ(spin);
  }

  /** A laser hit on a wall facing +z (local), at (x, y) on the face at depth z: a ragged burn round a hole. */
  private scorch(parent: Object3D, x: number, y: number, z: number, s: number) {
    const m = this.m;
    const blot = (r: number, mat: Material, dz: number, spin: number) => {
      const g = new CylinderGeometry(r, r, 0.02, 5);
      g.rotateX(Math.PI / 2);
      const d = this.add(parent, g, mat, x, y, z + dz, false);
      d.rotation.z = spin;
      d.scale.set(1.3, 0.8, 1);
    };
    blot(0.2 * s, m.charred, 0.005, x * 7);
    blot(0.12 * s, m.soot, 0.012, x * 3 + 1);
    blot(0.05 * s, m.hole, 0.02, 0);
    // a smoke stain licking up from it
    const trail = this.add(parent, new BoxGeometry(0.1 * s, 0.32 * s, 0.01), m.charred, x + 0.02, y + 0.22 * s, z + 0.004, false);
    trail.rotation.z = 0.12;
  }

  // ------------------------------------------------------------------ build

  /** The long habitat: windows, the forced airlock, roof gear, the scorched wall. */
  private buildHab() {
    const m = this.m;
    const G = new Group();
    G.position.set(0, 0, -1.6);
    this.group.add(G);
    const L = 11;
    const W = 4.6;
    const H = 3.0;
    const y0 = 0.45 + H / 2;
    // on a low frame of struts over the levelled rock
    for (const x of [-4.8, -1.6, 1.6, 4.8]) {
      for (const z of [-1.7, 1.7]) this.add(G, new BoxGeometry(0.22, 0.5, 0.22), m.metal, x, 0.25, z);
    }
    this.add(G, new BoxGeometry(L + 0.2, 0.12, W - 0.4), m.metal, 0, 0.42, 0);
    this.habHull = this.prism(G, L, W, H, m.hull, 0, y0, 0);
    // end caps a shade darker, and bands of the orange round it
    this.prism(G, 0.3, W + 0.08, H + 0.08, m.panel, -L / 2, y0, 0);
    this.prism(G, 0.3, W + 0.08, H + 0.08, m.panel, L / 2, y0, 0);
    for (const x of [-3.6, 3.6]) this.prism(G, 0.22, W + 0.06, H + 0.06, m.accent, x, y0, 0);
    // panel seams along the front
    for (const x of [-1.8, 1.8]) this.add(G, new BoxGeometry(0.04, H * 0.62, 0.04), m.panel, x, y0, W / 2 + 0.02, false);
    // the row of windows, high on the front; two smashed in
    const face = W / 2 + 0.01;
    const win = [-4.6, -3.0, -1.0, 2.6, 4.2];
    win.forEach((x, k) => {
      const broken = k === 1 || k === 3;
      this.add(G, new BoxGeometry(0.95, 0.5, 0.06), m.metal, x, y0 + 0.55, face, false);
      this.add(G, new BoxGeometry(0.8, 0.36, 0.05), broken ? m.hole : m.glass, x, y0 + 0.55, face + 0.012, false);
      if (broken) {
        for (const [sx, sy, r] of [
          [-0.3, -0.12, 0.4],
          [0.28, 0.1, -0.6],
          [0.05, -0.15, 1.2],
        ]) {
          const shard = this.add(G, new BoxGeometry(0.18, 0.08, 0.02), m.glass, x + sx, y0 + 0.55 + sy, face + 0.03, false);
          shard.rotation.z = r;
        }
      }
    });
    // wiring torn loose in a smashed window, sparking
    this.sparkFrom.position.set(2.6, y0 + 0.5, face + 0.1);
    G.add(this.sparkFrom);
    // the airlock: a dark doorway, its door forced half open, a red light over it
    const dx = 0.9;
    this.add(G, new BoxGeometry(1.5, 2.1, 0.08), m.metal, dx, 0.45 + 1.05, face + 0.02);
    this.add(G, new BoxGeometry(1.1, 1.85, 0.06), m.hole, dx, 0.45 + 0.95, face + 0.05, false);
    const door = this.add(G, new BoxGeometry(0.62, 1.85, 0.07), m.panel, dx - 0.36, 0.45 + 0.95, face + 0.09);
    door.rotation.y = 0.12;
    this.add(G, new BoxGeometry(0.62, 0.06, 0.08), m.accent, dx - 0.36, 0.45 + 1.55, face + 0.12, false);
    // scored and burnt where it was forced
    this.scorch(G, dx + 0.4, 1.3, face + 0.06, 0.8);
    this.add(G, new BoxGeometry(0.25, 0.08, 0.08), this.doorLight, dx, 0.45 + 2.2, face + 0.06, false);
    // steps up to it
    this.add(G, new BoxGeometry(1.4, 0.15, 0.6), m.metal, dx, 0.08, face + 0.4);
    this.add(G, new BoxGeometry(1.4, 0.15, 0.4), m.metal, dx, 0.25, face + 0.2);
    // the wall where they were shot: laser burns and grey-blue blood, at the heights of
    // their chests and heads, a smear where one slid down it, drips running from the spatter
    G.updateMatrixWorld(true);
    const blood = toonMaterial({ dark: 0x1e2630, mid: 0x28323e, light: 0x34414f, litAt: 0.6, outline: 0, highlight: 0 });
    for (const [x, y, s] of [
      [-5.15, 1.75, 0.8],
      [-3.75, 1.95, 0.9],
      [-3.3, 1.6, 0.6],
      [-2.2, 1.85, 0.85],
      [-4.5, 2.2, 0.55],
    ]) {
      this.wallMark(G, x, y, 0.2 * s, 0.16 * s, m.charred, x * 7);
      this.wallMark(G, x, y, 0.11 * s, 0.09 * s, m.soot, x * 3 + 1, 0.006);
      this.wallMark(G, x, y, 0.05 * s, 0.05 * s, m.hole, 0, 0.012);
      this.wallMark(G, x + 0.02, y + 0.2 * s, 0.09 * s, 0.28 * s, m.charred, 0.12, 0.003);
    }
    for (const bx of [-5.05, -3.6, -2.15]) {
      for (let k = 0; k < 9; k++) {
        const a = k * 2.4 + bx;
        const r = 0.12 + (k % 4) * 0.1;
        const sz = 0.03 + ((k * 7) % 5) * 0.022;
        this.wallMark(G, bx + Math.cos(a) * r, 1.6 + Math.sin(a) * r * 0.8, sz * 1.3, sz, blood, a, 0.008);
      }
      // drips run down from it
      for (let k = 0; k < 3; k++) this.wallMark(G, bx - 0.15 + k * 0.14, 1.32 - k * 0.06, 0.025, 0.34 + k * 0.12, blood, 0, 0.009);
    }
    // where the middle one slid down the wall
    this.wallMark(G, -3.6, 1.25, 0.22, 0.7, blood, 0.04, 0.01);
    // roof: vents, a hatch, conduits, a small antenna
    const top = 0.45 + H;
    for (const [x, z, w, d] of [
      [-3.4, -0.6, 1.1, 0.8],
      [-1.2, 0.5, 0.7, 0.7],
      [2.0, -0.4, 1.3, 1.0],
      [4.2, 0.4, 0.6, 0.6],
    ]) {
      this.add(G, new BoxGeometry(w, 0.3, d), x > 0 ? m.panel : m.metal, x, top + 0.1, z);
    }
    this.add(G, new CylinderGeometry(0.06, 0.06, L - 1, 5).rotateZ(Math.PI / 2), m.metal, 0, top + 0.02, -1.0);
    this.add(G, new CylinderGeometry(0.03, 0.03, 1.6, 4), m.metal, -4.5, top + 0.8, -0.8);
    return G;
  }

  /** The domed lab at the habitat's end, joined by a tube; its dome cracked open. */
  private buildLab() {
    const m = this.m;
    const G = new Group();
    G.position.set(8.4, 0, -1.2);
    this.group.add(G);
    this.add(G, new CylinderGeometry(2.7, 2.8, 0.4, 8), m.metal, 0, 0.2, 0);
    this.add(G, new CylinderGeometry(2.6, 2.6, 2.3, 8), m.hull, 0, 0.4 + 1.15, 0);
    this.add(G, new CylinderGeometry(2.64, 2.64, 0.22, 8, 1, true), m.accent, 0, 1.9, 0);
    // the dome: glass on a frame, a wedge of it smashed through
    const dome = new SphereGeometry(2.5, 8, 4, 0, Math.PI * 1.6, 0, Math.PI / 2);
    this.add(G, dome, m.glass, 0, 2.7, 0);
    this.add(G, new SphereGeometry(2.48, 8, 4, Math.PI * 1.6, Math.PI * 0.4, 0, Math.PI / 2), m.hole, 0, 2.7, 0, false);
    this.add(G, new TorusGeometry(2.5, 0.06, 4, 8).rotateX(Math.PI / 2), m.metal, 0, 2.72, 0);
    for (let k = 0; k < 4; k++) {
      const rib = this.add(G, new TorusGeometry(2.5, 0.04, 3, 8, Math.PI), m.metal, 0, 2.7, 0);
      rib.rotation.y = (k / 4) * Math.PI;
    }
    // shards of the dome on the ground
    for (let k = 0; k < 6; k++) {
      const s = this.add(G, new BoxGeometry(0.3 + (k % 3) * 0.1, 0.03, 0.2), m.glass, 2.2 + Math.cos(k * 2.1) * 1.1, 0.03, 1.6 + Math.sin(k * 1.7) * 0.9, false);
      s.rotation.y = k * 1.1;
    }
    // the tube to the habitat
    const tube = new CylinderGeometry(0.8, 0.8, 2.2, 8).rotateZ(Math.PI / 2);
    this.add(this.group, tube, m.panel, 6.0, 1.6, -1.4);
    this.add(this.group, new CylinderGeometry(0.84, 0.84, 0.2, 8).rotateZ(Math.PI / 2), m.accent, 6.0, 1.6, -1.4);
    return G;
  }

  /** Two fuel tanks lying on cradles behind the habitat. */
  private buildTanks() {
    const m = this.m;
    const G = new Group();
    this.seat(G, -2.5, -6.0, 2);
    this.group.add(G);
    for (const z of [-0.8, 0.8]) {
      this.add(G, new CylinderGeometry(0.7, 0.7, 4.2, 8).rotateZ(Math.PI / 2), m.hull, 0, 0.95, z);
      for (const x of [-2.1, 2.1]) this.add(G, new SphereGeometry(0.7, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).rotateZ(x < 0 ? Math.PI / 2 : -Math.PI / 2), m.hull, x, 0.95, z);
      this.add(G, new CylinderGeometry(0.72, 0.72, 0.2, 8, 1, true).rotateZ(Math.PI / 2), m.accent, 0.8, 0.95, z);
      for (const x of [-1.4, 1.4]) this.add(G, new BoxGeometry(0.2, 0.5, 1.0), m.metal, x, 0.25, z);
    }
    this.add(G, new CylinderGeometry(0.07, 0.07, 3.8, 5).rotateZ(Math.PI / 2), m.metal, 0, 1.75, 0);
    return G;
  }

  private mastBase = new Group();

  /** The comms mast: a tapering lattice, a dish, and a slow red light at the top. */
  private buildMast() {
    const m = this.m;
    const G = this.mastBase;
    this.seat(G, -7.6, -4.2, 0.6);
    this.group.add(G);
    const H = 10;
    const leg = (sx: number, sz: number) => {
      const g = new CylinderGeometry(0.05, 0.08, H, 4);
      const l = this.add(G, g, m.metal, sx * 0.45, H / 2, sz * 0.45);
      l.rotation.set(sz * -0.06, 0, sx * 0.06);
    };
    leg(1, 1);
    leg(-1, 1);
    leg(1, -1);
    leg(-1, -1);
    for (let k = 1; k < 7; k++) {
      const y = k * 1.4;
      const w = 1.1 - y * 0.07;
      for (const [rx, rz, ry] of [
        [0, w / 2, 0],
        [0, -w / 2, 0],
        [w / 2, 0, Math.PI / 2],
        [-w / 2, 0, Math.PI / 2],
      ]) {
        const brace = this.add(G, new BoxGeometry(w, 0.04, 0.04), m.metal, rx, y, rz, false);
        brace.rotation.y = ry;
      }
    }
    this.add(G, new BoxGeometry(0.9, 0.12, 0.9), m.metal, 0, 0.06, 0);
    // the dish, turned toward the sky to the south
    const dish = new Group();
    dish.position.set(0.25, H * 0.72, 0.3);
    dish.rotation.set(-0.7, 0.4, 0);
    G.add(dish);
    this.add(dish, new CylinderGeometry(0.9, 0.35, 0.25, 10, 1, true), m.hull, 0, 0, 0);
    this.add(dish, new CylinderGeometry(0.34, 0.34, 0.05, 8), m.panel, 0, -0.12, 0);
    this.add(dish, new CylinderGeometry(0.02, 0.02, 0.8, 4), m.metal, 0, 0.35, 0);
    this.add(G, new BoxGeometry(0.4, 0.3, 0.3), m.accent, 0, H * 0.45, 0.3);
    // the light on top
    this.add(G, new CylinderGeometry(0.03, 0.03, 0.6, 4), m.metal, 0, H + 0.3, 0);
    this.add(G, new BoxGeometry(0.16, 0.16, 0.16), this.redMat, 0, H + 0.66, 0, false);
    this.redTip.position.set(0, H + 0.66, 0);
    G.add(this.redTip);
  }

  /** Solar panels on posts behind the lab; one knocked flat. */
  private buildSolar() {
    const m = this.m;
    const out: Object3D[] = [];
    for (let k = 0; k < 4; k++) {
      const G = new Group();
      this.seat(G, 3.0 + k * 2.6, -6.6, 0.8);
      this.group.add(G);
      out.push(G);
      const fallen = k === 2;
      if (!fallen) {
        this.add(G, new BoxGeometry(0.12, 1.2, 0.12), m.metal, 0, 0.6, 0);
        const p = this.add(G, new BoxGeometry(2.2, 0.06, 1.4), m.solar, 0, 1.3, 0);
        p.rotation.x = -0.5;
        this.add(G, new BoxGeometry(2.24, 0.08, 0.06), m.metal, 0, 1.3 + Math.sin(0.5) * 0.7, Math.cos(0.5) * 0.7).rotation.x = -0.5;
      } else {
        this.add(G, new BoxGeometry(0.12, 0.5, 0.12), m.metal, 0, 0.25, 0).rotation.z = 0.5;
        const p = this.add(G, new BoxGeometry(2.2, 0.06, 1.4), m.solar, 0.4, 0.08, 0.6);
        p.rotation.set(0.08, 0.5, 0.05);
        this.add(G, new BoxGeometry(0.5, 0.07, 0.4), m.hole, 0.7, 0.12, 0.5, false).rotation.y = 0.5;
      }
    }
    return out;
  }

  /** Cargo crates by the airlock: a stack, and others knocked over and broken open. */
  private buildCrates() {
    const m = this.m;
    const G = new Group();
    this.seat(G, 4.0, 2.6, 1.2);
    this.group.add(G);
    const crate = (x: number, y: number, z: number, s: number, ry: number, mat: Material) => {
      const c = this.add(G, new BoxGeometry(s, s * 0.8, s), mat, x, y + s * 0.4, z);
      c.rotation.y = ry;
      this.add(G, new BoxGeometry(s + 0.02, 0.06, s + 0.02), m.accent, x, y + s * 0.62, z).rotation.y = ry;
      return c;
    };
    crate(0, 0, 0, 1.0, 0.1, m.panel);
    crate(1.05, 0, 0.1, 0.9, -0.2, m.hull);
    crate(0.3, 0.8, 0.0, 0.8, 0.4, m.hull);
    const tipped = crate(-1.3, 0, 1.0, 0.9, 0.8, m.panel);
    tipped.rotation.z = 1.2;
    tipped.position.y = 0.45;
    // its spilled contents
    for (let k = 0; k < 5; k++) {
      this.add(G, new BoxGeometry(0.2, 0.12, 0.3), k % 2 ? m.metal : m.glass, -1.8 + k * 0.25, 0.06, 1.7 + (k % 3) * 0.2, false).rotation.y = k;
    }
    return [G];
  }

  /** Lamp posts round the summit; one of them flickers. */
  private buildLamps() {
    const m = this.m;
    for (const [x, z] of [
      [-10.5, 2.5],
      [-3.5, 8.5],
      [6.0, 7.5],
      [11.5, 1.5],
    ]) {
      const G = new Group();
      this.seat(G, x, z, 0.1);
      this.group.add(G);
      this.add(G, new CylinderGeometry(0.06, 0.09, 2.9, 5), m.metal, 0, 1.15, 0);
      this.add(G, new BoxGeometry(0.4, 0.08, 0.16), m.metal, 0.15, 2.6, 0);
      const mat = toonMaterial({ dark: 0x3a3630, mid: 0x3a3630, light: 0x3a3630, unlit: true, outline: 0 });
      this.add(G, new BoxGeometry(0.24, 0.1, 0.14), mat, 0.25, 2.52, 0, false);
      const head = new Object3D();
      head.position.set(0.25, 2.45, 0);
      G.add(head);
      this.lampMats.push(mat);
      this.lampHeads.push(head);
      const glow = new Glow(rgb(0xffe6b0), 0.6, { core: 0.6 });
      this.lampGlows.push(glow);
    }
  }

  addTo(scene: Object3D) {
    scene.add(this.group, this.redGlow, ...this.lampGlows);
  }

  // ----------------------------------------------------------------- update

  update(dt: number, time: number, listener: Vector3) {
    const d = Math.hypot(listener.x - this.center.x, listener.z - this.center.z);
    this.distance = d;
    // its hum and noises, louder close up
    const level = d < 60 ? 1 / (1 + (d / 9) * (d / 9)) : 0;
    this.audio.setSite(this.sound, level, clamp((this.center.x - listener.x) / 12, -0.8, 0.8), 1 - clamp(d / 50, 0, 1), 0.5);
    if (d > 70) return;

    // the red light on the mast: a slow blink
    const on = (time % 2.4) < 0.25;
    (this.redMat.uniforms.uLight.value as Vector3).copy(on ? RED_ON : RED_OFF);
    this.redTip.getWorldPosition(this.redGlow.position);
    this.redGlow.strength = on ? 0.9 : 0;
    // the door's emergency light glows dully
    (this.doorLight.uniforms.uLight.value as Vector3).set(0.48 + 0.1 * noise1(time * 2, 3), 0.06, 0.06);

    // lamps: three steady (pale in the daylight), one flickering out
    for (let k = 0; k < this.lampMats.length; k++) {
      let lit = 1;
      if (k === 1) {
        const n = noise1(time * 6, 41);
        lit = n > 0.15 ? 1 : n > -0.2 && Math.random() < 0.3 ? 1 : 0;
      }
      (this.lampMats[k].uniforms.uLight.value as Vector3).copy(lit ? LAMP_ON : LAMP_OFF);
      this.lampHeads[k].getWorldPosition(this.lampGlows[k].position);
      this.lampGlows[k].strength = lit * 0.35;
    }

    // the torn wiring sparks now and then
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = 1.5 + Math.random() * 5;
      this.sparkFrom.getWorldPosition(this.tmp);
      const n = 6 + Math.floor(Math.random() * 8);
      for (let i = 0; i < n; i++) {
        this.dust.spawn(
          this.tmp.x,
          this.tmp.y,
          this.tmp.z,
          (Math.random() - 0.5) * 2 + this.rowOut.x,
          Math.random() * 1.6,
          (Math.random() - 0.5) * 2 + this.rowOut.z,
          0.3 + Math.random() * 0.4,
          SPARK_HOT,
          1,
          { g: 9, drag: 1, windK: 0.1, c2: SPARK_COOL },
        );
      }
      this.audio.siteSpark(this.sound, 0.25);
    }
    // a broken alarm chirps; a loose panel creaks in the wind
    this.beepTimer -= dt;
    if (this.beepTimer <= 0) {
      this.beepTimer = 5 + Math.random() * 9;
      this.audio.siteBeep(this.sound, 0.12, 0.8);
      if (Math.random() < 0.5) setTimeout(() => this.audio.siteBeep(this.sound, 0.1, 0.8), 180);
    }
    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.creakTimer = 6 + Math.random() * 10;
      this.audio.siteCreak(this.sound, 0.25, 0.8 + Math.random() * 0.4);
    }
  }
}
