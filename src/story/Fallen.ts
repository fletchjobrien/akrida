import { CylinderGeometry, Group, Mesh, Vector3, type Object3D } from 'three';
import { Creature, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import type { FootPose, HandPose, ScriptPose } from '../character/scriptPose';
import { toonMaterial } from '../render/shared';
import { terrainHeight } from '../world/terrain';
import { footprintOf, type Rocks } from '../world/rocks';

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({
  x,
  z,
  lift,
  tilt,
  pitch,
  poleDown,
});

/** Husky green. */
const GREEN: Skin = {
  fur: [0x3c4a33, 0x5a6e4a, 0x748a60],
  belly: [0x7c8e68, 0xa0b48a, 0xb8c8a0],
  hoof: [0x232c1e, 0x3c4a33],
  eye: 0xe8ffd8,
};
/** Husky blue, a little deeper than the stranger's. */
const BLUE: Skin = {
  fur: [0x2f4258, 0x4b6684, 0x62809e],
  belly: [0x7891aa, 0x9ab2c8, 0xb2c6d8],
  hoof: [0x1e2836, 0x2f4258],
  eye: 0xd8f0ff,
};
/** Husky rust, like the creature's own, but redder. */
const RUST: Skin = {
  fur: [0x4c2a24, 0x7a4a40, 0x8e5e52],
  belly: [0x9a6a60, 0xc0928a, 0xd0a8a0],
  hoof: [0x331a17, 0x4c2a24],
  eye: 0xffffff,
};

/** Shared by all three poses: dead still, eyes shut. */
const DEAD = { eyeOpen: 0, tremble: 0, exertion: 0, armPitch: 0, elbow: -0.25, armOut: 0.3 };

/** Slid down the wall to sit against it, legs out, head fallen to one side. Body z points away from the wall. */
const SLUMPED: ScriptPose = {
  ...DEAD,
  pelvisX: 0,
  pelvisY: 0.2,
  pelvisZ: 0,
  pelvisPitch: -0.85,
  pelvisYaw: 0.05,
  pelvisRoll: 0,
  spinePitch: 0.2,
  chestPitch: 0.15,
  chestRoll: 0.08,
  neckPitch: 0.55,
  headPitch: 0.5,
  headYaw: 0.25,
  headRoll: 0.45,
  handL: hand(0.34, 0.03, 0.12),
  handR: hand(-0.3, 0.03, 0.3),
  footL: foot(0.2, 0.62, 0, 0.3, 0, -1),
  footR: foot(-0.14, 0.56, 0, 0.25, 0.2, -1),
};

/** Thrown back onto the ground, arms flung out, head turned aside. */
const SPRAWLED: ScriptPose = {
  ...DEAD,
  pelvisX: 0,
  pelvisY: 0.1,
  pelvisZ: 0,
  pelvisPitch: -1.5,
  pelvisYaw: 0.12,
  pelvisRoll: 0,
  spinePitch: 0.04,
  chestPitch: 0.02,
  chestRoll: 0,
  neckPitch: 0,
  headPitch: 0,
  headYaw: 0.9,
  headRoll: 0.1,
  handL: hand(0.58, 0.0, -0.18),
  handR: hand(-0.52, 0.0, 0.02),
  footL: foot(0.34, 0.62, 0, 0.3, 0, -1),
  footR: foot(-0.26, 0.58, 0, 0.25, 0.1, -1),
};

/** Pitched forward onto its face, one arm under it, the other flung out, head turned aside. */
const FACEDOWN: ScriptPose = {
  ...DEAD,
  pelvisX: 0,
  pelvisY: 0.12,
  pelvisZ: 0,
  pelvisPitch: 1.48,
  pelvisYaw: -0.1,
  pelvisRoll: 0,
  spinePitch: 0.04,
  chestPitch: 0.03,
  chestRoll: 0,
  neckPitch: -0.1,
  headPitch: -0.2,
  headYaw: -1.0,
  headRoll: 0,
  handL: hand(0.48, 0.0, 0.5),
  handR: hand(-0.14, 0.02, 0.26),
  footL: foot(0.15, -0.62, 0, -1.4, -1.5, 1),
  footR: foot(-0.18, -0.58, 0, -1.4, -1.4, 1),
};

/**
 * Three of the creature's kind, lined up against the station's wall and shot:
 * one husky green, one husky blue, one a husky rust like the creature itself
 * but redder. One slid down the wall and sits slumped against it, one was
 * thrown back onto the ground, one pitched forward onto its face. Dried blood,
 * grey-blue like the stranger's, has pooled under them, and the wall behind
 * is pocked with laser hits (see world/station.ts).
 */
export class Fallen {
  readonly group = new Group();
  readonly bodies: Creature[] = [];
  /** The middle of the row, for the creature to look at. */
  readonly lookPoint = new Vector3();

  constructor(world: World, row: Vector3, along: Vector3, out: Vector3, rocks: Rocks, snap: (p: Vector3, o: Vector3) => Vector3) {
    const yaw = Math.atan2(out.x, out.z);
    const set: [Skin, ScriptPose, number, number][] = [
      [GREEN, SPRAWLED, -1.45, 1.05],
      [BLUE, SLUMPED, 0, 0.42],
      [RUST, FACEDOWN, 1.45, 0.55],
    ];
    const blood = toonMaterial({ dark: 0x222b36, mid: 0x2c3846, light: 0x3a4a5c, litAt: 0.6, outline: 0, highlight: 0 });
    for (const [skin, pose, s, o] of set) {
      const x = row.x + along.x * s + out.x * o;
      const z = row.z + along.z * s + out.z * o;
      const c = new Creature(world, x, z, skin);
      c.setYaw(yaw);
      c.pos.set(x, terrainHeight(x, z), z);
      c.snap = snap;
      c.scriptBreath = { value: 0, amp: 0 };
      // settle into the pose (the limbs ease into it over a few steps)
      for (let i = 0; i < 30; i++) c.updateScripted(1 / 30, pose, world);
      this.bodies.push(c);
      this.group.add(c.rig.root);
      c.rig.root.updateMatrixWorld(true);
      rocks.addStatic(footprintOf(c.rig.root, 0.3));
      // dried blood pooled under it, darker in the middle
      for (const [r, dx, dz, k] of [
        [0.36, 0.05, 0.1, 0],
        [0.2, 0.36, -0.2, 1],
        [0.14, -0.38, 0.32, 2],
        [0.08, 0.6, 0.45, 3],
      ]) {
        const g = new CylinderGeometry(r, r * 1.1, 0.01, 9);
        const pool = new Mesh(g, blood);
        const px = x + along.x * dx + out.x * dz;
        const pz = z + along.z * dx + out.z * dz;
        pool.position.set(px, terrainHeight(px, pz) + 0.008 + k * 0.001, pz);
        pool.scale.set(1.3, 1, 0.9);
        pool.rotation.y = yaw + k;
        this.group.add(pool);
      }
    }
    this.lookPoint.set(row.x + out.x, terrainHeight(row.x, row.z) + 0.4, row.z + out.z);
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }
}
