import { BoxGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, Object3D, Vector3, type BufferGeometry, type Material, type ShaderMaterial } from 'three';
import { Creature, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import type { FootPose, HandPose, ScriptPose } from '../character/scriptPose';
import { noise1 } from '../core/math';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { Glow } from '../render/glow';
import { bakeStatic } from '../render/bake';
import { terrainHeight } from '../world/terrain';
import { footprintOf, type Rocks } from '../world/rocks';
import type { Facility } from '../world/facility';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({ x, z, lift, tilt, pitch, poleDown });

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

const C = (hex: number) => rgb(hex).toArray();
const SPARK_HOT = C(0xfff4c8);
const SPARK_COOL = C(0xd9824a);
const SMOKE = C(0x4a4442);
const SMOKE_FADE = C(0x9a928a);

/** Husky green, like the three at the station: one of the creature's own kind. */
const GREEN: Skin = {
  fur: [0x3c4a33, 0x5a6e4a, 0x748a60],
  belly: [0x7c8e68, 0xa0b48a, 0xb8c8a0],
  hoof: [0x232c1e, 0x3c4a33],
  eye: 0x8c949a,
};

/** Thrown back from the barricade onto its back, one arm flung out, the other reaching for its rifle. */
const THROWN: ScriptPose = {
  tremble: 0,
  exertion: 0,
  eyeOpen: 0.5,
  pelvisX: 0,
  pelvisY: 0.13,
  pelvisZ: 0,
  pelvisPitch: -1.4,
  pelvisYaw: 0.35,
  pelvisRoll: 0.05,
  spinePitch: 0.04,
  chestPitch: 0.02,
  chestRoll: 0.12,
  neckPitch: -0.2,
  headPitch: -0.25,
  headYaw: -1.0,
  headRoll: 0.3,
  handL: hand(0.62, 0.03, -0.28),
  handR: hand(-0.5, 0.03, -0.05),
  armPitch: -1.2,
  elbow: -0.3,
  armOut: 0.9,
  footL: foot(0.3, 0.62, 0, 0.35, 0.1, -1),
  footR: foot(-0.18, 0.7, 0.05, 0.4, 0.6, -0.4),
};

/**
 * What was left after the fighting at the facility's door.
 *
 * One of the creature's own kind, husky green, lies on its back behind the
 * barricade where it was thrown, in scant armour of the ship's make: an
 * off-white chest plate banded in orange, a pauldron, a bracer, a plate on one
 * thigh, a headset. Two holes are burnt through the chest plate. Its rifle,
 * of the same make, lies by its outstretched hand, the power cell in its side
 * still faintly pulsing. Spent cells are scattered round it.
 *
 * Out on the sand, on the lip of a shell crater, a human lies face down in
 * black armour from head to foot, its visor a black slab with one red line,
 * a pack on its back, two holes burnt through its back plate, still smoking
 * thinly; its rifle, black and heavy, lies flung ahead of its reaching hand.
 * Its radio still crackles now and then.
 *
 * And in another crater a four-legged machine, black like the drone, with the
 * same red eye: a hunting dog of a robot, half sunk in the sand, a front leg
 * snapped off at the knee and lying beside it. It is not quite dead: its eye
 * flickers, its head twitches, the stump of its leg jerks with a whine of
 * servos, and sparks spit from the break.
 */
export class Aftermath {
  readonly group = new Group();
  /** The creature, for the camera and the eyes to settle on. */
  readonly fallenAt = new Vector3();
  readonly humanAt = new Vector3();
  readonly dogAt = new Vector3();
  /** Where the two rifles lie. */
  readonly rifleAt = new Vector3();
  readonly humanRifleAt = new Vector3();
  private readonly world: World = { height: terrainHeight, rocks: [] };
  private readonly smokeFrom: Object3D[] = [];
  private readonly cellMat: ShaderMaterial;
  private readonly cellGlow = new Glow(rgb(0x5ad8ff), 0.35, { core: 0.6 });
  private readonly cellAt = new Object3D();
  private readonly eyeMat: ShaderMaterial;
  private readonly eyeGlow = new Glow(rgb(0xff3020), 0.5, { core: 0.7 });
  private readonly dogHead = new Group();
  private readonly dogEye = new Object3D();
  private readonly dogStump = new Group();
  /** Its antennas, which shudder when it twitches. */
  private readonly antennas: Group[] = [];
  private readonly sparkAt = new Object3D();
  private headRest = { x: 0, y: 0, z: 0 };
  private headKick = { x: 0, y: 0, z: 0 };
  private twitchTimer = 2;
  private stumpTimer = 3;
  private stumpT = -1;
  private sparkTimer = 1;
  private smokeTimer = 0.5;
  private radioTimer = 6;
  private glitchTimer = 4;
  private eyeOut = 0;
  private readonly tmp = new Vector3();
  private readonly M: Record<string, Material>;

  constructor(
    private readonly facility: Facility,
    private readonly rocks: Rocks,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
    private readonly snap: (p: Vector3, o: Vector3) => Vector3,
  ) {
    const t = (dark: number, mid: number, light: number, outline = 0.6, highlight = 0.8) => toonMaterial({ dark, mid, light, litAt: 0.55, outline, highlight });
    this.M = {
      hull: t(0x6f6a62, 0xa8a294, 0xdcd6c8, 0.6, 1),
      panel: t(0x625d56, 0x958f83, 0xc9c3b5, 0.6, 1),
      accent: t(0x7a3a24, 0xb85a34, 0xd9824a),
      metal: t(0x2e2a2a, 0x4a4542, 0x6e6862),
      charred: t(0x141010, 0x221a18, 0x2e2420, 0, 0),
      blood: t(0x1e2630, 0x28323e, 0x34414f, 0, 0),
      redBlood: t(0x2a0606, 0x420a0a, 0x5a1010, 0, 0.3),
      // the black armour and machines: the drone's own make
      black: t(0x15171a, 0x24272c, 0x3c4148, 0.8, 0.7),
      blacker: t(0x0e0f11, 0x1a1c1f, 0x2e3136, 0.8, 0.8),
      visor: t(0x050608, 0x0c0e12, 0x2a3240, 0.6, 1),
      band: t(0x5a4a10, 0x8a7418, 0xb89a28, 0.6, 0.3),
      wire: t(0x3a0c0c, 0x6a1a14, 0x8a2a1e, 0.3, 0.3),
      sand: toonMaterial({ dark: 0xbca872, mid: 0xd7bf86, light: 0xe8d39a, litAt: 0.55, outline: 0, highlight: 0 }),
      ember: toonMaterial({ dark: 0x7a2a0e, mid: 0x7a2a0e, light: 0x7a2a0e, unlit: true, outline: 0 }),
      redLine: toonMaterial({ dark: 0x6a0a08, mid: 0x6a0a08, light: 0x6a0a08, unlit: true, outline: 0 }),
      cyanDead: toonMaterial({ dark: 0x1a3a40, mid: 0x1a3a40, light: 0x1a3a40, unlit: true, outline: 0 }),
    };
    this.cellMat = toonMaterial({ dark: 0x2a6a78, mid: 0x2a6a78, light: 0x2a6a78, unlit: true, outline: 0 });
    this.eyeMat = toonMaterial({ dark: 0x5a0a08, mid: 0x5a0a08, light: 0x5a0a08, unlit: true, outline: 0 });
    this.cellGlow.strength = 0;
    this.eyeGlow.strength = 0;
  }

  addTo(scene: Object3D) {
    scene.add(this.group, this.cellGlow, this.eyeGlow);
  }

  private add(parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, shadow = true) {
    const m = new Mesh(faceted(geo), mat);
    m.position.set(x, y, z);
    if (shadow) m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  }

  private box(parent: Object3D, w: number, h: number, d: number, mat: Material, x: number, y: number, z: number, shadow = true) {
    return this.add(parent, new BoxGeometry(w, h, d), mat, x, y, z, shadow);
  }

  /** A group standing on the ground at a point of the facility's frame, turned `turn` from facing out of its front. */
  private seat(x: number, z: number, turn: number, sink = 0) {
    const g = new Group();
    this.facility.place(x, -sink, z, g.position);
    g.rotation.y = this.facility.yaw + turn;
    this.group.add(g);
    return g;
  }

  /** A pool of blood (or anything) on the ground under a point of the facility's frame. */
  private pool(x: number, z: number, r: number, mat: Material, k: number) {
    const p = this.facility.place(x, 0.008 + k * 0.001, z);
    const m = new Mesh(new CylinderGeometry(r, r * 1.1, 0.01, 8), mat);
    m.position.copy(p);
    m.scale.set(1.3, 1, 0.85);
    m.rotation.y = k * 1.7;
    this.group.add(m);
  }

  /** A low drift of sand over something. */
  private drift(parent: Object3D, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
    const d = this.add(parent, new IcosahedronGeometry(0.3, 1), this.M.sand, x, y, z);
    d.scale.set(sx, sy, sz);
  }

  *build(): Generator<unknown, void, unknown> {
    this.buildFallen();
    yield;
    this.buildHuman();
    yield;
    this.buildDog();
    yield;
    bakeStatic(this.group, [this.cellAt, this.dogHead, this.dogStump, this.sparkAt, ...this.antennas, ...this.smokeFrom]);
  }

  // ------------------------------------------------------------- the fallen

  private buildFallen() {
    const M = this.M;
    const x = -3.7;
    const z = 9.1;
    const at = this.facility.place(x, 0, z);
    const c = new Creature(this.world, at.x, at.z, GREEN);
    // it was thrown back from the barricade and came down across the slope behind it
    c.setYaw(this.facility.yaw + 1.75);
    c.pos.set(at.x, at.y, at.z);
    c.snap = this.snap;
    c.scriptBreath = { value: 0, amp: 0 };
    for (let i = 0; i < 30; i++) c.updateScripted(1 / 30, THROWN, this.world);
    const rig = c.rig;
    // its armour: an off-white chest plate banded in orange, a pauldron, a bracer, a thigh plate
    this.box(rig.chest, 0.36, 0.26, 0.045, M.hull, 0, 0.16, 0.14);
    this.box(rig.chest, 0.37, 0.05, 0.05, M.accent, 0, 0.24, 0.142);
    this.box(rig.chest, 0.34, 0.24, 0.04, M.panel, 0, 0.16, -0.135);
    for (const sx of [-1, 1]) this.box(rig.chest, 0.04, 0.2, 0.26, M.metal, sx * 0.18, 0.16, 0);
    const pad = this.box(rig.arms[0].shoulder, 0.17, 0.08, 0.2, M.hull, 0.02, 0.02, 0);
    pad.rotation.z = -0.3;
    this.box(rig.arms[0].shoulder, 0.17, 0.03, 0.21, M.accent, 0.03, 0.06, 0).rotation.z = -0.3;
    this.box(rig.arms[1].elbow, 0.12, 0.13, 0.12, M.panel, 0, -0.1, 0);
    this.box(rig.legs[0].thigh.obj, 0.17, 0.15, 0.05, M.hull, 0, -0.1, 0.08);
    this.box(rig.pelvis, 0.33, 0.05, 0.23, M.metal, 0, 0.06, 0);
    for (const sx of [-1, 1]) this.box(rig.pelvis, 0.07, 0.07, 0.06, M.panel, sx * 0.1, 0.03, 0.12);
    // a headset: an earpiece and a short antenna, its light gone dark
    this.box(rig.head, 0.04, 0.08, 0.08, M.metal, 0.225, 0.1, 0);
    this.box(rig.head, 0.015, 0.16, 0.015, M.metal, 0.235, 0.2, -0.03);
    this.box(rig.head, 0.02, 0.02, 0.02, M.cyanDead, 0.247, 0.08, 0.03, false);
    // two holes burnt through the chest plate, the fur charred round them
    for (const [wx, wy] of [
      [0.07, 0.19],
      [-0.06, 0.1],
    ]) {
      this.add(rig.chest, new CylinderGeometry(0.045, 0.05, 0.012, 6).rotateX(Math.PI / 2), M.charred, wx, wy, 0.166, false);
      this.box(rig.chest, 0.02, 0.02, 0.014, M.ember, wx, wy, 0.17, false);
    }
    rig.root.updateMatrixWorld(true);
    rig.chest.getWorldPosition(this.fallenAt);
    this.group.add(rig.root);
    this.rocks.addStatic(footprintOf(rig.root, 0.3));
    // its blood, dried dark in the sand, and smeared where it fell back
    for (const [r, dx, dz, k] of [
      [0.28, 0, -0.35, 0],
      [0.22, 0.3, 0.2, 1],
      [0.14, -0.4, 0.5, 2],
      [0.08, 0.2, 0.9, 3],
    ])
      this.pool(x + dx, z + dz, r, M.blood, k);
    // its rifle, by its reaching hand
    const hp = rig.arms[1].hand.getWorldPosition(new Vector3());
    const r = new Group();
    r.position.set(hp.x + 0.35, terrainHeight(hp.x + 0.35, hp.z + 0.3) + 0.06, hp.z + 0.3);
    r.rotation.y = this.facility.yaw + 0.6;
    this.group.add(r);
    this.rifleAt.copy(r.position);
    this.alienRifle(r);
  }

  /**
   * The creature's kind's rifle, of the ship's make: a long, slim off-white
   * body swept back into a thumbhole stock, banded in orange; a long scope
   * along its spine; and in front, instead of a barrel, two parallel rails
   * with coils glowing faintly between them, joined at the muzzle by an
   * emitter ring. A power cell sits in its flank. It lies on its side.
   */
  private alienRifle(G: Object3D) {
    const M = this.M;
    const R = new Group();
    R.rotation.z = Math.PI / 2;
    G.add(R);
    // the body: a chamfered slab, a fin swept forward under it, orange down its spine
    const body = this.box(R, 0.09, 0.12, 0.46, M.hull, 0, 0, 0);
    body.rotation.x = -0.02;
    this.box(R, 0.094, 0.03, 0.36, M.accent, 0, 0.06, 0.03);
    const fin = this.box(R, 0.05, 0.08, 0.22, M.panel, 0, -0.08, 0.14);
    fin.rotation.x = -0.35;
    // the stock: swept back and down, open in the middle for the thumb
    const st = new Group();
    st.position.set(0, -0.01, -0.23);
    st.rotation.x = 0.16;
    R.add(st);
    this.box(st, 0.07, 0.035, 0.32, M.hull, 0, 0.045, -0.14);
    this.box(st, 0.07, 0.035, 0.28, M.panel, 0, -0.06, -0.16);
    this.box(st, 0.075, 0.14, 0.05, M.hull, 0, -0.005, -0.3);
    this.box(st, 0.08, 0.15, 0.02, M.metal, 0, -0.005, -0.33);
    // the grip, raked back, and a long scope along the top
    const grip = this.box(R, 0.055, 0.15, 0.06, M.metal, 0, -0.12, -0.1);
    grip.rotation.x = -0.4;
    this.box(R, 0.05, 0.05, 0.3, M.metal, 0, 0.11, 0.03);
    this.box(R, 0.06, 0.06, 0.03, M.accent, 0, 0.11, 0.19);
    this.box(R, 0.04, 0.04, 0.01, M.cyanDead, 0, 0.11, 0.206, false);
    // the twin rails, coils glowing between them, an emitter ring at the muzzle
    for (const sy of [-1, 1]) {
      this.box(R, 0.035, 0.03, 0.5, M.metal, 0, 0.01 + sy * 0.035, 0.46);
      this.box(R, 0.04, 0.012, 0.44, M.hull, 0, 0.01 + sy * 0.052, 0.44);
    }
    for (const zz of [0.3, 0.38, 0.46, 0.54, 0.62]) this.add(R, new BoxGeometry(0.02, 0.04, 0.025), this.cellMat, 0, 0.01, zz, false);
    this.add(R, new CylinderGeometry(0.065, 0.065, 0.04, 8).rotateX(Math.PI / 2), M.accent, 0, 0.01, 0.72);
    this.add(R, new CylinderGeometry(0.035, 0.035, 0.042, 8).rotateX(Math.PI / 2), M.cyanDead, 0, 0.01, 0.722, false);
    // the power cell, still faintly alive
    this.add(R, new BoxGeometry(0.025, 0.05, 0.12), this.cellMat, 0.05, -0.005, -0.02, false);
    this.cellAt.position.set(0.07, 0.0, 0.3);
    R.add(this.cellAt);
  }

  // -------------------------------------------------------------- the human

  /** A human in black armour from head to foot, face down, built a block at a time where it fell. */
  private buildHuman() {
    const M = this.M;
    const x = 1.0;
    const z = 16.8;
    // lying face down, head toward the door, as it came on
    const H = this.seat(x, z, Math.PI / 2 + 0.25);
    H.updateMatrixWorld(true);
    this.humanAt.copy(H.position);
    const S = 1.1;
    const B = new Group();
    B.scale.setScalar(S);
    H.add(B);
    // pelvis and torso, the back plate and the pack on it
    this.box(B, 0.36, 0.2, 0.3, M.black, 0, 0.12, 0);
    this.box(B, 0.44, 0.26, 0.6, M.black, 0, 0.15, 0.46);
    this.box(B, 0.46, 0.08, 0.52, M.blacker, 0, 0.3, 0.48);
    this.box(B, 0.06, 0.05, 0.5, M.black, 0, 0.35, 0.48);
    this.box(B, 0.3, 0.14, 0.3, M.blacker, 0, 0.41, 0.5);
    this.box(B, 0.04, 0.02, 0.04, M.redLine, 0.1, 0.48, 0.42, false);
    this.box(B, 0.16, 0.025, 0.04, M.band, -0.04, 0.485, 0.6, false);
    for (const sx of [-1, 1]) {
      // shoulder plates
      const sp = this.box(B, 0.16, 0.12, 0.2, M.blacker, sx * 0.27, 0.24, 0.72);
      sp.rotation.z = sx * 0.4;
    }
    // two holes burnt through the back plate, still smouldering
    for (const [wx, wz] of [
      [0.1, 0.36],
      [-0.08, 0.62],
    ]) {
      this.add(B, new CylinderGeometry(0.05, 0.055, 0.012, 6), M.charred, wx, 0.345, wz, false);
      this.box(B, 0.024, 0.014, 0.024, M.ember, wx, 0.352, wz, false);
      const o = new Object3D();
      o.position.set(wx, 0.36, wz);
      B.add(o);
      this.smokeFrom.push(o);
    }
    // the helmet, turned on its side, the visor a black slab with one red line
    const head = new Group();
    head.position.set(0.04, 0.15, 0.92);
    head.rotation.set(0.1, 0, 1.25);
    B.add(head);
    this.box(head, 0.24, 0.26, 0.28, M.black, 0, 0, 0);
    this.box(head, 0.2, 0.12, 0.04, M.visor, 0, 0.02, 0.15);
    this.box(head, 0.16, 0.015, 0.01, M.redLine, 0, 0.04, 0.172, false);
    this.box(head, 0.26, 0.05, 0.3, M.blacker, 0, 0.12, 0);
    this.box(head, 0.03, 0.08, 0.06, M.blacker, 0.13, -0.02, 0.02);
    // the arms: the right flung forward, reaching, the left crumpled under it
    const limb = (parent: Object3D, px: number, py: number, pz: number, rx: number, ry: number, rz: number, len: number, w: number) => {
      const g = new Group();
      g.position.set(px, py, pz);
      g.rotation.set(rx, ry, rz);
      parent.add(g);
      this.box(g, w, w, len, M.black, 0, 0, len / 2);
      this.box(g, w * 1.12, w * 0.5, len * 0.5, M.blacker, 0, w * 0.4, len * 0.45);
      return g;
    };
    const ru = limb(B, -0.3, 0.12, 0.72, 0.1, -0.25, 0, 0.32, 0.12);
    const rf = limb(ru, 0, 0, 0.32, -0.05, 0.15, 0, 0.3, 0.1);
    this.box(rf, 0.11, 0.07, 0.13, M.blacker, 0, -0.01, 0.34);
    const lu = limb(B, 0.3, 0.1, 0.68, 0.2, 2.6, 0.2, 0.3, 0.12);
    const lf = limb(lu, 0, 0, 0.3, 0.4, -1.4, 0, 0.28, 0.1);
    this.box(lf, 0.11, 0.07, 0.13, M.blacker, 0, -0.01, 0.32);
    // the legs, splayed, toes dug into the sand
    for (const [sx, spread, bend] of [
      [-1, -0.18, 0.15],
      [1, 0.32, 0.4],
    ]) {
      const th = limb(B, sx * 0.11, 0.1, -0.12, -0.05, Math.PI + spread, 0, 0.44, 0.15);
      const sh = limb(th, 0, 0, 0.44, 0.0, bend * sx, 0, 0.42, 0.13);
      this.box(sh, 0.15, 0.1, 0.12, M.blacker, 0, 0.0, 0.2);
      const boot = this.box(sh, 0.15, 0.24, 0.12, M.blacker, 0, -0.08, 0.46);
      boot.rotation.x = 0.2;
    }
    // its blood, red, soaked into the sand under it, and sand blown over its legs
    this.pool(x, z - 0.6, 0.45, M.redBlood, 0);
    this.pool(x + 0.3, z - 0.1, 0.2, M.redBlood, 1);
    this.drift(B, 0.2, 0.05, -0.65, 1.3, 0.45, 1.6);
    this.drift(B, -0.25, 0.03, -0.3, 0.9, 0.3, 1.1);
    this.rocks.addStatic(footprintOf(B, 0.4));
    // its rifle, flung ahead of the reaching hand
    const ahead = H.localToWorld(new Vector3(-0.5, 0, 1.9));
    const r = new Group();
    r.position.set(ahead.x, terrainHeight(ahead.x, ahead.z), ahead.z);
    r.rotation.y = H.rotation.y + 0.7;
    this.group.add(r);
    r.position.y += 0.07;
    this.humanRifleAt.copy(r.position);
    this.humanRifle(r);
  }

  /**
   * The human's rifle: an M16's lines made black and new. A straight stock in
   * line with the barrel, a raked pistol grip and a curved magazine, the carry
   * handle over the receiver turned into a sight with a red lens, a long
   * angular handguard slotted for cooling with a thin red light down it, the
   * triangle of the front sight, and a slim barrel ending in a flash hider.
   * It lies on its side.
   */
  private humanRifle(G: Object3D) {
    const M = this.M;
    const R = new Group();
    R.rotation.z = Math.PI / 2;
    G.add(R);
    // the stock, straight back in line with the bore, its butt plate, a cheek rest
    const stock = this.box(R, 0.06, 0.09, 0.26, M.black, 0, -0.005, -0.34);
    stock.rotation.x = 0.04;
    this.box(R, 0.065, 0.13, 0.04, M.blacker, 0, -0.02, -0.48);
    this.box(R, 0.05, 0.03, 0.16, M.blacker, 0, 0.05, -0.33);
    // the lower receiver, the raked pistol grip, the trigger guard
    this.box(R, 0.06, 0.07, 0.24, M.black, 0, -0.01, -0.09);
    const grip = this.box(R, 0.045, 0.13, 0.055, M.blacker, 0, -0.1, -0.15);
    grip.rotation.x = 0.4;
    this.box(R, 0.012, 0.012, 0.09, M.blacker, 0, -0.07, -0.06, false);
    // the curved magazine, in two pieces bending forward
    const m1 = this.box(R, 0.035, 0.11, 0.07, M.blacker, 0, -0.1, -0.01);
    m1.rotation.x = -0.1;
    const m2 = this.box(R, 0.035, 0.1, 0.066, M.blacker, 0, -0.195, 0.015);
    m2.rotation.x = -0.32;
    // the upper receiver, its ejection port, the forward assist, the charging handle
    this.box(R, 0.064, 0.07, 0.3, M.black, 0, 0.06, -0.07);
    this.box(R, 0.01, 0.025, 0.07, M.blacker, 0.033, 0.06, -0.03, false);
    this.add(R, new CylinderGeometry(0.014, 0.014, 0.05, 6).rotateX(Math.PI / 2), M.blacker, -0.035, 0.07, -0.16);
    this.box(R, 0.05, 0.015, 0.03, M.blacker, 0, 0.1, -0.2);
    // the carry handle, made a sight: two posts, the bar, a red lens at its back
    this.box(R, 0.03, 0.05, 0.03, M.blacker, 0, 0.12, -0.17);
    this.box(R, 0.03, 0.05, 0.03, M.blacker, 0, 0.12, 0.04);
    this.box(R, 0.045, 0.035, 0.25, M.black, 0, 0.16, -0.065);
    this.box(R, 0.032, 0.022, 0.01, M.redLine, 0, 0.16, -0.193, false);
    // the handguard: long, angular, slotted, a thin red light along it
    this.add(R, new CylinderGeometry(0.045, 0.04, 0.28, 8).rotateX(Math.PI / 2), M.black, 0, 0.045, 0.22);
    for (const zz of [0.12, 0.17, 0.22, 0.27, 0.32]) this.box(R, 0.092, 0.012, 0.025, M.blacker, 0, 0.05, zz, false);
    this.box(R, 0.006, 0.006, 0.2, M.redLine, 0.046, 0.06, 0.22, false);
    // the front sight: a triangle standing up off the barrel
    const fs = this.box(R, 0.02, 0.1, 0.035, M.blacker, 0, 0.1, 0.38);
    fs.rotation.x = 0.25;
    this.add(R, new CylinderGeometry(0.024, 0.024, 0.03, 6).rotateX(Math.PI / 2), M.blacker, 0, 0.045, 0.38);
    // the barrel and the flash hider
    this.add(R, new CylinderGeometry(0.012, 0.012, 0.22, 6).rotateX(Math.PI / 2), M.blacker, 0, 0.045, 0.48);
    this.add(R, new CylinderGeometry(0.02, 0.018, 0.06, 6).rotateX(Math.PI / 2), M.black, 0, 0.045, 0.61);
    // the faction's band on the stock
    this.box(R, 0.062, 0.092, 0.025, M.band, 0, -0.005, -0.3, false);
  }

  // ---------------------------------------------------------------- the dog

  /**
   * The machine dog: a big four-legged pack robot, black like the drone. A
   * deep, boxy body with a rounded hood sloping down at its front, louvred
   * vents along its flanks, tube grab bars at both ends, a frame slung under
   * it and two whip antennas standing up off its back; four thick hydraulic
   * legs, the front knees bending forward and the hind knees back, on round
   * treaded feet. Where its hood comes down at the front is a dark sensor
   * window with the drone's red eye in it, and a sensor head on top that
   * still twitches. It is half sunk in a shell crater, slumped on its folded
   * hind legs, its right foreleg snapped at the knee, the lower half lying in
   * the sand beside it.
   */
  private buildDog() {
    const M = this.M;
    const x = 9.3;
    const z = 12.0;
    const D = this.seat(x, z, -0.9, 0.0);
    D.rotation.x = -0.14;
    D.rotation.z = -0.16;
    D.updateMatrixWorld(true);
    this.dogAt.copy(D.position);
    const B = new Group();
    B.position.y = 0.62;
    D.add(B);
    const L = 1.3;
    const W = 0.6;
    const H = 0.44;
    // the body: a deep box, its top edges rounded off, its hood sloping down at the front
    this.box(B, W, H, L, M.black, 0, 0, 0);
    for (const sx of [-1, 1]) {
      const edge = this.box(B, 0.12, 0.12, L * 0.98, M.black, sx * (W / 2 - 0.03), H / 2 - 0.03, 0);
      edge.rotation.z = Math.PI / 4;
    }
    const hood = this.box(B, W * 0.96, 0.34, 0.36, M.black, 0, 0.04, L / 2 + 0.1);
    hood.rotation.x = 0.55;
    this.box(B, W * 0.9, 0.2, 0.12, M.black, 0, -0.1, L / 2 + 0.06);
    // the seam where the hood meets the body, and the rear panel
    this.box(B, W + 0.012, 0.012, 0.012, M.blacker, 0, H / 2 + 0.002, L * 0.18, false);
    this.box(B, W * 0.92, H * 0.85, 0.02, M.blacker, 0, -0.02, -L / 2 - 0.005);
    // louvred vents along each flank, behind the middle
    for (const sx of [-1, 1]) {
      this.box(B, 0.01, H * 0.7, 0.42, M.blacker, sx * (W / 2 + 0.004), 0.0, -0.08, false);
      for (let k = 0; k < 6; k++) {
        const slat = this.box(B, 0.03, 0.022, 0.4, M.black, sx * (W / 2 + 0.012), -0.12 + k * 0.05, -0.08, false);
        slat.rotation.z = sx * 0.5;
      }
    }
    // the drone's red eye, in a dark sensor window under the hood's front edge
    this.box(B, W * 0.7, 0.1, 0.02, M.visor, 0, -0.04, L / 2 + 0.125, false);
    this.add(B, new BoxGeometry(0.07, 0.04, 0.012), this.eyeMat, 0.08, -0.04, L / 2 + 0.137, false);
    this.dogEye.position.set(0.08, -0.04, L / 2 + 0.16);
    B.add(this.dogEye);
    // a little band of the faction's yellow on its flank
    this.box(B, 0.006, 0.05, 0.16, M.band, W / 2 + 0.004, 0.14, 0.3, false);
    // grab bars of tube at each end
    const bar = (zEnd: number, y: number, out: number) => {
      for (const sx of [-1, 1]) {
        const post = this.add(B, new CylinderGeometry(0.022, 0.022, out, 6).rotateX(Math.PI / 2), M.blacker, sx * 0.24, y, zEnd + Math.sign(zEnd) * out * 0.5);
        void post;
      }
      this.add(B, new CylinderGeometry(0.022, 0.022, 0.5, 6).rotateZ(Math.PI / 2), M.blacker, 0, y, zEnd + Math.sign(zEnd) * out);
    };
    bar(-L / 2, 0.04, 0.16);
    bar(-L / 2, -0.12, 0.1);
    bar(L / 2 + 0.12, -0.17, 0.12);
    // the frame slung under it
    for (const sx of [-1, 1]) this.box(B, 0.04, 0.04, L * 0.9, M.blacker, sx * 0.2, -H / 2 - 0.08, 0);
    for (const sz of [-0.35, 0.35]) this.box(B, 0.44, 0.04, 0.04, M.blacker, 0, -H / 2 - 0.08, sz);
    this.box(B, 0.3, 0.12, 0.5, M.blacker, 0, -H / 2 - 0.04, -0.05);
    // two whip antennas off its back, and the sensor head on top at the front (it twitches)
    this.antennas.length = 0;
    for (const [ax, az, h, lean] of [
      [0.12, 0.1, 0.62, 0.12],
      [-0.16, -0.38, 0.5, -0.1],
    ]) {
      const a = new Group();
      a.position.set(ax, H / 2, az);
      a.rotation.z = lean;
      B.add(a);
      this.box(a, 0.05, 0.06, 0.05, M.blacker, 0, 0.03, 0);
      this.add(a, new CylinderGeometry(0.008, 0.014, h, 5), M.blacker, 0, h / 2 + 0.05, 0);
      this.antennas.push(a);
    }
    this.dogHead.position.set(0, H / 2 + 0.03, L / 2 - 0.1);
    B.add(this.dogHead);
    this.add(this.dogHead, new CylinderGeometry(0.07, 0.08, 0.07, 10), M.blacker, 0, 0.035, 0);
    this.box(this.dogHead, 0.1, 0.04, 0.02, M.visor, 0, 0.04, 0.07, false);
    this.headRest = { x: 0, y: 0.3, z: 0 };
    this.dogHead.rotation.set(this.headRest.x, this.headRest.y, this.headRest.z);
    // legs: a big hip drive, a thick thigh, a knee drive, a shin, a round treaded foot.
    // `a` swings the thigh back, `b` the shin back from it; the front knees point forward
    const leg = (hx: number, hz: number, a: number, b: number, broken: boolean) => {
      const hip = new Group();
      hip.position.set(hx, -H / 2 + 0.02, hz);
      hip.rotation.x = a;
      B.add(hip);
      this.add(hip, new CylinderGeometry(0.1, 0.1, 0.16, 10).rotateZ(Math.PI / 2), M.blacker, 0, 0, 0);
      this.box(hip, 0.15, 0.46, 0.17, M.black, 0, -0.23, 0);
      this.box(hip, 0.155, 0.18, 0.08, M.blacker, 0, -0.18, -0.06);
      this.box(hip, 0.03, 0.03, 0.006, M.hull, 0.079, -0.3, 0.03, false);
      const knee = new Group();
      knee.position.set(0, -0.46, 0);
      knee.rotation.x = b;
      hip.add(knee);
      this.add(knee, new CylinderGeometry(0.075, 0.075, 0.14, 10).rotateZ(Math.PI / 2), M.blacker, 0, 0, 0);
      if (broken) {
        // snapped: torn struts and hydraulic lines hanging from the knee, and it sparks
        this.box(knee, 0.05, 0.14, 0.05, M.blacker, 0.02, -0.07, 0.02).rotation.z = 0.3;
        this.box(knee, 0.014, 0.18, 0.014, M.wire, -0.03, -0.09, 0.0).rotation.z = -0.4;
        this.box(knee, 0.012, 0.14, 0.012, M.wire, 0.0, -0.07, 0.03).rotation.x = 0.5;
        this.sparkAt.position.set(0, -0.14, 0);
        knee.add(this.sparkAt);
        // it jerks from its hip
        this.dogStump.position.copy(hip.position);
        hip.position.set(0, 0, 0);
        this.dogStump.add(hip);
        B.add(this.dogStump);
        return;
      }
      this.box(knee, 0.11, 0.44, 0.13, M.black, 0, -0.22, 0);
      this.box(knee, 0.03, 0.03, 0.006, M.hull, 0.057, -0.3, 0.05, false);
      const foot = this.add(knee, new CylinderGeometry(0.085, 0.085, 0.09, 10).rotateZ(Math.PI / 2), M.blacker, 0, -0.46, 0);
      void foot;
      for (let k = 0; k < 4; k++) this.box(knee, 0.1, 0.02, 0.17, M.black, 0, -0.46, 0).rotation.x = (k * Math.PI) / 4;
    };
    // the front left planted, holding it up; the right snapped; the hind legs folded under it
    leg(0.3, 0.46, -0.35, 0.95, false);
    leg(-0.3, 0.46, -0.15, 0.6, true);
    leg(0.3, -0.48, 1.3, -2.45, false);
    leg(-0.3, -0.48, 1.4, -2.5, false);
    // the broken-off half of the leg, lying in the sand beside it
    const lost = this.seat(x - 1.3, z + 0.6, 1.2);
    lost.position.y += 0.08;
    const piece = new Group();
    piece.rotation.z = Math.PI / 2 - 0.12;
    lost.add(piece);
    this.box(piece, 0.11, 0.44, 0.13, M.black, 0, 0, 0);
    this.add(piece, new CylinderGeometry(0.085, 0.085, 0.09, 10).rotateZ(Math.PI / 2), M.blacker, 0, -0.24, 0);
    this.box(piece, 0.014, 0.16, 0.014, M.wire, 0.01, 0.28, 0);
    this.box(piece, 0.03, 0.03, 0.006, M.hull, 0.057, 0.0, 0.05, false);
    // sand slumped round it where it sank, and its black hydraulic fluid leaked into the crater
    this.drift(D, 0.1, -0.06, 0.5, 1.5, 0.28, 1.1);
    this.drift(D, 0.3, -0.08, -0.7, 1.3, 0.25, 1.2);
    this.pool(x + 0.5, z - 0.6, 0.38, M.blacker, 0);
    this.rocks.addStatic(footprintOf(B, 0.6));
  }

  // ---------------------------------------------------------------- alive

  update(dt: number, time: number, listener: Vector3) {
    const d = Math.hypot(listener.x - this.dogAt.x, listener.z - this.dogAt.z);
    if (d > 90) {
      this.eyeGlow.strength = 0;
      this.cellGlow.strength = 0;
      return;
    }
    const near = 1 / (1 + (d / 10) * (d / 10));
    const sound = this.facility.sound;
    // the rifle's cell, pulsing slowly
    const pulse = 0.5 + 0.5 * Math.sin(time * 1.8);
    (this.cellMat.uniforms.uLight.value as Vector3).set(0.12 + 0.25 * pulse, 0.35 + 0.45 * pulse, 0.42 + 0.5 * pulse);
    this.cellAt.getWorldPosition(this.cellGlow.position);
    this.cellGlow.strength = 0.1 + 0.2 * pulse;

    // the dog: its eye flickers and gutters, and now and then cuts out
    this.eyeOut -= dt;
    const flick = noise1(time * 9, 5);
    const eyeOn = this.eyeOut <= 0 && flick > -0.55;
    const k = eyeOn ? 0.7 + 0.3 * Math.max(0, flick) : 0.08;
    (this.eyeMat.uniforms.uLight.value as Vector3).set(k, 0.1 * k, 0.07 * k);
    this.dogEye.getWorldPosition(this.eyeGlow.position);
    this.eyeGlow.strength = eyeOn ? 0.55 * k : 0;
    this.glitchTimer -= dt;
    if (this.glitchTimer <= 0) {
      this.glitchTimer = 3 + Math.random() * 6;
      this.eyeOut = 0.15 + Math.random() * 0.5;
      if (d < 40) this.audio.dogGlitch(sound, 0.35);
    }
    // its head twitches, snaps toward the creature, then droops back
    this.twitchTimer -= dt;
    if (this.twitchTimer <= 0) {
      this.twitchTimer = 1.5 + Math.random() * 4;
      const toward = d < 12;
      this.headKick = { x: (Math.random() - 0.5) * 0.5 - (toward ? 0.3 : 0), y: (Math.random() - 0.5) * 0.9, z: (Math.random() - 0.5) * 0.4 };
      if (d < 40) this.audio.dogServo(sound, 0.25, 0.6);
    }
    const f = Math.exp(-dt * 2.5);
    this.headKick.x *= f;
    this.headKick.y *= f;
    this.headKick.z *= f;
    this.dogHead.rotation.set(
      this.headRest.x + this.headKick.x + Math.sin(time * 31) * 0.01,
      this.headRest.y + this.headKick.y,
      this.headRest.z + this.headKick.z,
    );
    // the antennas shudder with each twitch, and sway on the wind
    this.antennas.forEach((a, n) => {
      a.rotation.x = Math.sin(time * 9 + n * 2) * (Math.abs(this.headKick.y) * 0.35) + Math.sin(time * 1.3 + n) * 0.03;
    });
    // the stump of its leg jerks, servos whining, and the break sparks
    this.stumpTimer -= dt;
    if (this.stumpTimer <= 0) {
      this.stumpTimer = 2.5 + Math.random() * 5;
      this.stumpT = 0;
      if (d < 50) this.audio.dogServo(sound, 0.45, 1.3);
    }
    if (this.stumpT >= 0) {
      this.stumpT += dt;
      const j = this.stumpT < 0.6 ? Math.sin(this.stumpT * 40) * 0.25 * (1 - this.stumpT / 0.6) + Math.sin((this.stumpT / 0.6) * Math.PI) * 0.6 : 0;
      this.dogStump.rotation.x = -j;
      if (this.stumpT > 0.6) this.stumpT = -1;
    }
    this.sparkTimer -= dt;
    if (this.sparkTimer <= 0) {
      this.sparkTimer = this.stumpT >= 0 ? 0.08 : 0.8 + Math.random() * 3;
      this.sparkAt.getWorldPosition(this.tmp);
      for (let i = 0; i < 6 + Math.random() * 8; i++) {
        this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, (Math.random() - 0.5) * 1.6, Math.random() * 1.4, (Math.random() - 0.5) * 1.6, 0.3 + Math.random() * 0.4, SPARK_HOT, 1, { g: 9, drag: 0.6, windK: 0, c2: SPARK_COOL });
      }
      if (d < 40) this.audio.siteSpark(sound, 0.35 * Math.min(1, near * 4));
    }
    // a thread of smoke from the human's back, and its radio, crackling to nobody
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0 && this.smokeFrom.length) {
      this.smokeTimer = 0.4 + Math.random() * 0.7;
      this.smokeFrom[Math.floor(Math.random() * this.smokeFrom.length)].getWorldPosition(this.tmp);
      this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, (Math.random() - 0.5) * 0.05, 0.16 + Math.random() * 0.1, (Math.random() - 0.5) * 0.05, 2.2 + Math.random(), SMOKE, 1, {
        g: -0.12,
        drag: 1.2,
        windK: 0.35,
        c2: SMOKE_FADE,
        soft: true,
      });
    }
    this.radioTimer -= dt;
    if (this.radioTimer <= 0) {
      this.radioTimer = 5 + Math.random() * 9;
      const dh = Math.hypot(listener.x - this.humanAt.x, listener.z - this.humanAt.z);
      if (dh < 25) this.audio.radioStatic(sound, 0.5 / (1 + dh * dh * 0.02));
    }
  }
}
