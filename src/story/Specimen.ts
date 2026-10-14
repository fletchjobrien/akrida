import { BoxGeometry, CylinderGeometry, Group, Mesh, Object3D, Vector2, Vector3, type BufferGeometry, type Material } from 'three';
import { Creature, type CreatureInput, type World } from '../character/Creature';
import type { Skin } from '../character/rig';
import { blendPose, clonePose, type ScriptPose } from '../character/scriptPose';
import { toonMaterial } from '../render/shared';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { PALETTE, rgb } from '../render/palette';
import { terrainHeight } from '../world/terrain';
import { noise1 } from '../core/math';
import type { Station } from '../world/station';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';
import { BUCKLE, FOURS, HANDS_IN, KNEEL, LIMP, PUSH1, PUSH2, RISE, STAND, STEP_L, STEP_R, ease, hand, mk, type Ease } from './WakeUp';

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const rand = (a: number, b: number) => a + Math.random() * (b - a);

const C = (hex: number) => rgb(hex).toArray();
const FLUID = C(0x4ab8ac);
const FLUID_FADE = C(0x2a6a64);
const BILE = C(0x8a9a3a);
const BILE_FADE = C(0x4a5222);
const STEAM = C(0xe8f0ee);
const STEAM_FADE = C(0xa8b4b2);
const SAND = C(PALETTE.sandMid);
const SAND_FADE = C(PALETTE.sandLit);
const BUBBLE = C(0x9af0e8);
const BLOOD = C(0x26303c);
const BLOOD_FADE = C(0x1a2028);
const GORE = C(0x5a5652);
const SPARK = C(0xfff0c0);
const SPARK_COOL = C(0xe0702a);

type Phase = 'tank' | 'drain' | 'settle' | 'door' | 'wake' | 'walk' | 'outside' | 'dead';

/** What it is doing while it makes its way out. */
type Act = 'walk' | 'trip' | 'knees' | 'catch';

/** How big it is beside the creature: it is drawn at this scale, in a frame of its own. */
const S = 1;
/** Seconds out on the sand before the drone takes it. */
export const PREY_AFTER = 2;

/** Grey primer, the shell not yet finished (the finished parts get the creature's colours). */
const SKIN: Skin = {
  fur: [0x5e5a56, 0x86817a, 0xa9a39a],
  belly: [0x6a6660, 0x948e86, 0xb4ada2],
  hoof: [0x1e1e22, 0x34343a],
  eye: PALETTE.eye,
};

// ---------------------------------------------------------------------- poses

/** Hanging in the fluid: head bowed, arms adrift, knees folded under it. */
const FLOAT = mk(STAND, {
  pelvisY: 0.5,
  pelvisPitch: 0.35,
  spinePitch: 0.3,
  chestPitch: 0.3,
  neckPitch: 0.55,
  headPitch: 0.4,
  headYaw: 0.25,
  headRoll: 0.2,
  handL: hand(0.2, 0.42, 0.18, 0),
  handR: hand(-0.2, 0.42, 0.18, 0),
  armPitch: -0.35,
  elbow: -0.9,
  armOut: 0.25,
  footL: { x: 0.1, z: 0.12, lift: 0.08, tilt: 0.9, pitch: 1.0, poleDown: 0 },
  footR: { x: -0.1, z: 0.02, lift: 0.14, tilt: 1.1, pitch: 1.2, poleDown: 0 },
  eyeOpen: 0.15,
  tremble: 0.1,
  exertion: 0.1,
});

/** Curled where the fluid left it, on the tank's floor. */
const HEAP = mk(LIMP, { eyeOpen: 0.4, tremble: 0.5, exertion: 0.8, headYaw: -0.6 });

/** Pitching forward, the hands thrown out too late. */
const FALLING = mk(STAND, {
  pelvisY: 0.45,
  pelvisZ: -0.1,
  pelvisPitch: 0.95,
  spinePitch: 0.1,
  chestPitch: 0.05,
  neckPitch: -0.3,
  headPitch: -0.2,
  handL: hand(0.26, 0.15, 0.5),
  handR: hand(-0.26, 0.1, 0.45),
  footL: { x: 0.1, z: -0.3, lift: 0.05, tilt: -0.4, pitch: -0.6, poleDown: 0.3 },
  footR: { x: -0.1, z: -0.15, lift: 0.0, tilt: -0.2, pitch: -0.3, poleDown: 0.2 },
  eyeOpen: 1,
  tremble: 0.6,
  exertion: 1,
});

/** On its face, twitching. */
const DOWN = mk(LIMP, { eyeOpen: 1, tremble: 0.9, exertion: 1, headYaw: 0.9, neckPitch: -0.45 });

/** Standing, swaying, barely: knees going, head hanging. */
const SWAY = mk(STAND, { pelvisY: 0.6, pelvisPitch: 0.3, neckPitch: 0.4, headPitch: 0.3, tremble: 1, exertion: 1, eyeOpen: 1 });

/** Stopped, bent over with its hands braced on its knees, dragging in air. */
const BRACE = mk(STAND, {
  pelvisY: 0.6,
  pelvisPitch: 0.62,
  spinePitch: 0.22,
  chestPitch: 0.18,
  neckPitch: 0.1,
  headPitch: 0.1,
  handL: hand(0.15, 0.4, 0.22),
  handR: hand(-0.15, 0.4, 0.22),
  footL: { x: 0.13, z: 0.04, lift: 0, tilt: 0.25, pitch: 0, poleDown: 0 },
  footR: { x: -0.13, z: -0.05, lift: 0, tilt: 0.25, pitch: 0, poleDown: 0 },
  tremble: 0.85,
  exertion: 1,
  eyeOpen: 1,
});

type Key = { t: number; pose: ScriptPose; ease: Ease };

/** Getting up off the tank's floor: it pushes up, the arms give, it pushes again, knees, and stands. */
const GET_UP: Key[] = [
  { t: 0, pose: HEAP, ease: 'linear' },
  { t: 0.45, pose: mk(HANDS_IN, { eyeOpen: 1 }), ease: 'inOut' },
  { t: 0.95, pose: PUSH1, ease: 'inOut' },
  { t: 1.2, pose: BUCKLE, ease: 'in' },
  { t: 1.75, pose: PUSH2, ease: 'inOut' },
  { t: 2.2, pose: FOURS, ease: 'inOut' },
  { t: 2.55, pose: STEP_L, ease: 'inOut' },
  { t: 2.9, pose: KNEEL, ease: 'out' },
  { t: 3.25, pose: STEP_R, ease: 'inOut' },
  { t: 3.65, pose: RISE, ease: 'inOut' },
  { t: 4.15, pose: SWAY, ease: 'inOut' },
];

