import { BoxGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, Object3D, Vector3, type Material } from 'three';
import { Creature, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import type { FootPose, HandPose, ScriptPose } from '../character/scriptPose';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { bakeStatic } from '../render/bake';
import { terrainHeight } from '../world/terrain';
import { footprintOf, type Rocks } from '../world/rocks';
import type { Dust } from '../world/particles';

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({
  x,
  z,
  lift,
  tilt,
  pitch,
  poleDown,
});

/** Husky green. Its eye is open, gone dull. */
const GREEN: Skin = {
  fur: [0x3c4a33, 0x5a6e4a, 0x748a60],
  belly: [0x7c8e68, 0xa0b48a, 0xb8c8a0],
  hoof: [0x232c1e, 0x3c4a33],
  eye: 0x8c949a,
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

/** Dead still. Their hands were tied behind them, so the arms go back. */
const DEAD = { tremble: 0, exertion: 0, armPitch: 0.5, elbow: -0.5, armOut: 0.12 };

/**
 * Thrown back onto the ground by the shot, lying on its bound hands, legs
 * splayed, head rolled to one side, its one eye open.
 */
const SPRAWLED: ScriptPose = {
  ...DEAD,
  eyeOpen: 0.55,
  pelvisX: 0,
  pelvisY: 0.13,
  pelvisZ: 0,
  pelvisPitch: -1.42,
  pelvisYaw: 0.18,
  pelvisRoll: 0,
  spinePitch: 0.06,
  chestPitch: 0.04,
  chestRoll: 0.05,
  neckPitch: -0.12,
  headPitch: -0.1,
  headYaw: 1.05,
  headRoll: 0.15,
  handL: hand(0.1, 0.03, -0.12),
  handR: hand(-0.08, 0.03, -0.1),
  footL: foot(0.36, 0.64, 0, 0.3, 0, -1),
  footR: foot(-0.3, 0.52, 0.02, 0.25, 0.3, -0.6),
};

/** Slid down the wall to sit against it, hands caught behind, head fallen forward and aside. */
const SLUMPED: ScriptPose = {
  ...DEAD,
  eyeOpen: 0,
  pelvisX: 0,
  pelvisY: 0.2,
  pelvisZ: 0,
  pelvisPitch: -0.7,
  pelvisYaw: -0.08,
  pelvisRoll: 0,
  spinePitch: 0.28,
  chestPitch: 0.22,
  chestRoll: -0.1,
  neckPitch: 0.6,
  headPitch: 0.55,
  headYaw: -0.3,
  headRoll: -0.5,
  handL: hand(0.08, 0.16, -0.22),
  handR: hand(-0.08, 0.16, -0.22),
  footL: foot(0.22, 0.58, 0, 0.3, 0, -1),
  footR: foot(-0.08, 0.4, 0.08, 0.4, 0.4, -0.3),
};

/** Pitched forward onto its face, bound hands on the small of its back, head turned aside. */
const FACEDOWN: ScriptPose = {
  ...DEAD,
  eyeOpen: 0,
  pelvisX: 0,
  pelvisY: 0.13,
  pelvisZ: 0,
  pelvisPitch: 1.46,
  pelvisYaw: -0.12,
  pelvisRoll: 0,
  spinePitch: 0.05,
  chestPitch: 0.05,
  chestRoll: 0.05,
  neckPitch: -0.15,
  headPitch: -0.25,
  headYaw: -1.05,
  headRoll: 0,
  handL: hand(0.07, 0.27, -0.04),
  handR: hand(-0.07, 0.27, -0.04),
  footL: foot(0.15, -0.62, 0, -1.4, -1.5, 1),
  footR: foot(-0.2, -0.56, 0.02, -1.3, -1.3, 1),
};

const SMOKE = rgb(0x5a524c).toArray();
const SMOKE_FADE = rgb(0xa89f96).toArray();

/**
 * Three of the creature's kind, lined up against the station's wall and shot:
 * one husky green, one husky blue, one a husky rust like the creature itself
 * but redder. Their hands were tied behind them, and two were blindfolded.
 * One was thrown back onto the ground, one slid down the wall to sit against
 * it, one pitched forward onto its face. Each has charred laser wounds, one
 * still smouldering, faintly smoking. Grey-blue blood has dried in pools under
 * them and spattered the wall behind (see world/station.ts), and a little
 * sand has drifted against them.
 */
export class Fallen {
  readonly group = new Group();
  /** The middle of the row, for the creature to look at. */
  readonly lookPoint = new Vector3();
  /** Where things feeding on them settle: on their heads, chests and hips, and at their blood (world space). */
  readonly feedPoints: Vector3[] = [];
  private readonly smokeFrom: Object3D[] = [];
  private smokeTimer = 0.5;

  constructor(
    private readonly world: World,
    private readonly row: Vector3,
    private readonly along: Vector3,
    private readonly out: Vector3,
    private readonly rocks: Rocks,
    private readonly dust: Dust,
    private readonly snap: (p: Vector3, o: Vector3) => Vector3,
  ) {
    this.lookPoint.set(row.x + out.x, terrainHeight(row.x, row.z) + 0.4, row.z + out.z);
  }

  /** Lay them out one at a time (see core/builder.ts), then merge them into a few meshes. */
  *build(): Generator<unknown, void, unknown> {
    const { row, along, out } = this;
    const yaw = Math.atan2(out.x, out.z);
    const blood = toonMaterial({ dark: 0x1e2630, mid: 0x28323e, light: 0x34414f, litAt: 0.6, outline: 0, highlight: 0 });
    const cloth = toonMaterial({ dark: 0x2a2422, mid: 0x3e3532, light: 0x564a44, litAt: 0.55, outline: 0.5, highlight: 0.4 });
    const cord = toonMaterial({ dark: 0x4a3a28, mid: 0x6e5838, light: 0x8e7650, litAt: 0.55, outline: 0.4, highlight: 0.3 });
    const charred = toonMaterial({ dark: 0x141010, mid: 0x221a18, light: 0x2e2420, litAt: 0.6, outline: 0, highlight: 0 });
    const ember = toonMaterial({ dark: 0x6a1a0e, mid: 0x6a1a0e, light: 0x6a1a0e, unlit: true, outline: 0 });
    const sand = toonMaterial({ dark: 0xbca872, mid: 0xd7bf86, light: 0xe8d39a, litAt: 0.55, outline: 0, highlight: 0 });
    const set: [Skin, ScriptPose, number, number, boolean, [number, number][], boolean][] = [
      // skin, pose, along the wall, out from it, blindfolded, wounds (x, y on the chest's face), front or back
      [GREEN, SPRAWLED, -1.5, 1.05, false, [[0.06, 0.18], [-0.08, 0.08]], true],
      [BLUE, SLUMPED, 0, 0.42, true, [[-0.05, 0.2], [0.07, 0.1], [0.0, 0.03]], true],
      [RUST, FACEDOWN, 1.45, 0.62, true, [[0.05, 0.16], [-0.06, 0.06]], false],
    ];
    for (const [skin, pose, s, o, blind, wounds, front] of set) {
      const x = row.x + along.x * s + out.x * o;
      const z = row.z + along.z * s + out.z * o;
      const c = new Creature(this.world, x, z, skin);
      c.setYaw(yaw);
      c.pos.set(x, terrainHeight(x, z), z);
      c.snap = this.snap;
      c.scriptBreath = { value: 0, amp: 0 };
      // settle into the pose (the limbs ease into it over a few steps)
      for (let i = 0; i < 30; i++) c.updateScripted(1 / 30, pose, this.world);
      const rig = c.rig;
      // the blindfold: a band of cloth round the eyes, its knot and two loose ends behind
      if (blind) {
        this.part(rig.head, new BoxGeometry(0.47, 0.07, 0.25), cloth, 0, 0.11, 0.005);
        this.part(rig.head, new BoxGeometry(0.08, 0.06, 0.05), cloth, 0, 0.11, -0.135);
        const tail = this.part(rig.head, new BoxGeometry(0.04, 0.14, 0.02), cloth, 0.03, 0.05, -0.15);
        tail.rotation.z = 0.3;
      }
      // laser wounds: charred holes through the fur, each with a dull ember at its heart
      const zf = front ? 0.125 : -0.125;
      wounds.forEach(([wx, wy], k) => {
        const burn = this.part(rig.chest, new CylinderGeometry(0.045, 0.05, 0.012, 6).rotateX(Math.PI / 2), charred, wx, 0.15 + wy - 0.12, zf);
        burn.rotation.z = k;
        this.part(rig.chest, new BoxGeometry(0.022, 0.022, 0.014), ember, wx, 0.15 + wy - 0.12, zf * 1.04);
        if (k === 0) {
          const o = new Object3D();
          o.position.set(wx, 0.15 + wy - 0.12, zf * 1.1);
          rig.chest.add(o);
          this.smokeFrom.push(o);
        }
      });
      rig.root.updateMatrixWorld(true);
      for (const part of [rig.head, rig.chest, rig.pelvis]) {
        const p = part.getWorldPosition(new Vector3());
        p.y += 0.1;
        this.feedPoints.push(p);
      }
      // the cord binding the wrists, pulled between the two hands
      const a = rig.arms[0].hand.getWorldPosition(new Vector3());
      const b = rig.arms[1].hand.getWorldPosition(new Vector3());
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const knot = new Mesh(new BoxGeometry(len + 0.08, 0.035, 0.11), cord);
      knot.position.copy(mid);
      knot.lookAt(b);
      knot.rotateY(Math.PI / 2);
      this.group.add(knot);
      this.group.add(rig.root);
      this.rocks.addStatic(footprintOf(rig.root, 0.3));
      // dried blood pooled under it, darker in the middle, and drips leading off
      for (const [r, dx, dz, k] of [
        [0.34, 0.05, 0.1, 0],
        [0.2, 0.34, -0.22, 1],
        [0.13, -0.36, 0.32, 2],
        [0.07, 0.6, 0.48, 3],
        [0.05, 0.74, 0.62, 4],
      ]) {
        const px = x + along.x * dx + out.x * dz;
        const pz = z + along.z * dx + out.z * dz;
        const pool = new Mesh(new CylinderGeometry(r, r * 1.1, 0.01, 7), blood);
        pool.position.set(px, terrainHeight(px, pz) + 0.008 + k * 0.001, pz);
        if (k < 2) this.feedPoints.push(pool.position.clone().setY(pool.position.y + 0.005));
        pool.scale.set(1.35, 1, 0.85);
        pool.rotation.y = yaw + k * 1.3;
        this.group.add(pool);
      }
      // sand drifted against it on the windward side
      const sx = x - along.x * 0.35 + out.x * 0.15;
      const sz = z - along.z * 0.35 + out.z * 0.15;
      const drift = new Mesh(new IcosahedronGeometry(0.22, 1), sand);
      drift.position.set(sx, terrainHeight(sx, sz) - 0.08, sz);
      drift.scale.set(1.6, 0.4, 0.9);
      drift.rotation.y = yaw;
      drift.layers.enable(SHADOW_LAYER);
      this.group.add(drift);
      yield;
    }
    bakeStatic(this.group, this.smokeFrom);
  }

  private part(parent: Object3D, geo: BoxGeometry | CylinderGeometry, mat: Material, x: number, y: number, z: number) {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }

  /** A thin thread of smoke rises now and then from the freshest wounds. */
  update(dt: number, listener: Vector3) {
    if (!this.smokeFrom.length || Math.hypot(listener.x - this.row.x, listener.z - this.row.z) > 30) return;
    this.smokeTimer -= dt;
    if (this.smokeTimer > 0) return;
    this.smokeTimer = 0.35 + Math.random() * 0.6;
    const o = this.smokeFrom[Math.floor(Math.random() * this.smokeFrom.length)];
    const p = o.getWorldPosition(new Vector3());
    this.dust.spawn(p.x, p.y + 0.02, p.z, (Math.random() - 0.5) * 0.05, 0.18 + Math.random() * 0.1, (Math.random() - 0.5) * 0.05, 2 + Math.random(), SMOKE, 1, {
      g: -0.12,
      drag: 1.2,
      windK: 0.35,
      c2: SMOKE_FADE,
      soft: true,
    });
  }
}
