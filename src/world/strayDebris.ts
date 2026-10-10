import { BoxGeometry, BufferGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, type Material } from 'three';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { terrainHeight } from './terrain';
import { footprintOf, type Rocks } from './rocks';

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/**
 * A stray piece of the pod, flung far ahead of the crash: a curved scrap of
 * hull with a strip of its orange band and a charred, torn edge, half buried
 * and tipped up in the sand, with a bolt and a splinter of glass nearby. A
 * first hint, a few steps from where the creature wakes, of what lies ahead.
 */
export function strayDebris(x: number, z: number, yaw: number, rocks: Rocks) {
  const hull = toonMaterial({ dark: 0x6f6a62, mid: 0xa8a294, light: 0xdcd6c8, litAt: 0.55, outline: 0.6, highlight: 1 });
  const accent = toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0.6, highlight: 0.8 });
  const charred = toonMaterial({ dark: 0x2b2424, mid: 0x463c38, light: 0x6a5d55, litAt: 0.55, outline: 0.6, highlight: 0.6 });
  const metal = toonMaterial({ dark: 0x2e2a2a, mid: 0x4a4542, light: 0x6e6862, litAt: 0.55, outline: 0.6, highlight: 0.8 });
  const glass = toonMaterial({ dark: 0x10141c, mid: 0x1e2a38, light: 0x47677c, litAt: 0.5, outline: 0.6, highlight: 1 });
  const group = new Group();
  const add = (parent: Group, geo: BufferGeometry, mat: Material, px: number, py: number, pz: number) => {
    const m = new Mesh(faceted(geo), mat);
    m.position.set(px, py, pz);
    m.layers.enable(SHADOW_LAYER);
    parent.add(m);
    return m;
  };

  // the scrap: a curved strip of the pod's shell, its band across it, torn at one end.
  // Built round the shell's axis, then shifted so the middle of the curve is the origin.
  const scrap = new Group();
  const inner = new Group();
  const arc = 0.85;
  const R = 0.62;
  add(inner, new CylinderGeometry(R, R, 0.42, 7, 1, true, 0, arc), hull, 0, 0, 0);
  add(inner, new CylinderGeometry(R + 0.006, R + 0.006, 0.09, 7, 1, true, 0, arc), accent, 0, 0.06, 0);
  // the torn edge, blackened, and a bent rib behind it
  const torn = add(inner, new BoxGeometry(0.05, 0.44, 0.1), charred, Math.sin(arc) * R, 0, Math.cos(arc) * R);
  torn.rotation.y = arc;
  add(inner, new CylinderGeometry(R - 0.035, R - 0.035, 0.04, 7, 1, true, 0.05, arc - 0.1), metal, 0, -0.17, 0);
  inner.rotation.y = -arc / 2;
  inner.position.set(0, 0, -R);
  scrap.add(inner);
  // lying in the sand, the outside of its curve turned up to the sky and tipped
  // over, one end dug in
  scrap.rotation.set(-1.15, yaw, 0.3, 'YXZ');
  scrap.position.set(0, 0.03, 0);
  scrap.scale.setScalar(0.85);
  group.add(scrap);

  // a bolt and a splinter of glass thrown a little further
  const bolt = add(group, new IcosahedronGeometry(0.05, 0), metal, 0.5, 0.01, -0.25);
  bolt.scale.set(1, 0.6, 1.4);
  const shard = add(group, new BoxGeometry(0.09, 0.02, 0.05), glass, -0.7, 0.01, 0.42);
  shard.rotation.set(0.2, 0.7, 0.1);
  // a little sand drifted against its lee side
  const drift = add(group, new IcosahedronGeometry(0.28, 1), toonMaterial({ dark: 0xbca872, mid: 0xd7bf86, light: 0xe8d39a, litAt: 0.55, outline: 0, highlight: 0 }), -0.35, -0.2, 0.32);
  drift.scale.set(1.5, 0.45, 0.9);

  group.position.set(x, terrainHeight(x, z), z);
  group.updateMatrixWorld(true);
  rocks.addStatic(footprintOf(scrap, 0.3));
  return group;
}