/** Its legs go: it pitches onto its face, lies there twitching, and drags itself back up. */
const TRIP: Key[] = [
  { t: 0, pose: SWAY, ease: 'linear' },
  { t: 0.28, pose: FALLING, ease: 'in' },
  { t: 0.5, pose: DOWN, ease: 'in' },
  { t: 1.3, pose: DOWN, ease: 'linear' },
  { t: 1.7, pose: mk(HANDS_IN, { eyeOpen: 1, tremble: 1 }), ease: 'inOut' },
  { t: 2.15, pose: PUSH2, ease: 'inOut' },
  { t: 2.5, pose: FOURS, ease: 'inOut' },
  { t: 2.85, pose: KNEEL, ease: 'out' },
  { t: 3.2, pose: RISE, ease: 'inOut' },
  { t: 3.6, pose: SWAY, ease: 'inOut' },
];
/** How far (in its own frame) a fall carries it forward. */
const TRIP_LUNGE = 0.45;

/** Its legs give: it sinks to its knees, catches itself on its hands, hangs there, and gets up again. */
const KNEES: Key[] = [
  { t: 0, pose: SWAY, ease: 'linear' },
  { t: 0.3, pose: mk(KNEEL, { tremble: 1 }), ease: 'in' },
  { t: 0.6, pose: FOURS, ease: 'out' },
  { t: 1.6, pose: mk(FOURS, { neckPitch: 0.75, tremble: 1 }), ease: 'linear' },
  { t: 2.0, pose: STEP_L, ease: 'inOut' },
  { t: 2.4, pose: KNEEL, ease: 'out' },
  { t: 2.8, pose: RISE, ease: 'inOut' },
  { t: 3.2, pose: SWAY, ease: 'inOut' },
];

/** It stops, braces its hands on its knees and hangs its head, then pushes on. */
const CATCH: Key[] = [
  { t: 0, pose: SWAY, ease: 'linear' },
  { t: 0.35, pose: BRACE, ease: 'out' },
  { t: 1.4, pose: mk(BRACE, { neckPitch: 0.3 }), ease: 'linear' },
  { t: 1.8, pose: SWAY, ease: 'inOut' },
];

function sample(keys: Key[], t: number, out: ScriptPose) {
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[Math.min(i + 1, keys.length - 1)];
  const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
  return blendPose(out, a.pose, b.pose, ease(b.ease, u));
}

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

type Gib = { obj: Object3D; vel: Vector3; spin: Vector3; rest: boolean; bled: boolean; bleed: number; metal: boolean };

/**
 * The thing in the tank, let out. When the three cards are in, the reader
 * chimes, a relay clunks and pumps start: the tank drains with a deep gurgle,
 * and the figure in it sinks to lie in a heap on the tank's floor. The door
 * hisses round in a burst of steam. It gets up the way a newborn thing would,
 * in fits: pushing up, the arms giving, again, onto its knees, and up. Then it
 * stumbles out on legs it has never used, weaving and lurching to one side, its
 * knees going under it: it pitches onto its face and drags itself back up, it
 * sinks to its knees and hangs on its hands, it stops and braces its hands on
 * its knees. It follows the cord out through the habitat and the airlock, falls
 * down the steps, and staggers on over the sand until the drone finds it and it
 * comes apart.
 *
 * It is an Akridian, one of the creature's own kind, half built: the
 * scientists here were trying to make more of them, since their makers never
 * let them make their own. It stands as tall as the creature, in grey primer.
 * Its head is finished in the creature's colours, with one horn fitted and the
 * other a bare socket, and a side panel left off so its optics show, a lens
 * flickering in there. Its eye is still booting. Its chest is open on its frame
 * round a glowing core and bundled wiring; its left arm and left shin are bare
 * frame and actuators; the umbilical is plugged into its open spine.
 */
