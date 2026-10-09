import { BoxGeometry, Group, Matrix4, Mesh, Object3D, Vector3, type Material } from 'three';
import { toonMaterial } from '../render/shared';
import { PALETTE } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';

/** Leg segment lengths (world units). */
export const LEG = {
  hipWidth: 0.095,
  thigh: 0.25,
  shin: 0.26,
  cannon: 0.16,
  hoof: 0.05,
};

function addPart(parent: Object3D, mat: Material, w: number, h: number, d: number, x: number, y: number, z: number) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.layers.enable(SHADOW_LAYER);
  m.frustumCulled = false;
  parent.add(m);
  return m;
}

/** A limb piece hanging down its local -Y axis from its origin. */
export class Segment {
  readonly obj = new Object3D();
  constructor(parent: Object3D, mat: Material, readonly length: number, w: number, d: number) {
    addPart(this.obj, mat, w, length, d, 0, -length / 2, 0);
    parent.add(this.obj);
  }
}

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();

/** Place `obj` at `from` with its -Y axis pointing at `to`; `hint` picks the forward twist. */
export function orient(obj: Object3D, from: Vector3, to: Vector3, hint: Vector3) {
  _y.subVectors(from, to).normalize();
  _x.crossVectors(_y, hint);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(from);
}

export interface LegParts {
  thigh: Segment;
  shin: Segment;
  cannon: Segment;
  hoof: Object3D;
}

export interface ArmParts {
  shoulder: Object3D;
  elbow: Object3D;
  hand: Mesh;
}

/**
 * The horned, hoofed creature from the reference art, built from boxes. The
 * upper body is a bone hierarchy (FK); the legs live in world space (IK).
 */
export class CreatureRig {
  /** Root added to the scene. */
  readonly root = new Group();
  /** Upper body; positioned at the creature, rotated by its yaw, snapped to texels. */
  readonly body = new Group();
  /** Legs in world space. */
  readonly legsRoot = new Group();

  readonly pelvis = new Object3D();
  readonly spine = new Object3D();
  readonly chest = new Object3D();
  readonly neck = new Object3D();
  readonly head = new Object3D();
  readonly eye: Mesh;
  readonly chestMesh: Mesh;
  readonly arms: [ArmParts, ArmParts];
  readonly legs: [LegParts, LegParts];

  constructor() {
    const fur = toonMaterial({
      dark: PALETTE.furDark,
      mid: PALETTE.furMid,
      light: PALETTE.furLight,
      litAt: 0.6,
      midAt: 0.03,
      outline: 0,
      highlight: 0.2,
    });
    const belly = toonMaterial({
      dark: PALETTE.bellyDark,
      mid: PALETTE.bellyMid,
      light: PALETTE.bellyLight,
      litAt: 0.62,
      midAt: -0.2,
      outline: 0,
      highlight: 0,
    });
    const hoof = toonMaterial({
      dark: PALETTE.hoofDark,
      mid: PALETTE.hoofMid,
      light: PALETTE.furMid,
      litAt: 0.68,
      midAt: 0.03,
      outline: 0,
      highlight: 0,
    });
    const eye = toonMaterial({
      dark: PALETTE.eye,
      mid: PALETTE.eye,
      light: PALETTE.eye,
      unlit: true,
      outline: 0,
      highlight: 0,
    });

    this.root.add(this.body, this.legsRoot);
    this.body.add(this.pelvis);

    // pelvis and abdomen
    addPart(this.pelvis, fur, 0.3, 0.14, 0.2, 0, 0.0, 0);
    this.pelvis.add(this.spine);
    this.spine.position.set(0, 0.07, 0);
    addPart(this.spine, fur, 0.27, 0.2, 0.19, 0, 0.1, 0);
    addPart(this.spine, belly, 0.17, 0.11, 0.02, 0, 0.09, 0.1);

    // chest
    this.spine.add(this.chest);
    this.chest.position.set(0, 0.19, 0);
    this.chestMesh = addPart(this.chest, fur, 0.36, 0.3, 0.24, 0, 0.15, 0);
    addPart(this.chest, belly, 0.24, 0.18, 0.02, 0, 0.15, 0.125);

    // neck and head
    this.chest.add(this.neck);
    this.neck.position.set(0, 0.3, 0.0);
    addPart(this.neck, fur, 0.11, 0.1, 0.11, 0, 0.04, 0);
    this.neck.add(this.head);
    this.head.position.set(0, 0.08, 0.01);
    addPart(this.head, fur, 0.44, 0.19, 0.22, 0, 0.095, 0);
    this.eye = addPart(this.head, eye, 0.08, 0.08, 0.03, 0, 0.1, 0.113);
    const hornL = addPart(this.head, fur, 0.085, 0.15, 0.085, 0.175, 0.24, -0.01);
    hornL.rotation.z = -0.3;
    const hornR = addPart(this.head, fur, 0.085, 0.15, 0.085, -0.175, 0.24, -0.01);
    hornR.rotation.z = 0.3;

    // arms (index 0 = left (+x), 1 = right (-x))
    const makeArm = (side: number): ArmParts => {
      const shoulder = new Object3D();
      shoulder.position.set(0.225 * side, 0.26, 0);
      this.chest.add(shoulder);
      addPart(shoulder, hoof, 0.095, 0.24, 0.095, 0, -0.11, 0);
      const elbow = new Object3D();
      elbow.position.set(0, -0.22, 0);
      shoulder.add(elbow);
      addPart(elbow, hoof, 0.085, 0.2, 0.085, 0, -0.1, 0);
      const hand = addPart(elbow, hoof, 0.095, 0.08, 0.095, 0, -0.225, 0.005);
      return { shoulder, elbow, hand };
    };
    this.arms = [makeArm(1), makeArm(-1)];

    const makeLeg = (): LegParts => ({
      thigh: new Segment(this.legsRoot, fur, LEG.thigh, 0.15, 0.15),
      shin: new Segment(this.legsRoot, hoof, LEG.shin, 0.13, 0.13),
      cannon: new Segment(this.legsRoot, hoof, LEG.cannon, 0.1, 0.1),
      hoof: (() => {
        const o = new Object3D();
        addPart(o, hoof, 0.12, LEG.hoof, 0.14, 0, LEG.hoof / 2, 0.015);
        this.legsRoot.add(o);
        return o;
      })(),
    });
    this.legs = [makeLeg(), makeLeg()];
  }
}
