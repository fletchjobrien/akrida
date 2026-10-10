import { BoxGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, Object3D, Vector3, type BufferGeometry } from 'three';
import { Creature, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import type { FootPose, HandPose, ScriptPose } from '../character/scriptPose';
import { toonMaterial } from '../render/shared';
import { PALETTE, rgb } from '../render/palette';
import { terrainHeight } from '../world/terrain';
import type { Station } from '../world/station';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';

const hand = (x: number, y: number, z: number, ik = 1): HandPose => ({ x, y, z, ik });
const foot = (x: number, z: number, lift: number, tilt: number, pitch: number, poleDown: number): FootPose => ({ x, z, lift, tilt, pitch, poleDown });

/** Bleached and raw: what the tank left of one of the creature's kind. */
const SKIN: Skin = {
  fur: [0x6a5e58, 0x908480, 0xb4aaa2],
  belly: [0x845e5a, 0xa47c76, 0xc49c94],
  hoof: [0x3a302c, 0x5a4a44],
  eye: 0xd8dccc,
};

/** Curled on the tank's floor, on its side, knees drawn up, hands at its face. */
const CURLED: ScriptPose = {
  tremble: 0.35,
  exertion: 0.4,
  eyeOpen: 0.15,
  pelvisX: 0,
  pelvisY: 0.14,
  pelvisZ: 0,
  pelvisPitch: 1.3,
  pelvisYaw: 1.25,
  pelvisRoll: 0,
  spinePitch: 0.55,
  chestPitch: 0.45,
  chestRoll: 0,
  neckPitch: 0.55,
  headPitch: 0.45,
  headYaw: 0.2,
  headRoll: 0.3,
  handL: hand(0.08, 0.1, 0.32),
  handR: hand(-0.04, 0.08, 0.28),
  armPitch: -0.8,
  elbow: -1.6,
  armOut: 0.2,
  footL: foot(0.12, 0.1, 0.06, 0.5, 0.9, -1),
  footR: foot(-0.08, 0.04, 0.1, 0.4, 0.9, -1),
};

/** Dragging itself on its belly: the left arm reaching far ahead, the bad right arm under it. */
const REACH_L: ScriptPose = {
  tremble: 0.6,
  exertion: 0.95,
  eyeOpen: 0.7,
  pelvisX: 0,
  pelvisY: 0.15,
  pelvisZ: 0,
  pelvisPitch: 1.28,
  pelvisYaw: 0,
  pelvisRoll: 0.12,
  spinePitch: -0.18,
  chestPitch: -0.28,
  chestRoll: 0.12,
  neckPitch: -0.55,
  headPitch: -0.3,
  headYaw: 0.25,
  headRoll: 0.2,
  handL: hand(0.22, 0.02, 0.62),
  handR: hand(-0.16, 0.03, 0.2),
  armPitch: 0,
  elbow: -0.3,
  armOut: 0.2,
  footL: foot(0.2, -0.56, 0, -1.3, -1.4, 1),
  footR: foot(-0.1, -0.64, 0.02, -1.2, -1.1, 1),
};

/** The pull: the body hauled up to the planted hand, the weak arm pawing ahead. */
const REACH_R: ScriptPose = {
  ...REACH_L,
  pelvisRoll: -0.1,
  chestRoll: -0.14,
  headYaw: -0.2,
  headRoll: -0.15,
  pelvisY: 0.17,
  handL: hand(0.16, 0.03, 0.22),
  handR: hand(-0.2, 0.04, 0.42),
  footL: foot(0.14, -0.6, 0.02, -1.2, -1.2, 1),
  footR: foot(-0.18, -0.55, 0, -1.3, -1.4, 1),
};

/** Spent, on the sand: lower, shaking harder, the head hanging. */
const SPENT: ScriptPose = {
  ...REACH_L,
  tremble: 0.9,
  pelvisY: 0.13,
  pelvisPitch: 1.38,
  chestPitch: -0.12,
  neckPitch: -0.25,
  headPitch: 0.1,
  eyeOpen: 0.45,
};

type Numeric = { [k: string]: number | Numeric };
function blend(out: Numeric, a: Numeric, b: Numeric, t: number) {
  for (const k of Object.keys(a)) {
    const av = a[k];
    const bv = b[k];
    if (typeof av === 'number') out[k] = av + ((bv as number) - av) * t;
    else {
      if (typeof out[k] !== 'object') out[k] = {};
      blend(out[k] as Numeric, av, bv as Numeric, t);
    }
  }
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const C = (hex: number) => rgb(hex).toArray();
const FLUID = C(0x4ab8ac);
const FLUID_FADE = C(0x2a6a64);
const STEAM = C(0xe8f0ee);
const STEAM_FADE = C(0xa8b4b2);
const SAND = C(PALETTE.sandMid);
const SAND_FADE = C(PALETTE.sandLit);
const BUBBLE = C(0x9af0e8);

type Phase = 'tank' | 'drain' | 'settle' | 'door' | 'wake' | 'crawl' | 'outside' | 'dead';

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/** How big it is beside the creature. */
const SCALE = 0.58;

/**
 * The thing in the tank, let out. When the three cards are in, the reader
 * chimes, a relay clunks and pumps start: the tank drains with a deep gurgle,
 * the figure sinking with the fluid to lie on the tank's floor. It gasps. The
 * door hisses round in a burst of steam. It uncurls, shaking, and drags itself
 * out on its one good arm, the withered one pawing uselessly, mewling and
 * gasping, dripping and leaving a wet trail over the deck. It follows the cord
 * back through the tube, through the habitat and out of the airlock, tumbles
 * down the steps, and hauls itself on across the sand, ploughing a furrow,
 * until the drone finds it.
 *
 * It is one of the creature's own kind, bleached and stunted by the tank: an
 * oversized head, a withered arm, growths on its back, a feeding tube still
 * hanging from it.
 */
export class Specimen {
  phase: Phase = 'tank';
  t = 0;
  /** Seconds it has been out on the sand. */
  outside = 0;
  creature: Creature | null = null;
  readonly group = new Group();
  private readonly holder = new Group();
  private readonly world: World;
  private path: Vector3[] = [];
  private seg = 0;
  private cycle = 0;
  private voiceTimer = 0.4;
  private trailAt = new Vector3();
  private readonly pose: ScriptPose = JSON.parse(JSON.stringify(CURLED));
  private readonly tmp = new Vector3();
  private readonly marks: Mesh[] = [];
  private readonly wetMat = toonMaterial({ dark: 0x1a3432, mid: 0x24484a, light: 0x2e5a58, litAt: 0.6, outline: 0, highlight: 0 });
  private readonly furrowMat = toonMaterial({ dark: PALETTE.sandDeep, mid: PALETTE.sandShade, light: PALETTE.sandMid, litAt: 0.6, outline: 0, highlight: 0 });

  constructor(
    private readonly station: Station,
    base: World,
    private readonly audio: AudioEngine,
    private readonly dust: Dust,
  ) {
    const interior = station.interior;
    const I = interior.root;
    this.world = {
      ...base,
      rocks: [],
      cliffs: undefined,
      height: (x: number, z: number) => this.ground(x, z),
    };
    // its way out: from the tank, back along the cord, out of the airlock and on over the sand
    const local: [number, number][] = [
      [8.1, 0.1],
      [7.5, 0.28],
      [6.6, 0.2],
      [5.7, 0.2],
      [4.6, 0.35],
      [3.3, 0.2],
      [2.5, -0.1],
      [1.4, 0.55],
      [0.95, 1.15],
      [0.9, 1.8],
      [0.9, 2.55],
      [0.85, 3.3],
      [0.4, 4.3],
      [-0.4, 5.4],
      [-1.3, 6.6],
      [-2.2, 7.8],
    ];
    this.path = local.map(([x, z]) => I.localToWorld(new Vector3(x, 0, z)));
    this.group.add(this.holder);
    void interior;
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }

  get alive() {
    return this.phase !== 'dead' && this.phase !== 'tank';
  }

  get started() {
    return this.phase !== 'tank';
  }

  /** Where its chest is (for the drone). */
  chest(out: Vector3) {
    if (!this.creature) return out.copy(this.station.interior.tank.at);
    return this.creature.rig.chest.getWorldPosition(out);
  }

  /** The ground under it: the tank's floor, the deck, the airlock's threshold and steps, or the sand. */
  private ground(x: number, z: number) {
    const interior = this.station.interior;
    const tank = interior.tank.at;
    if (Math.hypot(x - tank.x, z - tank.z) < 0.44) return tank.y;
    const l = interior.root.worldToLocal(this.tmp.set(x, 0, z));
    const base = interior.root.localToWorld(new Vector3(0, 0, 0)).y;
    if (Math.abs(l.x - 0.9) < 0.6 && l.z > 1.4) {
      if (l.z < 2.36) return base + 0.85;
      if (l.z < 2.71) return base + 0.325;
      if (l.z < 3.01) return base + 0.155;
    }
    this.tmp.set(x, 0, z);
    if (interior.contains(this.tmp)) return interior.floorY;
    return terrainHeight(x, z);
  }

  /** The three cards are in: let it out. */
  begin() {
    if (this.phase !== 'tank') return;
    this.phase = 'drain';
    this.t = 0;
    this.audio.releaseChime(0.5);
    this.audio.tankDrain(0.5, 4.2);
  }

  /** The drone has it: its body is the strike's now. */
  kill() {
    this.phase = 'dead';
  }

  update(dt: number, time: number, listener: Vector3) {
    if (this.phase === 'tank') return;
    this.t += dt;
    const tank = this.station.interior.tank;
    const level = (d: number) => 1 / (1 + (d * d) / 16);
    if (this.phase === 'drain') {
      // the fluid sinks away, swirling, the figure sinking with it
      tank.level = 1 - smooth(0.3, 3.6, this.t);
      tank.liquid.visible = tank.level > 0.01;
      tank.liquid.scale.y = Math.max(0.001, 1.47 * tank.level);
      if (Math.random() < 0.7) {
        const a = time * 6 + Math.random();
        const r = 0.1 + Math.random() * 0.25;
        const y = tank.at.y + 0.05 + Math.random() * 1.4 * tank.level;
        this.dust.spawn(tank.at.x + Math.cos(a) * r, y, tank.at.z + Math.sin(a) * r, -Math.sin(a) * 0.4, -0.3, Math.cos(a) * 0.4, 0.5, BUBBLE, 1, { g: 1, drag: 1, windK: 0 });
      }
      if (this.t > 3.8) {
        this.phase = 'settle';
        this.t = 0;
        this.spawn();
        this.audio.specimenVoice('gasp', 0.5 * level(listener.distanceTo(tank.at)), 0);
      }
    } else if (this.phase === 'settle') {
      this.pose.tremble = 0.35 + Math.max(0, Math.sin(this.t * 3)) * 0.5;
      if (this.t > 1.4) {
        this.phase = 'door';
        this.t = 0;
        this.audio.tankHiss(0.5 * level(listener.distanceTo(tank.at)));
      }
    } else if (this.phase === 'door') {
      // the door slides round the tank in a gust of steam
      const k = smooth(0.15, 1.0, this.t);
      tank.doorPanel.rotation.y = k * (Math.PI / 2);
      if (this.t < 0.9) {
        for (let i = 0; i < 4; i++) {
          const up = Math.random() * 1.5;
          this.dust.spawn(tank.door.x, tank.door.y + up, tank.door.z, tank.out.x * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.3, tank.out.z * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 0.3, 1 + Math.random() * 0.8, STEAM, 2, {
            g: -0.4,
            drag: 1.6,
            windK: 0,
            c2: STEAM_FADE,
            soft: true,
          });
        }
      }
      if (this.t > 1.4) {
        this.phase = 'wake';
        this.t = 0;
      }
    } else if (this.phase === 'wake') {
      // uncurling: it rolls onto its belly, shaking, and lifts its head toward the way out
      blend(this.pose as unknown as Numeric, CURLED as unknown as Numeric, REACH_L as unknown as Numeric, smooth(0, 1.6, this.t));
      if (this.t > 1.7) {
        this.phase = 'crawl';
        this.t = 0;
        this.seg = 1;
      }
    } else if (this.phase === 'crawl' || this.phase === 'outside') {
      this.crawl(dt, listener);
    }
    if (this.creature && this.phase !== 'dead') {
      // it never stops making some sound: gasps, mewls, a wet rattle
      this.voiceTimer -= dt;
      if (this.voiceTimer <= 0 && this.phase !== 'drain') {
        this.voiceTimer = 0.9 + Math.random() * 1.6;
        const d = listener.distanceTo(this.creature.pos);
        const kinds = ['gasp', 'mewl', 'mewl', 'rattle'] as const;
        this.audio.specimenVoice(kinds[Math.floor(Math.random() * kinds.length)], 0.45 * level(d), this.pan(listener));
      }
      this.creature.scriptBreath = { value: Math.sin(time * 9) * 0.6, amp: 1.6 };
      this.creature.updateScripted(dt, this.pose, this.world);
    }
    this.sync();
  }

  private pan(listener: Vector3) {
    return this.creature ? Math.max(-0.8, Math.min(0.8, (this.creature.pos.x - listener.x) / 6)) : 0;
  }

  /** Dragging itself along: reach, plant, haul; slower and weaker once it is out on the sand. */
  private crawl(dt: number, listener: Vector3) {
    const c = this.creature!;
    const out = this.phase === 'outside';
    if (out) this.outside += dt;
    this.cycle += dt * (out ? 0.55 : 0.85);
    const ph = this.cycle % 1;
    const w = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
    blend(this.pose as unknown as Numeric, REACH_L as unknown as Numeric, REACH_R as unknown as Numeric, w);
    if (out) blend(this.pose as unknown as Numeric, this.pose as unknown as Numeric, SPENT as unknown as Numeric, Math.min(1, this.outside / 4) * 0.7);
    // it moves only while it hauls, in lurches
    const pull = Math.max(0, Math.sin(ph * Math.PI * 2 * 2));
    const speed = (out ? 1.0 : 2.2) * pull * (1 - Math.min(0.6, this.outside * 0.06));
    const target = this.path[Math.min(this.seg, this.path.length - 1)];
    const dx = target.x - c.pos.x;
    const dz = target.z - c.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.12 && this.seg < this.path.length - 1) this.seg++;
    if (d > 0.01) {
      const yaw = Math.atan2(dx, dz);
      let dy = yaw - c.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      c.setYaw(c.yaw + dy * Math.min(1, dt * 2.5));
      const step = Math.min(d, speed * dt);
      c.pos.x += Math.sin(c.yaw) * step;
      c.pos.z += Math.cos(c.yaw) * step;
    }
    // a scrape or a drag each time it hauls
    if (pull > 0.95 && this.lastPull <= 0.95) {
      const lv = 1 / (1 + listener.distanceToSquared(c.pos) / 16);
      this.audio.specimenDrag(0.35 * lv, this.pan(listener), !out);
    }
    this.lastPull = pull;
    // dripping, and the trail it leaves: wet on the deck, a furrow in the sand
    if (Math.random() < (out ? 0.15 : 0.5)) {
      this.dust.spawn(c.pos.x + (Math.random() - 0.5) * 0.15, c.pos.y + 0.1, c.pos.z + (Math.random() - 0.5) * 0.15, 0, -0.2, 0, 0.4, FLUID, 1, { g: 9, drag: 0.2, windK: 0, c2: FLUID_FADE });
    }
    if (c.pos.distanceTo(this.trailAt) > 0.14) {
      this.trailAt.copy(c.pos);
      const inside = this.station.interior.contains(c.pos);
      const g = this.ground(c.pos.x, c.pos.z);
      const m = new Mesh(new BoxGeometry(inside ? 0.16 : 0.2, 0.006, 0.18), inside || !out ? this.wetMat : this.furrowMat);
      m.position.set(c.pos.x + (Math.random() - 0.5) * 0.04, g + 0.006 + (this.marks.length % 7) * 0.0004, c.pos.z + (Math.random() - 0.5) * 0.04);
      m.rotation.y = c.yaw + (Math.random() - 0.5) * 0.3;
      this.group.add(m);
      this.marks.push(m);
      if (out) {
        this.dust.spawn(c.pos.x, g + 0.03, c.pos.z, (Math.random() - 0.5) * 0.4, 0.2, (Math.random() - 0.5) * 0.4, 0.5, SAND, 1, { g: 2, drag: 2, windK: 0.3, c2: SAND_FADE, soft: true });
      }
    }
    // out of the airlock and onto the sand
    if (!out && this.seg >= 11) {
      this.phase = 'outside';
      this.outside = 0;
    }
  }

  private lastPull = 0;

  /** Let go of the tank's figure; the creature itself lies curled on the tank's floor. */
  private spawn() {
    const tank = this.station.interior.tank;
    tank.figure.visible = false;
    tank.floating = false;
    const c = new Creature(this.world, tank.at.x, tank.at.z, SKIN);
    c.snap = (_p, o) => o.set(0, 0, 0);
    c.setYaw(Math.atan2(tank.out.x, tank.out.z));
    c.pos.set(tank.at.x, tank.at.y, tank.at.z);
    c.scriptBreath = { value: 0, amp: 0 };
    const rig = c.rig;
    // what the tank did to it: a swollen head, a withered right arm, growths, a cut feeding tube
    rig.head.scale.setScalar(1.28);
    rig.arms[1].shoulder.scale.set(0.75, 0.62, 0.75);
    const raw = toonMaterial({ dark: 0x6a3a3a, mid: 0x945656, light: 0xb87a76, litAt: 0.5, outline: 0.5, highlight: 0.6 });
    const vein = toonMaterial({ dark: 0x2a1a26, mid: 0x3e2636, light: 0x543446, litAt: 0.5, outline: 0, highlight: 0 });
    const tube = toonMaterial({ dark: 0x4a5a58, mid: 0x7a8e8a, light: 0xa8bcb8, litAt: 0.5, outline: 0.4, highlight: 0.8 });
    const lump = (parent: Object3D, r: number, x: number, y: number, z: number) => {
      const m = new Mesh(faceted(new IcosahedronGeometry(r, 0)), raw);
      m.position.set(x, y, z);
      parent.add(m);
    };
    lump(rig.chest, 0.08, 0.05, 0.16, -0.11);
    lump(rig.chest, 0.05, -0.06, 0.08, -0.12);
    lump(rig.head, 0.05, -0.08, 0.14, -0.02);
    for (const [x, y, r] of [
      [0.04, 0.2, 0.4],
      [-0.05, 0.12, -0.6],
    ]) {
      const v = new Mesh(faceted(new BoxGeometry(0.012, 0.12, 0.012)), vein);
      v.position.set(x, y, 0.125);
      v.rotation.z = r;
      rig.chest.add(v);
    }
    const t = new Mesh(faceted(new CylinderGeometry(0.018, 0.018, 0.32, 5)), tube);
    t.position.set(0.0, 0.1, -0.16);
    t.rotation.x = 0.9;
    rig.chest.add(t);
    this.holder.add(rig.root);
    this.creature = c;
    blend(this.pose as unknown as Numeric, CURLED as unknown as Numeric, CURLED as unknown as Numeric, 0);
    for (let i = 0; i < 20; i++) c.updateScripted(1 / 30, this.pose, this.world);
    this.trailAt.copy(c.pos);
  }

  /** Shrink it about where it lies: the rig is posed full size, the holder makes it small. */
  private sync() {
    const c = this.creature;
    if (!c) return;
    this.holder.position.copy(c.pos);
    this.holder.scale.setScalar(SCALE);
    c.rig.root.position.copy(c.pos).multiplyScalar(-1);
  }

  /** Keep its body in step while something else (the strike) moves it. */
  follow() {
    this.sync();
  }
}