export class Specimen {
  phase: Phase = 'tank';
  t = 0;
  /** Seconds it has been out on the sand. */
  outside = 0;
  readonly group = new Group();
  /** Its own frame: at `origin`, scaled down; the creature's body lives in it. */
  private readonly holder = new Group();
  private readonly origin = new Vector3();
  private creature!: Creature;
  private readonly world: World;
  private readonly floatWorld: World = { height: () => 0, rocks: [] };
  private path: Vector3[] = [];
  private seg = 0;
  private act: Act = 'walk';
  private keys: Key[] | null = null;
  private keyT = 0;
  private keyRate = 1;
  private fitTimer = 3;
  private stagger = 0;
  private staggerSide = 1;
  private staggerWait = 2;
  private stepCool = 0;
  private lunge = 0;
  private voiceTimer = 1.2;
  private readonly pose: ScriptPose = clonePose(FLOAT);
  private readonly input: CreatureInput = { move: new Vector2(), sprint: false, crouch: false, look: null };
  private readonly look = new Vector3();
  private readonly tube: { p: Vector3; prev: Vector3; mesh: Mesh }[] = [];
  private navel!: Object3D;
  private optic!: Object3D;
  private eye: Mesh | null = null;
  private metalMeshes = new Set<Mesh>();
  private readonly gibs: Gib[] = [];
  private readonly marks: Mesh[] = [];
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();
  private twitch = { t: 0, neck: 0, head: 0, chest: 0, arm: 0, knee: 0 };
  private readonly wetMat = toonMaterial({ dark: 0x1a3432, mid: 0x24484a, light: 0x2e5a58, litAt: 0.6, outline: 0, highlight: 0 });
  private readonly printMat = toonMaterial({ dark: PALETTE.sandDeep, mid: PALETTE.sandShade, light: PALETTE.sandMid, litAt: 0.6, outline: 0, highlight: 0 });
  private readonly bloodMat = toonMaterial({ dark: 0x161c24, mid: 0x1e2630, light: 0x28323e, litAt: 0.6, outline: 0, highlight: 0.5 });
  private readonly bileMat = toonMaterial({ dark: 0x2e3412, mid: 0x46501c, light: 0x5e6a26, litAt: 0.6, outline: 0, highlight: 0.6 });
  private readonly M = {
    // unpainted primer over most of it; the creature's own colours where it was finished
    primer: toonMaterial({ dark: 0x5e5a56, mid: 0x86817a, light: 0xa9a39a, litAt: 0.55, outline: 0.6, highlight: 0.5 }),
    shell: toonMaterial({ dark: PALETTE.furDark, mid: PALETTE.furMid, light: PALETTE.furLight, litAt: 0.6, outline: 0, highlight: 0.3 }),
    belly: toonMaterial({ dark: PALETTE.bellyDark, mid: 0xa8808a, light: 0xc09aa0, litAt: 0.6, outline: 0, highlight: 0.2 }),
    frame: toonMaterial({ dark: 0x1a1a1e, mid: 0x2c2c32, light: 0x48484f, litAt: 0.5, outline: 0.7, highlight: 0.9 }),
    metal: toonMaterial({ dark: 0x34363c, mid: 0x5c6068, light: 0x9aa0a8, litAt: 0.5, outline: 0.7, highlight: 1 }),
    cavity: toonMaterial({ dark: 0x0c0b0d, mid: 0x141217, light: 0x1e1b22, litAt: 0.5, outline: 0, highlight: 0 }),
    wireR: toonMaterial({ dark: 0x5a1410, mid: 0x9a2a1e, light: 0xc4442e, litAt: 0.5, outline: 0, highlight: 0.3 }),
    wireB: toonMaterial({ dark: 0x14285a, mid: 0x2a4a9a, light: 0x4a6ac4, litAt: 0.5, outline: 0, highlight: 0.3 }),
    wireY: toonMaterial({ dark: 0x5a4a10, mid: 0x9a8418, light: 0xc4aa2e, litAt: 0.5, outline: 0, highlight: 0.3 }),
    mark: toonMaterial({ dark: 0x7a3a24, mid: 0xb85a34, light: 0xd9824a, litAt: 0.55, outline: 0, highlight: 0.4 }),
    optic: toonMaterial({ dark: 0x6ae8ff, mid: 0x6ae8ff, light: 0x6ae8ff, unlit: true, outline: 0 }),
    core: toonMaterial({ dark: 0x5ae8d8, mid: 0x5ae8d8, light: 0x5ae8d8, unlit: true, outline: 0 }),
    tube: toonMaterial({ dark: 0x1e1e22, mid: 0x34343a, light: 0x55555e, litAt: 0.5, outline: 0.4, highlight: 0.8 }),
  };


  constructor(
    private readonly station: Station,
    private readonly audio: AudioEngine,
    private readonly dust: Dust,
  ) {
    const I = station.interior.root;
    // its way out: from the tank, back along the cord, out of the airlock and a little way over the sand
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
      [-3.0, 9.0],
    ];
    this.path = local.map(([x, z]) => I.localToWorld(new Vector3(x, 0, z)));
    this.origin.copy(station.interior.tank.at);
    // the ground, in its own frame
    const O = this.origin;
    this.world = { height: (x: number, z: number) => (this.ground(O.x + x * S, O.z + z * S) - O.y) / S, rocks: [] };
    this.holder.scale.setScalar(S);
    this.reset();
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

  /** Where it stands, once it is out of the tank (null before, and once it is in pieces). */
  get at(): Vector3 | null {
    if (!this.alive) return null;
    return this.toWorld(this.creature.pos, this.tmp3);
  }

  /** Where its chest is (for the drone, and for looking at it). */
  chest(out: Vector3) {
    if (this.phase === 'tank' || this.phase === 'dead') {
      if (this.phase === 'dead') return out.copy(this.lastChest);
      return out.copy(this.station.interior.tank.at);
    }
    this.holder.updateMatrixWorld(true);
    return this.creature.rig.chest.getWorldPosition(out).add(this.tmp.set(0, 0.1, 0));
  }
  private readonly lastChest = new Vector3();

  private toWorld(v: Vector3, out: Vector3) {
    return out.set(this.origin.x + v.x * S, this.origin.y + v.y * S, this.origin.z + v.z * S);
  }

  private toLocal(w: Vector3, out: Vector3) {
    return out.set((w.x - this.origin.x) / S, (w.y - this.origin.y) / S, (w.z - this.origin.z) / S);
  }

  /** Back as it was: floating in a full tank behind a shut door, every trace of it gone. */
  reset() {
    for (const g of this.gibs) g.obj.removeFromParent();
    this.gibs.length = 0;
    for (const m of this.marks) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.marks.length = 0;
    for (const s of this.tube) s.mesh.removeFromParent();
    this.tube.length = 0;
    if (this.creature) this.creature.rig.root.removeFromParent();
    const tank = this.station.interior.tank;
    tank.level = 1;
    tank.liquid.visible = true;
    tank.liquid.scale.y = 1.47;
    tank.doorPanel.rotation.y = 0;
    tank.floating = true;
    tank.figure.visible = true;
    this.phase = 'tank';
    this.t = 0;
    this.outside = 0;
    this.seg = 0;
    this.keys = null;
    this.act = 'walk';
    this.metalMeshes = new Set();
    const c = new Creature(this.floatWorld, 0, 0, SKIN);
    c.snap = (_p, o) => o.set(0, 0, 0);
    c.scriptBreath = { value: 0, amp: 0 };
    this.creature = c;
    this.build(c);
    this.holder.add(c.rig.root);
    // hanging in the fluid on its tether
    this.holder.position.set(0, -0.72, 0);
    this.holder.rotation.set(0, 0, 0);
    tank.figure.add(this.holder);
    blendPose(this.pose, FLOAT, FLOAT, 0);
    for (let i = 0; i < 10; i++) c.updateScripted(1 / 30, this.pose, this.floatWorld);
    this.makeTube();
  }

