import { BufferAttribute, BufferGeometry, InstancedMesh, Matrix4, Mesh, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _m = new Matrix4();
const _inv = new Matrix4();

/** Swap the second and third corner of every triangle (for parts that were mirrored). */
function flipWinding(g: BufferGeometry) {
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name) as BufferAttribute;
    if (!a) continue;
    for (let i = 0; i + 2 < a.count; i += 3) {
      for (let c = 0; c < a.itemSize; c++) {
        const t = a.getComponent(i + 1, c);
        a.setComponent(i + 1, c, a.getComponent(i + 2, c));
        a.setComponent(i + 2, c, t);
      }
    }
  }
}

/**
 * Merge the static parts of a model into one mesh per material (and shadow
 * setting), so a wreck of hundreds of parts draws in a couple of dozen calls.
 * Parts in `keep` (and everything under them) are left alone: anything that
 * moves, swings, is pressed or is picked by the mouse.
 */
export function bakeStatic(root: Object3D, keep: Object3D[] = []) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const kept = new Set<Object3D>();
  for (const k of keep) k.traverse((o) => kept.add(o));
  const buckets = new Map<string, { mat: Material; mask: number; meshes: Mesh[] }>();
  root.traverse((o) => {
    if (!(o instanceof Mesh) || o instanceof InstancedMesh || kept.has(o) || !o.visible || Array.isArray(o.material)) return;
    const mat = o.material as Material;
    const key = `${mat.uuid}:${o.layers.mask}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { mat, mask: o.layers.mask, meshes: [] }));
    b.meshes.push(o);
  });
  for (const b of buckets.values()) {
    if (b.meshes.length < 2) continue;
    const geos: BufferGeometry[] = [];
    for (const m of b.meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      _m.multiplyMatrices(_inv, m.matrixWorld);
      g.applyMatrix4(_m);
      if (_m.determinant() < 0) flipWinding(g);
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new Mesh(merged, b.mat);
    mesh.layers.mask = b.mask;
    root.add(mesh);
    for (const m of b.meshes) m.parent?.remove(m);
  }
}
