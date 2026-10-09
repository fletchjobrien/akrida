import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, Matrix4, Mesh, Object3D, Vector3, type Material } from 'three';
import { rng } from '../core/math';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { SITE2 } from './crater';
import { terrainHeight } from './terrain';
import { footprintOf, type Rocks } from './rocks';

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/**
 * The second escape pod: an angular, gunmetal-blue craft of a different make,
 * lying on its side at the end of a short furrow with sand heaped against its
 * nose. Its hatch was torn off and thrown clear. It is cold and dead.
 */
export class LostPod {
  readonly group = new Group();
  /** Where someone climbing out of the hatch would land on the sand. */
  readonly hatchGround = new Vector3();
  readonly center = new Vector3();

  constructor(rocks: Rocks) {
    const hull = toonMaterial({ dark: 0x3b434e, mid: 0x5f6a77, light: 0x949fab, litAt: 0.55, outline: 0.6, highlight: 1 });
    const band = toonMaterial({ dark: 0x2c4f69, mid: 0x4a7fa6, light: 0x79acd0, litAt: 0.55, outline: 0.6, highlight: 0.8 });
    const metal = toonMaterial({ dark: 0x23262c, mid: 0x3a3e46, light: 0x5c616a, litAt: 0.55, outline: 0.6, highlight: 0.8 });
    const charred = toonMaterial({ dark: 0x24221f, mid: 0x3a3631, light: 0x5a534a, litAt: 0.55, outline: 0.6, highlight: 0.5 });
    const glass = toonMaterial({ dark: 0x0e131a, mid: 0x1b2633, light: 0x5d7d94, litAt: 0.45, outline: 0.6, highlight: 1 });
    const hole = toonMaterial({ dark: 0x0b0d10, mid: 0x0b0d10, light: 0x0b0d10, unlit: true, outline: 0.6 });

    const add = (parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number) => {
      const m = new Mesh(faceted(geo), mat);
      m.position.set(x, y, z);
      m.layers.enable(SHADOW_LAYER);
      parent.add(m);
      return m;
    };

    // ---- built along local +Y (nose at +Y); a six-sided hull with a flat face on +X for the hatch
    const P = new Group();
    add(P, new CylinderGeometry(0.5, 0.5, 1.5, 6), hull, 0, 0, 0);
    add(P, new CylinderGeometry(0.17, 0.5, 0.55, 6), hull, 0, 1.025, 0); // nose
    add(P, new CylinderGeometry(0.17, 0.17, 0.04, 6), metal, 0, 1.31, 0);
    add(P, new CylinderGeometry(0.47, 0.41, 0.24, 6), charred, 0, -0.87, 0); // engine block
    add(P, new CylinderGeometry(0.15, 0.25, 0.26, 8), metal, 0, -1.11, 0); // nozzle
    add(P, new CylinderGeometry(0.513, 0.513, 0.13, 6, 1, true), band, 0, 0.47, 0); // markings
    add(P, new CylinderGeometry(0.513, 0.513, 0.05, 6, 1, true), band, 0, -0.55, 0);
    add(P, new BoxGeometry(0.07, 0.7, 0.42), hole, 0.42, -0.05, 0); // the open hatchway
    add(P, new BoxGeometry(0.05, 0.05, 0.5), band, 0.445, 0.33, 0); // its frame
    add(P, new BoxGeometry(0.05, 0.05, 0.5), band, 0.445, -0.43, 0);
    add(P, new BoxGeometry(0.05, 0.12, 0.3), glass, 0.44, 0.75, 0); // a slit viewport
    // stubby fins at the tail, one snapped short
    add(P, new BoxGeometry(0.05, 0.42, 0.3), hull, 0, -0.78, 0.58);
    add(P, new BoxGeometry(0.05, 0.16, 0.18), charred, 0, -0.86, -0.52);
    // a torn hinge where the hatch used to hang
    const hingeL = add(P, new BoxGeometry(0.06, 0.08, 0.05), metal, 0.45, 0.2, 0.25);
    hingeL.rotation.x = 0.5;

    // it lies on its side, nose a little down into the sand it ploughed up, hatch facing the sky
    const axis = new Vector3(SITE2.dx, -0.1, SITE2.dz).normalize();
    const want = new Vector3(0, 1, 0.45).normalize();
    const up = want.clone().addScaledVector(axis, -want.dot(axis)).normalize();
    const side = new Vector3().crossVectors(up, axis);
    P.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(up, axis, side));
    P.position.set(SITE2.x, terrainHeight(SITE2.x, SITE2.z) + 0.3, SITE2.z);
    P.scale.setScalar(1.05);
    this.group.add(P);
    this.center.copy(P.position);

    // below the hatch, on the side that faces the camera
    const out = side.clone().setY(0);
    if (out.z < 0) out.multiplyScalar(-1);
    out.normalize();
    this.hatchGround.set(SITE2.x + out.x * 0.85, 0, SITE2.z + out.z * 0.85);
    this.hatchGround.y = terrainHeight(this.hatchGround.x, this.hatchGround.z);

    // the hatch, wrenched off and flung clear, half buried
    const rand = rng(4471);
    const hatch = new Group();
    add(hatch, new BoxGeometry(0.05, 0.72, 0.44), hull, 0, 0, 0);
    add(hatch, new BoxGeometry(0.055, 0.1, 0.44), band, 0, 0.22, 0);
    add(hatch, new BoxGeometry(0.06, 0.07, 0.07), metal, 0, -0.3, 0.2);
    const ha = Math.atan2(SITE2.dz, SITE2.dx) + 0.9;
    const hx = SITE2.x + Math.cos(ha) * 2.6;
    const hz = SITE2.z + Math.sin(ha) * 2.6;
    hatch.position.set(hx, terrainHeight(hx, hz) + 0.01, hz);
    hatch.rotation.set(Math.PI / 2 - 0.12, rand() * Math.PI * 2, 0.15, 'YXZ');
    this.group.add(hatch);

    // a few scraps where it first touched down
    for (let i = 0; i < 7; i++) {
      const t = 0.15 + rand() * 0.6;
      const s = (rand() - 0.5) * 1.6;
      const x = SITE2.x - SITE2.dx * 6.5 * (1 - t) - SITE2.dz * s;
      const z = SITE2.z - SITE2.dz * 6.5 * (1 - t) + SITE2.dx * s;
      const m = add(
        this.group,
        new BoxGeometry(0.16 + rand() * 0.25, 0.035, 0.1 + rand() * 0.2),
        [hull, band, metal, charred][i % 4],
        x,
        terrainHeight(x, z) - 0.01,
        z,
      );
      m.rotation.set((rand() - 0.5) * 0.6, rand() * Math.PI * 2, (rand() - 0.5) * 0.6);
    }

    this.group.updateMatrixWorld(true);
    rocks.addStatic(footprintOf(P, 1.0));
  }
}