  /** The ground under it: the tank's floor, the deck, the airlock's threshold and steps, or the sand. */
  private ground(x: number, z: number) {
    const interior = this.station.interior;
    const tank = interior.tank.at;
    if (Math.hypot(x - tank.x, z - tank.z) < 0.44) return tank.y;
    const l = interior.root.worldToLocal(this.tmp2.set(x, 0, z));
    const base = interior.root.localToWorld(new Vector3(0, 0, 0)).y;
    if (Math.abs(l.x - 0.9) < 0.6 && l.z > 1.4) {
      if (l.z < 2.36) return base + 0.85;
      if (l.z < 2.71) return base + 0.325;
      if (l.z < 3.01) return base + 0.155;
    }
    this.tmp2.set(x, 0, z);
    if (interior.contains(this.tmp2)) return interior.floorY;
    return terrainHeight(x, z);
  }

  /** The three cards are in: let it out. */
  begin() {
    if (this.phase !== 'tank') return;
    this.phase = 'drain';
    this.t = 0;
    this.audio.releaseChime(0.5);
    this.audio.tankDrain(0.5, 3.0);
  }

  /** The drone has it: it bursts, flesh and metal flung across the sand. */
  kill(dir?: Vector3) {
    if (this.phase === 'dead') return;
    const at = this.chest(new Vector3());
    this.lastChest.copy(at);
    this.phase = 'dead';
    this.holder.updateMatrixWorld(true);
    const d = dir ? this.tmp.set(dir.x, 0, dir.z) : this.tmp.set(0, 0, 0);
    if (d.lengthSq() > 0.001) d.normalize();
    const parts: Mesh[] = [];
    this.creature.rig.root.traverse((o) => {
      if (o instanceof Mesh) parts.push(o);
    });
    for (const part of parts) {
      this.group.attach(part);
      const out = part.getWorldPosition(this.tmp2).sub(at);
      out.y = Math.max(0, out.y);
      if (out.lengthSq() < 1e-4) out.set(Math.random() - 0.5, 0.2, Math.random() - 0.5);
      out.normalize();
      const vel = new Vector3()
        .copy(out)
        .multiplyScalar(rand(2, 5))
        .addScaledVector(d, rand(1, 2.5))
        .add(new Vector3((Math.random() - 0.5) * 2, rand(2, 5), (Math.random() - 0.5) * 2));
      const spin = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(28);
      const metal = this.metalMeshes.has(part);
      this.gibs.push({ obj: part, vel, spin, rest: false, bled: false, bleed: metal ? 0 : rand(1.5, 3.5), metal });
    }
    this.creature.rig.root.removeFromParent();
    // the cables whip away too
    for (const s of this.tube) s.prev.copy(s.p).addScaledVector(this.tmp2.set(Math.random() - 0.5, -0.6 - Math.random(), Math.random() - 0.5), 0.06);
    // a burst of blood and flesh and sparks, and fluid from what it was full of
    for (let i = 0; i < 120; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(1, 6.5);
      const k = Math.random();
      const col = k < 0.12 ? GORE : k < 0.25 ? BILE : k < 0.37 ? SPARK : BLOOD;
      this.dust.spawn(at.x, at.y, at.z, Math.cos(a) * s + d.x * 2, rand(1, 6), Math.sin(a) * s + d.z * 2, rand(0.5, 1.5), col, k < 0.12 ? 2 : 1, {
        g: 11,
        drag: 0.4,
        windK: 0,
        c2: k >= 0.25 && k < 0.37 ? SPARK_COOL : k >= 0.12 && k < 0.25 ? BILE_FADE : BLOOD_FADE,
      });
    }
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(0.1, 1.5);
      this.splat(at.x + Math.cos(a) * r, at.z + Math.sin(a) * r, rand(0.1, 0.3), Math.random() < 0.3 ? this.bileMat : this.bloodMat);
    }
    this.splat(at.x, at.z, 0.55, this.bloodMat);
    this.audio.specimenSlap(0.6, 0, true, true);
  }

  update(dt: number, time: number, listener: Vector3) {
    if (this.phase === 'dead') {
      this.updateGibs(dt);
      this.updateTube(dt, 9);
      return;
    }
    const c = this.creature;
    const tank = this.station.interior.tank;
    const level = (d: number) => 1 / (1 + (d * d) / 16);
    if (this.phase === 'tank') {
      // asleep in the fluid: it turns on its tether, a hand or a foot drifting now and then
      blendPose(this.pose, FLOAT, FLOAT, 0);
      const tw = Math.max(0, noise1(time * 0.4, 3) - 0.3) * 2;
      this.pose.headYaw += Math.sin(time * 0.3) * 0.15;
      this.pose.elbow += Math.sin(time * 0.7) * 0.15 + Math.sin(time * 8) * 0.1 * tw;
      this.pose.footL.lift += Math.sin(time * 0.5) * 0.03;
      c.updateScripted(dt, this.pose, this.floatWorld);
      this.updateTube(dt, -0.4);
      return;
    }
    this.t += dt;
    if (this.phase === 'drain') {
      // the fluid sinks away, swirling, the figure sinking with it
      tank.level = 1 - smooth(0.2, 2.7, this.t);
      tank.liquid.visible = tank.level > 0.01;
      tank.liquid.scale.y = Math.max(0.001, 1.47 * tank.level);
      if (Math.random() < 0.7) {
        const a = time * 6 + Math.random();
        const r = 0.1 + Math.random() * 0.25;
        const y = tank.at.y + 0.05 + Math.random() * 1.4 * tank.level;
        this.dust.spawn(tank.at.x + Math.cos(a) * r, y, tank.at.z + Math.sin(a) * r, -Math.sin(a) * 0.4, -0.3, Math.cos(a) * 0.4, 0.5, BUBBLE, 1, { g: 1, drag: 1, windK: 0 });
      }
      blendPose(this.pose, FLOAT, FLOAT, 0);
      if (this.t > 2) this.pose.tremble = 0.6;
      c.updateScripted(dt, this.pose, this.floatWorld);
      this.updateTube(dt, -0.4 * tank.level + 9 * (1 - tank.level));
      if (this.t > 2.9) {
        this.phase = 'settle';
        this.t = 0;
        this.spawn();
        this.audio.specimenSlap(0.4 * level(listener.distanceTo(tank.at)), 0, true);
        this.audio.specimenVoice('gurgle', 0.55 * level(listener.distanceTo(tank.at)), 0);
      }
      return;
    }
    if (this.phase === 'settle') {
      // in a heap on the tank's floor, heaving for breath
      blendPose(this.pose, HEAP, HEAP, 0);
      this.jerks(dt, 0.6);
      if (this.t > 0.7) {
        this.phase = 'door';
        this.t = 0;
        this.audio.tankHiss(0.5 * level(listener.distanceTo(tank.at)));
      }
      this.scripted(dt);
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
      blendPose(this.pose, HEAP, HEAP, 0);
      // the cold air hits it: it jerks and shrieks
      if (this.t > 0.3 && this.t - dt <= 0.3) {
        this.twitch.t = 0;
        this.audio.specimenVoice('shriek', 0.45 * level(listener.distanceTo(this.at ?? tank.at)), 0);
      }
      this.jerks(dt, 1);
      this.scripted(dt);
      if (this.t > 1.1) {
        this.phase = 'wake';
        this.t = 0;
        this.play(GET_UP, 1.25);
      }
    } else if (this.phase === 'wake') {
      // up, in fits
      this.scripted(dt);
      if (!this.keys) {
        this.phase = 'walk';
        this.t = 0;
        this.seg = 1;
        this.startWalking();
      }
    } else {
      this.move(dt, time, listener);
    }
    // it never stops making some sound
    const at = this.at!;
    this.voiceTimer -= dt;
    if (this.voiceTimer <= 0) {
      const out = this.phase === 'outside';
      this.voiceTimer = rand(0.8, 1.9);
      const kinds = out ? (['whimper', 'gasp', 'mewl', 'gasp'] as const) : (['whimper', 'mewl', 'gasp', 'gasp'] as const);
      this.audio.specimenVoice(kinds[Math.floor(Math.random() * kinds.length)], 0.45 * level(listener.distanceTo(at)), this.pan(listener));
    }
    // the optic flickers
    this.optic.visible = Math.random() > 0.06;
    // its eye still booting: it comes and goes, stutters, and holds for a while
    if (this.eye) this.eye.visible = noise1(time * 2.3, 17) > -0.35 && Math.random() > 0.04;
    this.updateTube(dt, 9);
    this.drip();
  }

  private pan(listener: Vector3) {
    const at = this.at;
    return at ? Math.max(-0.8, Math.min(0.8, (at.x - listener.x) / 6)) : 0;
  }

  /** Play a scripted move. */
  private play(keys: Key[], rate = 1) {
    this.keys = keys;
    this.keyT = 0;
    this.keyRate = rate;
  }

  /** Run the scripted move (or hold the pose already set), with its twitches over it. */
  private scripted(dt: number) {
    const c = this.creature;
    if (this.keys) {
      this.keyT += dt * this.keyRate;
      sample(this.keys, this.keyT, this.pose);
      this.jerks(dt, 0.5);
      // a fall carries it forward onto its face
      if (this.lunge > 0 && this.keyT < 0.5) {
        const step = (TRIP_LUNGE / 0.5) * dt * this.keyRate;
        c.pos.x += Math.sin(c.yaw) * step;
        c.pos.z += Math.cos(c.yaw) * step;
      }
      if (this.keyT >= this.keys[this.keys.length - 1].t) this.keys = null;
    }
    c.scriptBreath = { value: Math.sin(this.t * 9) * 0.6, amp: 1.6 };
    c.updateScripted(dt, this.pose, this.world);
    this.holder.position.copy(this.origin);
  }

  /**
   * Sudden, uneven jerks laid over its pose: the head snapping round, the
   * chest hitching, an arm flinging, a knee giving.
   */
  private jerks(dt: number, amount: number) {
    const w = this.twitch;
    w.t -= dt;
    if (w.t <= 0) {
      w.t = rand(0.12, 0.6) / Math.max(0.3, amount);
      const k = amount;
      w.neck = rand(-0.5, 0.5) * k;
      w.head = rand(-0.9, 0.9) * k;
      w.chest = rand(-0.3, 0.3) * k;
      w.arm = rand(-0.8, 0.8) * k;
      w.knee = rand(0, 0.08) * k;
    }
    const f = Math.exp(-dt * 9);
    w.neck *= f;
    w.head *= f;
    w.chest *= f;
    w.arm *= f;
    w.knee *= f;
    const p = this.pose;
    p.neckPitch += w.neck;
    p.headYaw += w.head;
    p.headRoll += w.head * 0.4;
    p.chestPitch += w.chest;
    p.chestRoll += w.chest * 0.7;
    p.armPitch += w.arm;
    p.pelvisY -= w.knee;
  }

  private startWalking() {
    this.act = 'walk';
    this.lunge = 0;
    this.creature.releaseScript(0.6);
    this.fitTimer = Math.max(this.fitTimer, this.phase === 'outside' ? 1.2 : 3);
  }

  /** Staggering along its way, with its fits. */
  private move(dt: number, time: number, listener: Vector3) {
    const c = this.creature;
    const out = this.phase === 'outside';
    if (out) this.outside += dt;
    const at = this.at!;
    const lv = 1 / (1 + listener.distanceToSquared(at) / 16);
    const pan = this.pan(listener);
    if (this.act !== 'walk') {
      this.scripted(dt);
      if (this.act === 'knees' && this.keyT > 0.6 && this.keyT - dt <= 0.6) this.audio.specimenSlap(0.3 * lv, pan, !out, false);
      if (this.act === 'trip' && this.keyT > 0.5 && this.keyT - dt <= 0.5) {
        // face first onto the deck or the sand
        this.audio.specimenSlap(0.5 * lv, pan, !out, true);
        this.audio.specimenVoice('whimper', 0.45 * lv, pan);
        if (out) this.dust.kick(at.x, at.y, at.z, Math.sin(c.yaw), Math.cos(c.yaw), 5, 0.6);
      }
      if (!this.keys) this.startWalking();
    } else {
      // weaving toward the next point on its way, in lurches, the knees not quite holding it
      const target = this.path[Math.min(this.seg, this.path.length - 1)];
      let dx = target.x - at.x;
      let dz = target.z - at.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
      let weave = noise1(time * 0.9, 3) * (out ? 0.45 : 0.3) + Math.sin(time * 2.1) * 0.1;
      // now and then it lurches off to one side and has to catch itself
      this.staggerWait -= dt;
      if (this.staggerWait <= 0 && this.stagger <= 0) {
        this.stagger = 0.45;
        this.staggerSide = Math.random() < 0.5 ? -1 : 1;
        this.staggerWait = rand(1.6, 3.5);
      }
      let push = 1;
      if (this.stagger > 0) {
        this.stagger -= dt;
        const k = Math.sin((1 - this.stagger / 0.45) * Math.PI);
        weave += this.staggerSide * 1.1 * k;
        push = 1 + 0.4 * k;
      }
      const cw = Math.cos(weave);
      const sw = Math.sin(weave);
      const wx = dx * cw + dz * sw;
      const wz = -dx * sw + dz * cw;
      // halting steps: it slows, almost stops, then lurches on
      const lurch = 0.55 + 0.45 * Math.max(0, noise1(time * 1.6, 5) + 0.35);
      const speed = (out ? 0.48 : 0.58) * lurch * push;
      this.input.move.set(wx * speed, -wz * speed);
      // it looks at the creature when it is close: the red eye finds it
      if (listener.distanceTo(at) < 3.5) this.input.look = this.toLocal(this.look.copy(listener).setY(listener.y + 0.9), this.look);
      else this.input.look = null;
      c.panic = 0.6;
      c.tired = Math.max(c.tired, 0.8);
      c.update(dt, this.input, this.world);
      this.holder.position.copy(this.origin);
      // its steps: a wet slap of a bare foot, the clank of the steel one
      for (const e of c.events) {
        const w = this.toWorld(this.tmp.set(e.x, e.y, e.z), this.tmp);
        this.audio.specimenSlap(0.18 * lv, pan, e.side > 0 || !out, false);
        if (this.marks.length < 400) this.print(w.x, w.z, c.yaw, e.side, out);
      }
      if (Math.hypot(target.x - at.x, target.z - at.z) < 0.35 && this.seg < this.path.length - 1) this.seg++;
      // the ground drops away ahead (the tank's lip, the airlock's steps): it goes down on its face
      this.stepCool -= dt;
      const ahead = this.ground(at.x + Math.sin(c.yaw) * 0.22, at.z + Math.cos(c.yaw) * 0.22);
      if (this.stepCool <= 0 && ahead < this.ground(at.x, at.z) - 0.12) {
        this.stepCool = 1.2;
        this.fit('trip', lv, pan, 1.7);
      }
      // and its fits
      this.fitTimer -= dt;
      if (this.fitTimer <= 0) {
        const r = Math.random();
        this.fit(r < (out ? 0.25 : 0.15) ? 'trip' : r < 0.6 ? 'knees' : 'catch', lv, pan);
      }
    }
    // out of the airlock and onto the sand
    if (!out && this.seg >= 12) {
      this.phase = 'outside';
      this.outside = 0;
    }
  }

  private fit(act: Act, lv: number, pan: number, rate = 1) {
    this.act = act;
    this.fitTimer = this.phase === 'outside' ? rand(2, 3.5) : rand(4, 7);
    this.lunge = act === 'trip' ? 1 : 0;
    this.twitch.t = 0;
    this.play(act === 'trip' ? TRIP : act === 'knees' ? KNEES : CATCH, rate);
    this.audio.specimenVoice(act === 'catch' ? 'gasp' : 'whimper', 0.45 * lv, pan);
  }

  /** A footprint: wet on the deck, a scuff in the sand. */
  private print(x: number, z: number, yaw: number, side: number, out: boolean) {
    const m = new Mesh(new BoxGeometry(0.07, 0.004, 0.09), out ? this.printMat : this.wetMat);
    m.position.set(x, this.ground(x, z) + 0.005 + (this.marks.length % 7) * 0.0004, z);
    m.rotation.y = yaw + side * 0.15;
    this.group.add(m);
    this.marks.push(m);
    if (out) this.dust.spawn(x, m.position.y + 0.02, z, (Math.random() - 0.5) * 0.3, 0.2, (Math.random() - 0.5) * 0.3, 0.5, SAND, 1, { g: 2, drag: 2, windK: 0.3, c2: SAND_FADE, soft: true });
  }

  /** A wet stain where it fell or bled or retched. */
  private splat(x: number, z: number, r: number, mat: Material) {
    const m = new Mesh(new CylinderGeometry(r, r, 0.006, 7), mat);
    m.position.set(x, this.ground(x, z) + 0.008 + (this.marks.length % 9) * 0.0004, z);
    m.scale.set(rand(0.7, 1.3), 1, rand(0.6, 1.1));
    m.rotation.y = Math.random() * Math.PI;
    this.group.add(m);
    this.marks.push(m);
  }

  /** It drips, always, and sparks now and then where metal meets flesh. */
  private drip() {
    const at = this.at;
    if (!at) return;
    const out = this.phase === 'outside';
    if (Math.random() < (out ? 0.12 : 0.4)) {
      this.dust.spawn(at.x + (Math.random() - 0.5) * 0.15, at.y + 0.3, at.z + (Math.random() - 0.5) * 0.15, 0, -0.2, 0, 0.5, FLUID, 1, { g: 9, drag: 0.2, windK: 0, c2: FLUID_FADE });
    }
    if (Math.random() < 0.03) {
      this.optic.getWorldPosition(this.tmp);
      for (let i = 0; i < 3; i++) this.dust.spawn(this.tmp.x, this.tmp.y, this.tmp.z, (Math.random() - 0.5) * 1.2, rand(0.2, 1), (Math.random() - 0.5) * 1.2, 0.35, SPARK, 1, { g: 9, drag: 0.5, windK: 0, c2: SPARK_COOL });
    }
  }

  /** Out of the fluid: it lies in a heap on the tank's floor. */
  private spawn() {
    const tank = this.station.interior.tank;
    tank.figure.visible = false;
    tank.floating = false;
    const c = this.creature;
    this.group.add(this.holder);
    this.holder.position.copy(this.origin);
    this.holder.rotation.set(0, 0, 0);
    c.setYaw(Math.atan2(tank.out.x, tank.out.z));
    c.teleport(0, 0, this.world);
    blendPose(this.pose, HEAP, HEAP, 0);
    for (let i = 0; i < 6; i++) c.updateScripted(1 / 30, this.pose, this.world);
    this.splat(tank.at.x, tank.at.z, 0.3, this.wetMat);
  }

  /** The cables from its back: a rope of segments dragging behind it. `g` is its weight (less than nothing in the fluid). */
  private makeTube() {
    this.holder.updateMatrixWorld(true);
    const a = this.navel.getWorldPosition(new Vector3());
    for (let i = 0; i < 8; i++) {
      const mesh = new Mesh(faceted(new CylinderGeometry(0.012, 0.012, 1, 5)), this.M.tube);
      mesh.layers.enable(SHADOW_LAYER);
      this.group.add(mesh);
      const p = new Vector3(a.x, a.y - i * 0.05, a.z);
      this.tube.push({ p, prev: p.clone(), mesh });
    }
  }

  private updateTube(dt: number, g: number) {
    if (!this.tube.length) return;
    const LEN = 0.055;
    const anchored = this.phase !== 'dead';
    if (anchored) {
      this.holder.updateMatrixWorld(true);
      this.navel.getWorldPosition(this.tube[0].p);
    }
    const step = Math.min(dt, 1 / 30);
    const tank = this.station.interior.tank;
    for (let i = anchored ? 1 : 0; i < this.tube.length; i++) {
      const s = this.tube[i];
      const vx = (s.p.x - s.prev.x) * 0.96;
      const vy = (s.p.y - s.prev.y) * 0.96;
      const vz = (s.p.z - s.prev.z) * 0.96;
      s.prev.copy(s.p);
      s.p.x += vx;
      s.p.y += vy - g * step * step;
      s.p.z += vz;
      const floor = this.phase === 'tank' || this.phase === 'drain' ? tank.at.y : this.ground(s.p.x, s.p.z);
      if (s.p.y < floor + 0.012) {
        s.p.y = floor + 0.012;
        s.prev.x += (s.p.x - s.prev.x) * 0.5;
        s.prev.z += (s.p.z - s.prev.z) * 0.5;
      }
    }
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < this.tube.length; i++) {
        const a = this.tube[i - 1].p;
        const c = this.tube[i].p;
        const d = this.tmp.copy(c).sub(a);
        const l = d.length() || 1e-4;
        const k = (l - LEN) / l;
        if (anchored && i === 1) c.addScaledVector(d, -k);
        else {
          a.addScaledVector(d, k * 0.5);
          c.addScaledVector(d, -k * 0.5);
        }
      }
    }
    const UP = this.tmp2.set(0, 1, 0);
    for (let i = 0; i < this.tube.length; i++) {
      const s = this.tube[i];
      const last = i + 1 >= this.tube.length;
      const a = last ? this.tube[i - 1].p : s.p;
      const c = last ? s.p : this.tube[i + 1].p;
      const d = this.tmp.copy(c).sub(a);
      const l = d.length();
      s.mesh.visible = !last && l > 0.001;
      if (!s.mesh.visible) continue;
      s.mesh.position.copy(a).addScaledVector(d, 0.5);
      s.mesh.quaternion.setFromUnitVectors(UP, d.multiplyScalar(1 / l));
      s.mesh.scale.set(1, l + 0.01, 1);
    }
  }

  /** The pieces flying, tumbling, bouncing, and bleeding or sparking where they lie. */
  private updateGibs(dt: number) {
    for (const g of this.gibs) {
      const p = g.obj.position;
      if (g.rest) {
        if (g.bleed > 0) {
          g.bleed -= dt;
          if (Math.random() < 0.15) this.dust.spawn(p.x, p.y + 0.02, p.z, (Math.random() - 0.5) * 0.3, 0.3, (Math.random() - 0.5) * 0.3, 0.5, BLOOD, 1, { g: 8, drag: 0.4, windK: 0 });
        } else if (g.metal && Math.random() < 0.01) {
          this.dust.spawn(p.x, p.y + 0.02, p.z, (Math.random() - 0.5) * 0.8, rand(0.3, 1), (Math.random() - 0.5) * 0.8, 0.3, SPARK, 1, { g: 9, drag: 0.4, windK: 0, c2: SPARK_COOL });
        }
        continue;
      }
      g.vel.y -= 9.8 * dt;
      p.addScaledVector(g.vel, dt);
      g.obj.rotation.x += g.spin.x * dt;
      g.obj.rotation.y += g.spin.y * dt;
      g.obj.rotation.z += g.spin.z * dt;
      if (Math.random() < 0.4) this.dust.spawn(p.x, p.y, p.z, g.vel.x * 0.1, g.vel.y * 0.1, g.vel.z * 0.1, 0.5, g.metal ? SPARK : BLOOD, 1, { g: 9, drag: 0.4, windK: 0, c2: g.metal ? SPARK_COOL : BLOOD_FADE });
      const floor = this.ground(p.x, p.z) + 0.02;
      if (p.y < floor) {
        p.y = floor;
        if (!g.bled && !g.metal) {
          g.bled = true;
          this.splat(p.x, p.z, rand(0.06, 0.14), this.bloodMat);
        }
        g.vel.y = -g.vel.y * 0.3;
        g.vel.x *= 0.5;
        g.vel.z *= 0.5;
        g.spin.multiplyScalar(0.5);
        if (Math.abs(g.vel.y) < 0.6 && Math.hypot(g.vel.x, g.vel.z) < 0.4) g.rest = true;
      }
    }
  }

  /**
   * Make the creature's body into one of its kind left half built: most of
   * its shell still bare primer, only the head and one arm finished in the
   * creature's own colours; the chest left open on its frame, the glowing core
   * and its bundled wiring showing; the left arm and the left shin bare
   * skeleton and actuators; one horn fitted, the other only a socket; a side
   * panel of the head missing over the optics; calibration marks here and
   * there; and the umbilical still plugged into its back.
   */
  private build(c: Creature) {
    const M = this.M;
    const rig = c.rig;
    const add = (parent: Object3D, geo: BufferGeometry, mat: Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      const m = new Mesh(faceted(geo), mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.layers.enable(SHADOW_LAYER);
      m.frustumCulled = false;
      parent.add(m);
      if (mat === M.metal || mat === M.frame) this.metalMeshes.add(m);
      return m;
    };
    const box = (parent: Object3D, w: number, h: number, d: number, mat: Material, x: number, y: number, z: number) => add(parent, new BoxGeometry(w, h, d), mat, x, y, z);
    const cyl = (parent: Object3D, r: number, h: number, mat: Material, x: number, y: number, z: number) =>
      add(parent, new CylinderGeometry(r, r, h, 8).rotateZ(Math.PI / 2), mat, x, y, z);
    const meshesOf = (o: Object3D) => o.children.filter((k): k is Mesh => k instanceof Mesh);
    const bare = (m: Mesh, thin = 0.5) => {
      m.material = M.frame;
      m.scale.set(thin, 1, thin);
      this.metalMeshes.add(m);
    };
    // the shell: bare primer everywhere to begin with
    for (const m of rig.parts) m.material = M.primer;
    // the head is finished: the creature's colours, one horn fitted, the other a socket
    const head = meshesOf(rig.head);
    head[0].material = M.shell;
    head[2].material = M.shell;
    bare(head[3], 0.6);
    head[3].scale.y = 0.35;
    head[3].position.y -= 0.04;
    // a side panel of the head left off: its optics showing, a lens flickering in there
    box(rig.head, 0.13, 0.15, 0.2, M.cavity, -0.16, 0.095, 0.0);
    box(rig.head, 0.02, 0.16, 0.21, M.frame, -0.225, 0.095, 0.0);
    cyl(rig.head, 0.03, 0.06, M.metal, -0.19, 0.12, 0.05);
    this.optic = add(rig.head, new BoxGeometry(0.035, 0.035, 0.012), M.optic, -0.19, 0.12, 0.085);
    box(rig.head, 0.01, 0.01, 0.14, M.wireY, -0.18, 0.06, -0.02);
    // the creature's eye, still booting (it flickers; see update)
    this.eye = rig.eye;
    // the right arm is finished; the left is bare frame and actuators
    for (const m of [...meshesOf(rig.arms[1].shoulder), ...meshesOf(rig.arms[1].elbow)]) m.material = M.shell;
    rig.arms[1].hand.material = M.shell;
    const armL = rig.arms[0];
    for (const m of [...meshesOf(armL.shoulder), ...meshesOf(armL.elbow)]) bare(m, 0.4);
    armL.hand.material = M.metal;
    cyl(armL.shoulder, 0.06, 0.1, M.metal, 0, 0, 0);
    cyl(armL.elbow, 0.05, 0.09, M.metal, 0, 0, 0);
    box(armL.shoulder, 0.012, 0.18, 0.012, M.wireR, 0.03, -0.11, 0.03);
    box(armL.elbow, 0.012, 0.16, 0.012, M.wireB, -0.025, -0.1, 0.03);
    box(armL.elbow, 0.03, 0.12, 0.03, M.metal, 0.03, -0.1, -0.02);
    // the chest left open on its frame: the core glowing, the wiring bundled round it
    box(rig.chest, 0.26, 0.2, 0.03, M.cavity, 0, 0.15, 0.115);
    for (const x of [-0.12, 0.12]) box(rig.chest, 0.025, 0.22, 0.035, M.frame, x, 0.15, 0.125);
    for (const y of [0.06, 0.24]) box(rig.chest, 0.26, 0.022, 0.035, M.frame, 0, y, 0.125);
    box(rig.chest, 0.07, 0.07, 0.02, M.core, 0.0, 0.16, 0.135);
    box(rig.chest, 0.1, 0.1, 0.01, M.frame, 0.0, 0.16, 0.13);
    for (const [x, mat, r] of [
      [-0.07, M.wireR, 0.3],
      [-0.05, M.wireB, -0.2],
      [0.06, M.wireY, 0.4],
      [0.08, M.wireR, -0.3],
    ] as const) {
      const w = box(rig.chest, 0.014, 0.16, 0.014, mat, x, 0.15, 0.137);
      w.rotation.z = r;
    }
    // a finished panel on its belly, a calibration mark, its maker's tag
    box(rig.spine, 0.17, 0.11, 0.022, M.belly, 0, 0.09, 0.105);
    box(rig.chest, 0.05, 0.012, 0.012, M.mark, 0.14, 0.27, 0.13);
    box(rig.chest, 0.012, 0.05, 0.012, M.mark, 0.165, 0.25, 0.13);
    box(rig.spine, 0.06, 0.04, 0.01, M.mark, -0.1, 0.16, 0.1);
    // the spine open down its back, and the umbilical plugged into it
    for (const y of [0.04, 0.12, 0.2, 0.28]) box(rig.chest, 0.06, 0.04, 0.04, M.metal, 0, y, -0.125);
    for (const y of [0.04, 0.14]) box(rig.spine, 0.06, 0.04, 0.04, M.metal, 0, y, -0.1);
    box(rig.chest, 0.014, 0.22, 0.014, M.wireB, 0.045, 0.14, -0.14);
    box(rig.chest, 0.014, 0.2, 0.014, M.wireR, -0.045, 0.12, -0.14);
    box(rig.chest, 0.08, 0.06, 0.05, M.metal, 0, 0.05, -0.15);
    this.navel = new Object3D();
    this.navel.position.set(0.0, 0.05, -0.18);
    rig.chest.add(this.navel);
    // the left shin and its hoof bare frame, a ram down the back of it
    const legL = rig.legs[0];
    for (const seg of [legL.shin.obj, legL.cannon.obj]) for (const m of meshesOf(seg)) bare(m, 0.45);
    for (const m of meshesOf(legL.hoof)) m.material = M.metal;
    cyl(legL.shin.obj, 0.06, 0.13, M.metal, 0, 0, 0);
    box(legL.shin.obj, 0.025, 0.2, 0.025, M.metal, 0.0, -0.13, -0.05);
    box(legL.shin.obj, 0.012, 0.22, 0.012, M.wireY, 0.03, -0.12, 0.03);
    // the right leg's thigh finished; its hoof still bare
    for (const m of meshesOf(rig.legs[1].thigh.obj)) m.material = M.shell;
    // the hips: an actuator housing on the left, its cover not yet fitted
    cyl(rig.pelvis, 0.07, 0.06, M.metal, 0.16, 0.0, 0);
  }
}
