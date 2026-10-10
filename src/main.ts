import { Raycaster, Scene, Vector2, Vector3, type Object3D } from 'three';
import { PixelRenderer } from './render/PixelRenderer';
import { shared } from './render/shared';
import { Terrain, terrainHeight } from './world/terrain';
import { Rocks } from './world/rocks';
import { Footprints } from './world/footprints';
import { Dust, SandStreaks } from './world/particles';
import { Wind } from './world/wind';
import { Creature, type CreatureInput, type World } from './character/Creature';
import { AudioEngine } from './audio/AudioEngine';
import { Input } from './core/input';
import { clamp, DynVec3, saturate } from './core/math';
import { WakeUp } from './story/WakeUp';
import { CrashSite } from './world/crashSite';
import {
  BOWL2_REACH,
  CRATER_REACH,
  craterHeight,
  POD_DIR,
  SHIP_LENGTH,
  SHIP_REACH,
  SHIP_TRENCH,
  SITE,
  SITE2,
  SITE3,
  siteMask,
  SKID,
  SKIP_REACH,
  TRENCH_LENGTH,
} from './world/crater';
import { Ship } from './world/ship';
import { DoorScene } from './story/DoorScene';
import { PickupScene } from './story/PickupScene';
import { PeekScene } from './story/PeekScene';
import { strayDebris } from './world/strayDebris';
import { HIGH, highlandMask } from './world/highlands';
import { Highlands } from './world/highlandLife';
import { Station } from './world/station';
import { Fallen } from './story/Fallen';
import { Builder } from './core/builder';
import { Tracker } from './world/tracker';
import { StainMap } from './world/stains';
import { Stranger } from './story/Stranger';
import { Drone } from './story/Drone';
import { Strike } from './story/Strike';
import { Locusts } from './story/Locusts';
import { DataCards } from './story/DataCards';
import { Specimen } from './story/Specimen';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const pr = new PixelRenderer(canvas);
const scene = new Scene();

const terrain = new Terrain();
scene.add(terrain.mesh);
const rocks = new Rocks();
for (const m of rocks.meshes) scene.add(m);
const footprints = new Footprints();
scene.add(footprints.mesh);
const streaks = new SandStreaks();
scene.add(streaks.mesh);
const dust = new Dust(1800);
scene.add(dust.mesh);

const world: World = { height: terrainHeight, rocks: rocks.nearby, cliffs: (x, z) => highlandMask(x, z) > 0.05 };
const START = new Vector2(-46, 11);
/** How far right of the start the first pod's crater lies (its trench reaches back toward the start). */
const CRASH_DISTANCE = 38;
rocks.update(START.x, START.y);
const creature = new Creature(world, START.x, START.y);
creature.setYaw(1.0);
creature.snap = (p, out) => pr.snapDelta(p, out);
scene.add(creature.rig.root);

const wind = new Wind();
const audio = new AudioEngine();
// the kill drone that comes for the creature once it has been inside the station, and its strike
const drone = new Drone(audio);
drone.addTo(scene);
const strike = new Strike(dust, audio, world);
strike.addTo(scene);
// the drone's other strike: on the thing let out of the tank (it spares the creature)
const npcStrike = new Strike(dust, audio, world);
npcStrike.addTo(scene);
/** The drone has had its kill: it never comes again. */
let droneDone = false;
// the data cards, and the specimen they let out of its tank
let cards: DataCards | null = null;
let specimen: Specimen | null = null;
/** Stooping to take a card: seconds left, and what it is looking at. */
let grabT = 0;
const grabAt = new Vector3();
/** Glancing back over its shoulder at the drone while it runs: seconds left of this glance, and until the next. */
let glanceT = 0;
let glanceWait = 2;
/** Where the creature comes back to when it dies: the last checkpoint it passed. */
interface Checkpoint {
  name: string;
  inside: boolean;
  x: number;
  z: number;
  yaw: number;
}
let checkpoint: Checkpoint | null = null;
/** Seconds until the drone comes (after the creature leaves the station), or -1. */
let droneWait = -1;
/** The view coming back after a respawn (1 dark .. 0). */
let respawnFade = 0;
const chest = new Vector3();
// the first pod's crater, to the right of the start
let site: CrashSite | null = null;
// a second pod lands near the first, and its survivor lies at the end of a trail
let site2: CrashSite | null = null;
// the ship they escaped from, beyond the stranger, and its jammed door
let ship: Ship | null = null;
let doorScene: DoorScene | null = null;
/** Using the keypad: the camera closes in on it and the buttons can be pressed. */
let padMode = false;
let padWeight = 0;
let stranger: Stranger | null = null;
// the highlands the tracker leads to
let highlands: Highlands | null = null;
// the research station on its summit, and the three shot outside it
let station: Station | null = null;
let fallen: Fallen | null = null;
let fallenSeen = false;
// the carrion locusts eating them
let locusts: Locusts | null = null;
// the tracker left in the ship's doorway, and taking it up
let tracker: Tracker | null = null;
let pickup: PickupScene | null = null;
// looking into the escape pods
let peek: PeekScene | null = null;
/** Something that can be used, by what it is. */
type Usable =
  | { kind: 'tracker' }
  | { kind: 'stranger' }
  | { kind: 'pad' }
  | { kind: 'door' }
  | { kind: 'pod'; site: CrashSite }
  | { kind: 'hatch' }
  | { kind: 'card'; card: DataCards['cards'][number] }
  | { kind: 'reader' };
/**
 * Walking over to use something the player clicked: where to, the nearest it
 * has come, and for how long it has come no nearer (blocked by a hull or rock).
 */
let going: { use: Usable; to: Vector3; best: number; stuck: number; time: number } | null = null;
/** What the cursor is over that can be used. */
let hoverUse: Usable | null = null;
/** How far away something can be clicked to walk over and use it. */
const WALK_RANGE = 30;
/**
 * Inside the research station: the roof and near walls are taken away, the
 * creature walks on its deck among its walls, and the world outside is heard
 * through them. Going in or out is a short fade through the airlock.
 */
let inside = false;
let insideW = 0;
let hatchMove: { t: number; out: boolean; swapped: boolean } | null = null;
const outdoorCliffs = world.cliffs;
const groundHeight = (x: number, z: number) => (inside && station ? station.interior.floorY : terrainHeight(x, z));

/** Go in (or out): swap the ground and the walls under the creature, and the view. */
function setInside(on: boolean) {
  if (!station) return;
  const wasInside = inside;
  inside = on;
  station.setCutaway(on);
  if (on) {
    world.height = station.interior.height;
    world.rocks = station.interior.colliders;
    world.cliffs = undefined;
    const sp = station.interior.spawn;
    creature.teleport(sp.x, sp.z, world);
    const d = station.interior.inward;
    creature.setYaw(Math.atan2(d.x, d.z));
  } else {
    world.height = terrainHeight;
    world.rocks = rocks.nearby;
    world.cliffs = outdoorCliffs;
    const o = station.doorOutside;
    creature.teleport(o.x, o.z, world);
    const d = station.interior.inward;
    creature.setYaw(Math.atan2(-d.x, -d.z));
  }
  camDyn.reset(new Vector3(creature.pos.x, creature.pos.y + 0.6, creature.pos.z));
  // the first time in is a checkpoint; coming back out, something is waiting
  if (on && !checkpoint) saveCheckpoint('station');
  if (!on && wasInside && !drone.active && !strike.active && !droneDone) droneWait = 4;
}

function saveCheckpoint(name: string) {
  checkpoint = { name, inside, x: creature.pos.x, z: creature.pos.z, yaw: creature.yaw };
}

/** Dead: back to the last checkpoint, as if none of it had happened. */
function respawn() {
  strike.clear();
  drone.reset();
  audio.deafen(0);
  droneWait = -1;
  going = null;
  hatchMove = null;
  creature.releaseScript();
  const cp = checkpoint;
  if (cp?.inside && station) {
    inside = false;
    setInside(true);
    insideW = 1;
  } else if (cp) {
    if (inside) setInside(false);
    creature.teleport(cp.x, cp.z, world);
    creature.setYaw(cp.yaw);
    camDyn.reset(new Vector3(creature.pos.x, creature.pos.y + 0.6, creature.pos.z));
  }
  respawnFade = 1;
}

function beginHatch(out: boolean) {
  if (hatchMove) return;
  going = null;
  hatchMove = { t: 0, out, swapped: false };
  audio.hatch(0.22);
}
/** The left button while the tracker is in hand: a click on it drops it, holding raises it to look at. */
const press = { down: false, t: 0, onDevice: false, out: false };
let deviceHover = false;
/** Holding the tracker out: the way the cursor turns the creature. */
let spinYaw: number | null = null;
/** How near the cursor (CSS pixels) must be to the tracker to use it. */
const DEVICE_PX = 30;

interface SecondPodLayout {
  pod: Vector2;
  slide: Vector2;
  end: Vector2;
  mid: Vector2;
  axis: Vector2;
  skid: Vector2[];
  score: number;
  ship: { center: Vector2; dir: Vector2; samples: Vector2[] } | null;
}

/** How far the second pod lies from the crater, and its survivor's trail from the pod. */
const POD2_DISTANCE = 26;
const TRAIL_LENGTH = 22;
/**
 * Where the ship's centre lies from the stranger: well further right and a little up
 * the screen, out of sight from there, its trench running back past the trail.
 */
const SHIP_OFFSET = new Vector2(32, -12);
/** How far the highlands' heart lies from the ship, to the north-east (a long walk). */
const HIGHLAND_DISTANCE = 130;

/**
 * Lay out the second pod and its survivor around the crater (crater at 0, 0),
 * further along the heading `h`: the pod's long skid comes in from near the
 * crater (so it leads the eye out to the pod), clear of the first trench, and
 * the survivor's trail heads on out into the desert.
 */
function planSecondPod(h: Vector2) {
  const D = POD_DIR;
  const clear = (x: number, z: number, margin: number) => {
    const t = 1 + (x * D.x + z * D.y) / TRENCH_LENGTH;
    const s = x * -D.y + z * D.x;
    const inTrench = t > -0.2 && t < 1.1 && Math.abs(s) < margin;
    return !inTrench && Math.hypot(x, z) > CRATER_REACH + 1;
  };
  const rot = (x: number, z: number, a: number) => new Vector2(x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a));
  const side = 1;
  let best: SecondPodLayout | null = null;
  let bestScore = -Infinity;
  function layout(deg: number, slideAngle: number, slideSign: number, bend: number, withShip: boolean): SecondPodLayout | null {
    const u = rot(h.x, h.y, side * deg * (Math.PI / 180));
    const pod = u.clone().multiplyScalar(POD2_DISTANCE);
    const tw = rot(...(u.clone().multiplyScalar(0.5).add(h).normalize().toArray() as [number, number]), bend);
    const end = pod.clone().addScaledVector(tw, TRAIL_LENGTH);
    const mid = pod.clone().addScaledVector(tw, TRAIL_LENGTH / 2);
    if (!clear(pod.x, pod.y, BOWL2_REACH + 1) || pod.length() < CRATER_REACH + BOWL2_REACH) return null;
    for (const p of [mid, end, pod.clone().addScaledVector(tw, TRAIL_LENGTH / 4), pod.clone().addScaledVector(tw, (TRAIL_LENGTH * 3) / 4)]) {
      if (!clear(p.x, p.y, 7)) return null;
    }
    const slide = rot(slideSign, 0, slideAngle);
    // the trail must not run back down the skid
    if (-slide.dot(tw) > 0.35) return null;
    const skid: Vector2[] = [];
    for (let a = 2; a <= SKID + SKIP_REACH; a += 3) skid.push(pod.clone().addScaledVector(slide, -a));
    for (const p of skid) if (!clear(p.x, p.y, 5.5)) return null;
    const start = skid[skid.length - 1];
    const score = -Math.abs(start.length() - (CRATER_REACH + 6)) * 0.3 + Math.abs(slide.x) * 2 - deg * 0.02;
    const sx = Math.abs(tw.x) > 0.15 ? Math.sign(tw.x) : side;
    const axis = tw.clone().multiplyScalar(0.7).add(new Vector2(sx * 0.6, 0)).normalize();
    // the ship lies beyond the stranger, further right, across the view
    const center = end.clone().add(SHIP_OFFSET);
    // nose-right, like the pods, its trench running back left beside the trail
    const dir = new Vector2(1, 0);
    const samples: Vector2[] = [];
    for (let a = SHIP_REACH.bow - 4; a >= -SHIP_LENGTH / 2 - SHIP_TRENCH; a -= 4) samples.push(center.clone().addScaledVector(dir, a));
    const trailPts = [pod, mid, pod.clone().addScaledVector(tw, TRAIL_LENGTH / 4), pod.clone().addScaledVector(tw, (TRAIL_LENGTH * 3) / 4)];
    let ok = withShip;
    for (const p of samples) {
      if (!ok) break;
      if (!clear(p.x, p.y, 12) || p.length() < CRATER_REACH + 10 || p.distanceTo(pod) < BOWL2_REACH + 2) ok = false;
      // its bow and the sand it ploughed up may come close to the stranger, not over the trail
      else if (skid.some((k) => k.distanceTo(p) < 8) || trailPts.some((k) => k.distanceTo(p) < 9.5) || p.distanceTo(end) < 9.5) ok = false;
    }
    if (withShip && !ok) return null;
    return { pod, slide, end, mid, axis, skid, score, ship: ok ? { center, dir, samples } : null };
  }
  // with the ship if it fits anywhere; failing that, without it
  for (const withShip of [true, false]) {
    for (const deg of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
      for (const bend of [0, 0.3, -0.3]) {
        for (const a of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
          for (const sgn of [1, -1]) {
            const l = layout(deg, a, sgn, bend, withShip);
            if (l && l.score > bestScore) {
              bestScore = l.score;
              best = l;
            }
          }
        }
      }
      if (best) break;
    }
    if (best) break;
  }
  return best as SecondPodLayout | null;
}

/**
 * Lay out the story's places, fixed, to the right of the start: the first
 * pod's crater, the second pod beyond it, its survivor's trail, and the ship.
 */
function layoutWorld() {
  // everything lies to the right of where the creature wakes, one after another
  const h = new Vector2(1, 0);
  // the first pod lies nose-right, so its skid comes in from the left, along its axis
  const dx = POD_DIR.x;
  const dz = POD_DIR.y;
  const plan = planSecondPod(h);
  const cx = START.x + CRASH_DISTANCE;
  const cz = START.y;
  SITE.x = cx;
  SITE.z = cz;
  SITE.dx = dx;
  SITE.dz = dz;
  SITE.on = true;
  shared.uSite.value.set(SITE.x, SITE.z, dx, dz);
  shared.uSiteOn.value = 1;
  if (plan) {
    SITE2.x = cx + plan.pod.x;
    SITE2.z = cz + plan.pod.y;
    SITE2.dx = plan.slide.x;
    SITE2.dz = plan.slide.y;
    SITE2.ex = cx + plan.end.x;
    SITE2.ez = cz + plan.end.y;
    SITE2.mx = cx + plan.mid.x;
    SITE2.mz = cz + plan.mid.y;
    SITE2.on = true;
    shared.uSite2.value.set(SITE2.x, SITE2.z, SITE2.dx, SITE2.dz);
    shared.uSite2Trail.value.set(SITE2.mx, SITE2.mz, SITE2.ex, SITE2.ez);
    shared.uSite2On.value = 1;
    if (plan.ship) {
      SITE3.x = cx + plan.ship.center.x;
      SITE3.z = cz + plan.ship.center.y;
      SITE3.dx = plan.ship.dir.x;
      SITE3.dz = plan.ship.dir.y;
      SITE3.on = true;
      shared.uSite3.value.set(SITE3.x, SITE3.z, SITE3.dx, SITE3.dz);
      shared.uSite3On.value = 1;
      // the highlands, far off to the north-east of the ship, opening toward it
      HIGH.x = SITE3.x + HIGHLAND_DISTANCE * Math.SQRT1_2;
      HIGH.z = SITE3.z - HIGHLAND_DISTANCE * Math.SQRT1_2;
      const ox = SITE3.x - HIGH.x;
      const oz = SITE3.z - HIGH.z;
      const ol = Math.hypot(ox, oz);
      HIGH.ox = ox / ol;
      HIGH.oz = oz / ol;
      HIGH.on = true;
      shared.uHigh.value.set(HIGH.x, HIGH.z, HIGH.ox, HIGH.oz);
      shared.uHighOn.value = 1;
      highlands = new Highlands(dust, audio, rocks);
      highlands.addTo(scene);
      terrain.addHighlands(scene);
      // the station on the summit, and the three shot outside it, made as the creature nears
      later(HIGH.x, HIGH.z, 90, buildStation);
    }
  }
  rocks.refresh();
  site = new CrashSite(rocks, dust, audio, 'first');
  scene.add(site.group);
  // a stray scrap of the pod, a few steps from where the creature wakes, toward the crash
  scene.add(strayDebris(START.x + 6.5, START.y + 0.7, 0.6, rocks));
  peek = new PeekScene(creature, world, audio);
  // the second pod and its survivor, then the ship, made as the creature heads their way
  if (plan) later(SITE2.x, SITE2.z, 55, () => buildSecondPod(plan));
  if (SITE3.on) later(SITE3.x, SITE3.z, 60, buildShip);
}

/** Builds things a few milliseconds at a time (see core/builder.ts). */
const builder = new Builder();
/** Things to make only when the creature comes within `r` of them. */
const pending: { x: number; z: number; r: number; make: () => Generator<unknown, void, unknown> }[] = [];
function later(x: number, z: number, r: number, make: () => Generator<unknown, void, unknown>) {
  pending.push({ x, z, r, make });
}
/** Start making whatever the creature is now near enough to. */
function streamWorld() {
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (Math.hypot(creature.pos.x - p.x, creature.pos.z - p.z) < p.r) {
      pending.splice(i, 1);
      builder.add(p.make());
    }
  }
  builder.run(4);
}
/** Compile an object's shaders in the background (the browser does it off the main thread where it can). */
const compile = (o: Object3D) => pr.renderer.compileAsync(o, pr.camera, scene);

function* buildSecondPod(plan: SecondPodLayout): Generator<unknown, void, unknown> {
  const s2 = new CrashSite(rocks, dust, audio, 'second');
  yield;
  const axis = { x: plan.axis.x, z: plan.axis.y };
  const st = new Stranger(world, SITE2.ex, SITE2.ez, axis, rocks, dust, audio, (p, o) => pr.snapDelta(p, o));
  yield;
  // keep the dunes and rocks off the trail where it actually bends
  const path = st.trailPath(s2.hatchGround);
  SITE2.mx = path.mid.x;
  SITE2.mz = path.mid.z;
  shared.uSite2Trail.value.set(SITE2.mx, SITE2.mz, SITE2.ex, SITE2.ez);
  rocks.refresh();
  // the map of blood and marks covers the trail and the body
  const xs = [s2.hatchGround.x, path.control.x, path.end.x, SITE2.ex];
  const zs = [s2.hatchGround.z, path.control.z, path.end.z, SITE2.ez];
  const minX = Math.min(...xs) - 3;
  const minZ = Math.min(...zs) - 3;
  const size = Math.max(Math.max(...xs) + 3 - minX, Math.max(...zs) + 3 - minZ);
  const stains = new StainMap(minX, minZ, size);
  yield* st.paint(stains, s2.hatchGround);
  yield compile(s2.group);
  yield compile(st.creature.rig.root);
  scene.add(s2.group);
  scene.add(st.creature.rig.root);
  site2 = s2;
  stranger = st;
}

function* buildShip(): Generator<unknown, void, unknown> {
  const s = new Ship(rocks, dust, audio);
  yield* s.build();
  yield compile(s.group);
  s.addTo(scene);
  const t = new Tracker(s, dust, audio, rocks.nearby);
  yield;
  for (const o of t.parts) yield compile(o);
  t.addTo(scene);
  rocks.refresh();
  ship = s;
  doorScene = new DoorScene(creature, world, s, audio, dust);
  tracker = t;
  pickup = new PickupScene(creature, world, t, audio);
}

function* buildStation(): Generator<unknown, void, unknown> {
  const st = new Station(rocks, dust, audio);
  yield* st.build();
  const f = new Fallen(world, st.wallRow, st.rowDir, st.rowOut, rocks, dust, (p, o) => pr.snapDelta(p, o));
  yield* f.build();
  yield compile(st.group);
  yield compile(f.group);
  const l = new Locusts(f.feedPoints, () => rocks.nearby, dust, audio);
  yield compile(l.group);
  const dc = new DataCards(st, creature, dust, audio);
  const sp = new Specimen(st, world, audio, dust);
  dc.addTo(scene);
  sp.addTo(scene);
  cards = dc;
  specimen = sp;
  st.addTo(scene);
  f.addTo(scene);
  l.addTo(scene);
  rocks.refresh();
  station = st;
  fallen = f;
  locusts = l;
}

/** Seconds left of the creature staring at something it has just noticed. */
let noticeTime = 0;
let noticeWhat: { lookPoint: Vector3 } | 'stranger' | null = null;
layoutWorld();
const input = new Input(canvas);
const params = new URLSearchParams(location.search);

// The opening: lying limp in the sand until the player clicks.
const wake = new WakeUp(creature, world, pr, audio, dust, footprints, () => elapsed);
if (params.has('skipintro')) wake.skip();
const clickGround = new Vector3();
const clickAt = new Vector2();
window.addEventListener('pointerdown', (e) => {
  wake.begin();
  if (e.button !== 0 || wake.active || doorScene?.active || pickup?.active || peek?.active || hatchMove || strike.active) return;
  clickAt.set(e.clientX, e.clientY);
  // the tracker in hand: what the press means is settled on release (or by holding on)
  if (tracker?.carried) {
    press.down = true;
    press.t = 0;
    press.out = false;
    press.onDevice = tracker.screenDistance(clickAt, pr.camera) < DEVICE_PX;
    if (press.onDevice) return;
  }
  // the keypad: press the button under the click; a click off the pad steps back from it
  if (ship && padMode) {
    const b = ship.buttonAt(clickAt, pr.camera);
    if (b >= 0) ship.press(b);
    else if (!ship.padAt(clickAt, pr.camera)) padMode = false;
    return;
  }
  // anything usable under the click: walk over to it and use it
  if (stranger?.busy) return;
  pr.screenToGround(e.clientX, e.clientY, groundHeight, clickGround);
  const u = usableAt(clickAt, clickGround);
  if (u) {
    if (press.down) endPress();
    goUse(u);
    return;
  }
  // a click on the open sand calls off a walk
  going = null;
});

function endPress() {
  press.down = false;
  creature.holdOut = 0;
}
window.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !press.down) return;
  // a quick click on it lets it go
  if (!press.out && press.onDevice && press.t < 0.3 && tracker?.carried && !inside) {
    tracker.drop(creature);
    creature.carrying = false;
  }
  endPress();
});
window.addEventListener('blur', endPress);

const near = (x: number, z: number, r: number) => Math.hypot(x - creature.pos.x, z - creature.pos.z) < r;

/** What usable thing is under the mouse, up to WALK_RANGE away, or null. */
function usableAt(mouse: Vector2, ground: Vector3): Usable | null {
  if (tracker && pickup && tracker.takeable && !tracker.carried && near(tracker.position.x, tracker.position.z, WALK_RANGE)) {
    if (tracker.screenDistance(mouse, pr.camera) < DEVICE_PX) return { kind: 'tracker' };
  }
  if (ship && near(ship.doorCenter.x, ship.doorCenter.z, WALK_RANGE)) {
    // the keypad, or the door it opens: either takes you to the keypad while it is locked
    if (ship.state === 'locked' && (ship.padAt(mouse, pr.camera) || ship.doorAt(mouse, pr.camera))) return { kind: 'pad' };
    if (ship.state === 'cracked' && doorScene && ship.doorAt(mouse, pr.camera)) return { kind: 'door' };
  }
  if (stranger && !stranger.busy && !stranger.dead && near(stranger.center.x, stranger.center.z, WALK_RANGE)) {
    if (Math.hypot(ground.x - stranger.center.x, ground.z - stranger.center.z) < 0.95) return { kind: 'stranger' };
  }
  for (const s of [site, site2]) {
    if (s && peek && near(s.center.x, s.center.z, WALK_RANGE) && s.podAt(mouse, pr.camera)) return { kind: 'pod', site: s };
  }
  // the station's airlock: in, or (from inside) out
  // the data cards lying about, and the reader that takes them
  if (cards && grabT <= 0) {
    const c = cards.cardAt(mouse, pr.camera, inside);
    if (c && near(c.mesh.position.x, c.mesh.position.z, WALK_RANGE)) return { kind: 'card', card: c };
  }
  if (cards && station && inside && cards.carried.length && !cards.busy && !cards.complete && readerAt(mouse)) return { kind: 'reader' };
  if (station && station.interior.floorY && (inside || near(station.doorOutside.x, station.doorOutside.z, WALK_RANGE)) && station.doorAt(mouse, pr.camera)) {
    return { kind: 'hatch' };
  }
  return null;
}

const readerRay = new Raycaster();
function readerAt(mouse: Vector2) {
  readerRay.setFromCamera(new Vector2((mouse.x / window.innerWidth) * 2 - 1, -(mouse.y / window.innerHeight) * 2 + 1), pr.camera);
  const proxy = station!.interior.reader.proxy;
  proxy.updateWorldMatrix(true, false);
  return readerRay.intersectObject(proxy, false).length > 0;
}

/** It can still be used (things change on the way over). */
function stillUsable(u: Usable) {
  switch (u.kind) {
    case 'tracker':
      return !!tracker && tracker.takeable && !tracker.carried;
    case 'pad':
      return ship?.state === 'locked';
    case 'door':
      return ship?.state === 'cracked';
    case 'stranger':
      return !!stranger && !stranger.busy && !stranger.dead;
    case 'hatch':
      return !!station && !hatchMove;
    case 'card':
      return u.card.state === 'lying';
    case 'reader':
      return !!cards && cards.carried.length > 0 && !cards.complete;
    default:
      return true;
  }
}

/** Where to walk to, to use it. */
function useSpot(u: Usable, out: Vector3) {
  switch (u.kind) {
    case 'tracker':
      return pickup!.approachPoint(creature.pos, out);
    case 'pad':
      return out.copy(ship!.padStand);
    case 'door':
      return out.copy(ship!.doorCenter).addScaledVector(ship!.doorNormal, 1.3);
    case 'stranger': {
      // to its side, from wherever the creature comes
      const c = stranger!.center;
      const dx = creature.pos.x - c.x;
      const dz = creature.pos.z - c.z;
      const l = Math.hypot(dx, dz) || 1;
      return out.set(c.x + (dx / l) * 1.7, 0, c.z + (dz / l) * 1.7);
    }
    case 'pod':
      return peek!.approachPoint(u.site, creature.pos, out);
    case 'hatch':
      return out.copy(inside ? station!.interior.spawn : station!.doorOutside);
    case 'card':
      return out.copy(u.card.mesh.position);
    case 'reader':
      return out.copy(station!.interior.reader.stand);
  }
}

/** What to look at on the way over. */
function usePoint(u: Usable, out: Vector3) {
  switch (u.kind) {
    case 'tracker':
      return out.copy(tracker!.position);
    case 'pad':
      return out.copy(ship!.padCenter);
    case 'door':
      return out.copy(ship!.doorCenter);
    case 'stranger':
      return stranger!.headPosition(out);
    case 'pod':
      return out.copy(u.site.lookPoint);
    case 'hatch':
      return out.copy(station!.doorOutside).addScaledVector(station!.interior.inward, 1.2).setY(station!.interior.floorY + 0.8);
    case 'card':
      return out.copy(u.card.mesh.position);
    case 'reader':
      return out.copy(station!.interior.reader.look);
  }
}

/** Close enough to start: `d` from the walk's end; `stuck` when it can get no nearer. */
function canUse(u: Usable, d: number, stuck: boolean) {
  switch (u.kind) {
    case 'tracker':
    case 'pod':
      return d < 0.12 || (stuck && d < 0.9);
    case 'pad':
      return nearPad();
    case 'door':
      return !!doorScene && doorScene.canStart(creature.pos) && (near(ship!.doorCenter.x, ship!.doorCenter.z, 1.8) || stuck);
    case 'stranger':
      return near(stranger!.center.x, stranger!.center.z, stuck ? 2.6 : 2.2);
    case 'hatch':
      return d < 0.3 || (stuck && d < 1.3);
    case 'card':
      return d < 0.4 || (stuck && d < 1.1);
    case 'reader':
      return d < 0.3 || (stuck && d < 1.0);
  }
}

function use(u: Usable) {
  going = null;
  switch (u.kind) {
    case 'tracker':
      pickup!.begin();
      break;
    case 'pad':
      padMode = true;
      break;
    case 'door':
      doorScene!.begin();
      break;
    case 'stranger':
      stranger!.interact();
      break;
    case 'pod':
      peek!.begin(u.site);
      break;
    case 'hatch':
      beginHatch(inside);
      break;
    case 'card':
      // stoop and take it
      grabT = 0.55;
      grabAt.copy(u.card.mesh.position);
      cards!.grab(u.card);
      break;
    case 'reader':
      cards!.insertAll();
  }
}

/** Walk over to it and use it (straight away, if already there). */
function goUse(u: Usable) {
  const to = useSpot(u, new Vector3());
  going = { use: u, to, best: Infinity, stuck: 0, time: 0 };
  if (canUse(u, Math.hypot(to.x - creature.pos.x, to.z - creature.pos.z), false)) use(u);
}

const smooth = (w: number) => w * w * (3 - 2 * w);
/** Going through the airlock: how long the view takes to go dark, and to come back. */
const HATCH_DARK = 0.35;
const HATCH_LIGHT = 0.5;

/** Close enough to the keypad to use it. */
function nearPad() {
  return !!ship && Math.hypot(creature.pos.x - ship.padCenter.x, creature.pos.z - ship.padCenter.z) < 2.4;
}
// sound waits for the click that wakes the creature, so it can swell in
input.onGesture(() => {
  if (!wake.active) audio.start();
});
input.onWheel((dir) => pr.zoom(dir));
window.addEventListener('resize', () => pr.resize());
canvas.focus();

const focusTarget = new Vector3();
const camDyn = new DynVec3(0.9, 1, 0, new Vector3(creature.pos.x, creature.pos.y + 0.6, creature.pos.z));
if (wake.active) camDyn.reset(wake.focus(new Vector3()));
const mouseGround = new Vector3();
const encounterFocus = new Vector3();
const shaken = new Vector3();
const lookPoint = new Vector3();
const wanderPoint = new Vector3();
let wanderTimer = 0;
let skidSound = 0;
const control: CreatureInput = { move: new Vector2(), sprint: false, crouch: false, look: null };

const bootTime = performance.now();
let last = bootTime;
let wokeAt = -1;
/** Debug: hide the opening's darkness and blur to inspect the animation. */
let fxOff = false;
/** Debug: extra camera zoom, to inspect animation up close. */
let debugZoom = 1;
let debugFocus: Vector3 | null = null;
let elapsed = 0;

let paused = false;

function frame(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (!paused) update(dt, now);
  draw(now);
  // compile every shader the opening needs in the background first (the screen
// stays dark meanwhile), so the first frame never stalls the page
pr.precompile(scene).finally(() => requestAnimationFrame(frame));
}

function update(dt: number, now: number) {
  elapsed += dt;
  streamWorld();
  shared.uTime.value = elapsed;

  // wind drives sound, sand and clouds
  wind.update(dt);
  shared.uWindStrength.value = wind.strength;
  shared.uWindDir.value.copy(wind.dir);
  shared.uWindTravel.value = wind.travel;
  shared.uCloudOffset.value.addScaledVector(wind.dir, -dt * 0.016 * (0.9 + wind.strength * 1.5));

  if (wake.active) {
    wake.update(dt);
    if (!wake.active) {
      // control is ours: keep the freshly faded-in cursor on screen for a moment
      input.lastMouseMove = now;
      input.crouch = false;
      wokeAt = now;
    }
    rocks.update(creature.pos.x, creature.pos.z);
    finishFrame(dt, wake.focus(focusTarget));
    return;
  }
  respawnFade = Math.max(0, respawnFade - dt / 1.4);
  if (strike.active) {
    // the strike: the world slows almost to a stop, then crawls on round the body
    strike.update(dt);
    const g = dt * strike.timeScale;
    rocks.update(creature.pos.x, creature.pos.z);
    finishFrame(g, strike.focus(focusTarget));
    if (strike.done) respawn();
    return;
  }
  if (doorScene?.active) {
    padMode = false;
    doorScene.update(dt);
    rocks.update(creature.pos.x, creature.pos.z);
    finishFrame(dt, doorScene.focus(focusTarget));
    return;
  }
  if (pickup?.active) {
    pickup.update(dt);
    rocks.update(creature.pos.x, creature.pos.z);
    finishFrame(dt, pickup.focus(focusTarget));
    return;
  }
  if (peek?.active) {
    peek.update(dt);
    rocks.update(creature.pos.x, creature.pos.z);
    finishFrame(dt, peek.focus(focusTarget));
    return;
  }
  if (hatchMove) {
    // through the airlock: the view goes dark, the creature steps through, the view comes back
    const h = hatchMove;
    h.t += dt;
    if (!h.swapped && h.t >= HATCH_DARK) {
      h.swapped = true;
      setInside(!h.out);
    }
    control.move.set(0, 0);
    control.sprint = false;
    control.crouch = false;
    control.look = null;
    creature.update(dt, control, world);
    if (h.t >= HATCH_DARK + HATCH_LIGHT) hatchMove = null;
    focusTarget.set(creature.pos.x, creature.pos.y + 0.6, creature.pos.z);
    finishFrame(dt, focusTarget);
    return;
  }

  // holding the button with the tracker in hand raises it to look at
  if (press.down) {
    press.t += dt;
    if (!tracker?.carried) endPress();
    else if (press.t > 0.18 && !press.out) {
      press.out = true;
      creature.holdOut = 1;
      audio.trackerRaise(0.06);
    }
  }
  // walking over to use something: any move of the player's own calls it off
  if (going && (input.move.lengthSq() > 0 || !stillUsable(going.use) || stranger?.busy || padMode)) going = null;

  // where the creature looks
  const mouseIdle = now - input.lastMouseMove;
  let look: Vector3 | null = null;
  if (input.hasMouse) {
    pr.screenToGround(input.mouse.x, input.mouse.y, groundHeight, mouseGround);
  }
  // stepping away (or the door cracking open behind its work) ends using the keypad
  if (padMode && (input.move.lengthSq() > 0 || !ship || ship.state === 'cracked' || !nearPad())) padMode = false;
  const holding = (stranger?.busy ?? false) || padMode;
  creature.glance = 0;
  const droneNear = drone.active && !drone.prey && !inside && drone.position.distanceTo(creature.pos) < 26;
  let droneBehind = false;
  if (droneNear) {
    const rel = Math.atan2(drone.position.x - creature.pos.x, drone.position.z - creature.pos.z) - creature.yaw;
    droneBehind = Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel))) > 1.5 && creature.speed > 1.2;
    if (droneBehind) {
      // running from it: a quick look back over its shoulder now and then
      if (glanceT > 0) glanceT -= dt;
      else {
        glanceWait -= dt;
        if (glanceWait <= 0) {
          glanceT = 0.55 + Math.random() * 0.35;
          glanceWait = 1.6 + Math.random() * 2.2;
        }
      }
    } else glanceT = 0;
  }
  if (grabT > 0) {
    look = lookPoint.copy(grabAt);
  } else if (droneNear && (!droneBehind || glanceT > 0)) {
    // it cannot look away from it
    look = lookPoint.copy(drone.position);
    if (droneBehind) creature.glance = 1;
  } else if (specimen?.creature && specimen.alive && specimen.creature.pos.distanceTo(creature.pos) < 9) {
    // the thing from the tank
    look = specimen.chest(lookPoint);
  } else if (padMode) {
    look = lookPoint.copy(ship!.padCenter);
  } else if (tracker && creature.holdOut > 0) {
    look = lookPoint.copy(tracker.position);
  } else if (going) {
    look = usePoint(going.use, lookPoint);
  } else if (holding) {
    // kneeling by the stranger: eyes on it, whatever the mouse is doing
    look = stranger!.headPosition(lookPoint);
  } else if (noticeTime > 0) {
    // the first sight of the wreck (or of the stranger) turns the head, whatever the mouse is doing
    noticeTime -= dt;
    look = noticeWhat === 'stranger' ? stranger!.headPosition(lookPoint) : lookPoint.copy(noticeWhat!.lookPoint);
  } else if (input.hasMouse && mouseIdle < 7000) {
    look = lookPoint.copy(mouseGround);
  } else if (stranger && stranger.distance < 7) {
    look = stranger.headPosition(lookPoint);
  } else if (ship && ship.distance < 14) {
    look = lookPoint.copy(ship.state === 'locked' && nearPad() ? ship.padCenter : ship.lookPoint);
  } else if (site2 && site2.distance < 12) {
    look = lookPoint.copy(site2.lookPoint);
  } else if (site && site.distance < 16) {
    look = lookPoint.copy(site.lookPoint);
  } else if (creature.speed < 0.2) {
    // nobody is steering the gaze: glance around the desert now and then
    wanderTimer -= dt;
    if (wanderTimer <= 0) {
      wanderTimer = 2 + Math.random() * 4;
      const a = creature.yaw + (Math.random() - 0.5) * 2.6;
      const d = 2.5 + Math.random() * 7;
      wanderPoint.set(creature.pos.x + Math.sin(a) * d, 0, creature.pos.z + Math.cos(a) * d);
      wanderPoint.y = terrainHeight(wanderPoint.x, wanderPoint.z);
    }
    look = lookPoint.copy(wanderPoint);
  }

  control.move.copy(input.move);
  control.sprint = input.sprint;
  // sprinting stands the creature back up
  if (input.crouch && input.sprint && control.move.lengthSq() > 0) input.crouch = false;
  control.crouch = input.crouch;
  control.look = look;
  if (holding) {
    control.move.set(0, 0);
    control.sprint = false;
    control.crouch = !padMode;
    if (padMode) {
      // step to the keypad's door side, so the creature does not block the view of it
      const dx = ship!.padStand.x - creature.pos.x;
      const dz = ship!.padStand.z - creature.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.08) control.move.set((dx / d) * Math.min(0.7, d * 2), (-dz / d) * Math.min(0.7, d * 2));
    }
  }
  if (grabT > 0) {
    grabT -= dt;
    control.move.set(0, 0);
    control.sprint = false;
    control.crouch = true;
  }
  if (going) {
    const g = going;
    g.time += dt;
    const dx = g.to.x - creature.pos.x;
    const dz = g.to.z - creature.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < g.best - 0.01) {
      g.best = d;
      g.stuck = 0;
    } else g.stuck += dt;
    control.sprint = false;
    control.crouch = false;
    if (canUse(g.use, d, g.stuck > 0.4)) use(g.use);
    else if (g.stuck > 1.5 || g.time > 30) going = null;
    else if (d > 0.02) control.move.set((dx / d) * Math.min(1, d * 2.2), (-dz / d) * Math.min(1, d * 2.2));
  }
  creature.faceYaw = null;
  if (creature.holdOut > 0) {
    // looking down at it: an unhurried walk, or standing and turning on the spot toward the cursor
    control.move.multiplyScalar(0.55);
    control.sprint = false;
    const dx = mouseGround.x - creature.pos.x;
    const dz = mouseGround.z - creature.pos.z;
    if (input.hasMouse && Math.hypot(dx, dz) > 0.35) spinYaw = Math.atan2(dx, dz);
    creature.faceYaw = spinYaw ?? creature.yaw;
  } else spinYaw = null;
  // what the cursor is over: something to walk to and use, the tracker in hand, a keypad button
  hoverUse = input.hasMouse && !holding ? usableAt(input.mouse, mouseGround) : null;
  deviceHover = !!tracker?.carried && input.hasMouse && tracker.screenDistance(input.mouse, pr.camera) < DEVICE_PX;
  if (ship) ship.hover = padMode && input.hasMouse ? ship.buttonAt(input.mouse, pr.camera) : -1;
  creature.update(dt, control, world);

  for (const ev of creature.events) {
    audio.step(ev);
    // the deck takes no prints and throws up no sand
    if (inside) continue;
    footprints.add(ev.x, ev.y, ev.z, ev.yaw, elapsed, 1 - ev.crouch * 0.15);
    const sp = Math.max(creature.speed, 0.001);
    const amount = Math.round(ev.run * 7 + (ev.speed > 1.5 ? 1 : 0) + (ev.scuff ? 1 : 0));
    if (amount > 0) dust.kick(ev.x, ev.y, ev.z, creature.vel.x / sp, creature.vel.z / sp, amount, 0.4 + ev.run);
  }
  // walking out through the doorway goes outside
  if (inside && station && !hatchMove && station.interior.atDoor(creature.pos)) beginHatch(true);
  for (const cue of creature.cues) audio.cue(cue);

  // digging in hard to stop throws sand forward
  const skid = creature.skid;
  if (skid > 0 && !inside && Math.random() < skid * dt * 40) {
    const sp = Math.max(creature.speed, 0.001);
    dust.kick(creature.pos.x, creature.pos.y, creature.pos.z, -creature.vel.x / sp, -creature.vel.z / sp, 2, 0.6 + skid);
  }
  skidSound = Math.max(0, skidSound - dt);
  if (skid > 0.35 && skidSound === 0) {
    audio.scuff(skid);
    skidSound = 0.5;
  }

  rocks.update(creature.pos.x, creature.pos.z);

  // camera: lead the motion a little and lean toward the cursor
  focusTarget.set(creature.pos.x, creature.pos.y + 0.6, creature.pos.z);
  focusTarget.addScaledVector(creature.vel, 0.32);
  if (input.hasMouse) {
    const bx = clamp((mouseGround.x - creature.pos.x) * 0.1, -1.5, 1.5);
    const bz = clamp((mouseGround.z - creature.pos.z) * 0.1, -1.5, 1.5);
    focusTarget.x += bx;
    focusTarget.z += bz;
  }
  if (ship && padWeight > 0) {
    // using the keypad: close in on it so the glyphs can be read
    const e = padWeight * padWeight * (3 - 2 * padWeight);
    focusTarget.lerp(encounterFocus.copy(ship.padCenter).setY(ship.padCenter.y - 0.1), e);
  }
  const eH = tracker?.carried ? smooth(saturate(creature.holdDyn.y)) : 0;
  if (tracker && eH > 0) {
    // held out to look at: lean the view in toward it
    focusTarget.lerp(encounterFocus.copy(tracker.position), 0.35 * eH);
  }
  if (drone.active && drone.position.distanceTo(creature.pos) < 14) {
    // keep it in view
    focusTarget.lerp(drone.position, 0.3);
  }
  if (specimen?.creature && specimen.phase !== 'dead' && specimen.creature.pos.distanceTo(creature.pos) < 10) {
    focusTarget.lerp(specimen.creature.pos, 0.25);
  }
  if (stranger && stranger.weight > 0) {
    // the encounter draws the camera in between the two of them
    const w = stranger.weight;
    focusTarget.lerp(stranger.focus(creature.pos, encounterFocus), w);
  }
  finishFrame(dt, focusTarget);
}

/**
 * The drone, every frame whatever else is going on (it never freezes): it
 * comes a few seconds after the creature leaves the station; it hunts the
 * creature, but holds off while the creature is inside, busy, or while the
 * thing from the tank is being let out; once that thing is out on the sand,
 * it goes for it instead, and then it is done.
 */
function updateDrone(dt: number) {
  const prey = !!specimen && specimen.phase === 'outside' && specimen.outside > 0.5;
  if (droneWait > 0 && !droneDone) {
    droneWait -= dt;
    // it waits for the creature to come out again
    if (droneWait <= 0 && inside) droneWait = 0.5;
    else if (droneWait <= 0 && station) droneLaunch();
  }
  // the thing on the sand draws it in, whether it was already out or not
  if (prey && !drone.active && !droneDone && station) droneLaunch();
  if (!drone.active) return;
  const scene = !!(doorScene?.active || pickup?.active || peek?.active || hatchMove || grabT > 0 || strike.active);
  const releasing = !!specimen && specimen.started && !prey && specimen.phase !== 'dead';
  if (prey) specimen!.chest(chest);
  else if (inside && station) chest.copy(station.doorOutside).addScaledVector(station.interior.inward, -5).setY(station.doorOutside.y + 1);
  else creature.rig.chest.getWorldPosition(chest);
  const allow = prey || (!inside && !scene && !releasing);
  drone.update(dt, chest, prey ? zero : creature.vel, creature.pos, station ? station.center : null, allow, prey);
  if (drone.hit) {
    drone.hit = false;
    if (drone.prey && specimen?.creature) {
      // it takes the thing from the tank instead; the creature is safe from it now
      specimen.kill();
      npcStrike.begin(drone.hitAt, drone.hitDir, specimen.creature, 'other');
      droneDone = true;
      droneWait = -1;
    } else {
      going = null;
      strike.begin(drone.hitAt, drone.hitDir, creature);
    }
  }
}
const zero = new Vector3();

function droneLaunch() {
  const st = station!;
  drone.launch(new Vector3(st.center.x - HIGH.ox * 34, st.center.y + 16, st.center.z - HIGH.oz * 34));
}

/** Camera, streamed world, particles and sound: shared by play and the opening. */
function finishFrame(dt: number, target: Vector3) {
  site?.update(dt, elapsed, wind, creature.pos);
  if (site?.justDiscovered && !wake.active) {
    audio.stinger();
    noticeTime = 2.8;
    noticeWhat = site;
  }
  site2?.update(dt, elapsed, wind, creature.pos);
  if (site2?.justDiscovered && !wake.active) {
    noticeTime = 2.2;
    noticeWhat = site2;
  }
  if (stranger) {
    stranger.update(dt, creature.pos);
    if (stranger.justSeen && !wake.active) {
      audio.sorrow();
      noticeTime = 3;
      noticeWhat = 'stranger';
    }
    if (stranger.justFoundDead) {
      // back at its side, and it is gone
      audio.sorrow();
      noticeTime = 3.5;
      noticeWhat = 'stranger';
    }
  }
  if (ship) {
    ship.update(dt, elapsed, wind, creature.pos);
    // its tune opened the door, and it was the last thing it had
    if (ship.justSolved) stranger?.die();
    if (ship.justDiscovered && !wake.active) {
      audio.stinger();
      noticeTime = 3;
      noticeWhat = ship;
    }
  }
  insideW = Math.min(1, Math.max(0, insideW + (inside ? dt * 2.5 : -dt * 2.5)));
  if (station) station.update(dt, elapsed, creature.pos, inside ? Math.max(insideW, 0.6) : 0);
  audio.setIndoors(insideW);
  if (fallen) fallen.update(dt, creature.pos);
  if (locusts) locusts.update(dt, creature.pos, creature.speed, !inside);
  if (cards) {
    cards.update(dt, elapsed, rocks.nearby);
    if (cards.justCompleted && specimen) {
      specimen.begin();
      noticeTime = 2;
      noticeWhat = { lookPoint: station!.interior.tank.at.clone().setY(station!.interior.tank.at.y + 1) };
    }
  }
  if (specimen) specimen.update(dt, elapsed, creature.pos);
  updateDrone(dt);
  npcStrike.update(dt);
  if (npcStrike.active && specimen) specimen.follow();
  if (fallen && !fallenSeen && !wake.active && Math.hypot(creature.pos.x - fallen.lookPoint.x, creature.pos.z - fallen.lookPoint.z) < 10) {
    // the three of them, lined up against the wall
    fallenSeen = true;
    audio.sorrow();
    noticeTime = 4;
    noticeWhat = fallen;
  }
  if (highlands) {
    highlands.update(dt, creature.pos, wind);
    if (highlands.justDiscovered && !wake.active) {
      audio.vista();
      noticeTime = 3.5;
      noticeWhat = highlands;
    }
  }
  if (doorScene && !doorScene.active) doorScene.update(dt); // eases the camera back out
  if (pickup && !pickup.active) pickup.update(dt);
  if (peek && !peek.active) peek.update(dt);
  tracker?.update(dt, creature, creature.pos);
  padWeight = Math.min(1, Math.max(0, padWeight + (padMode ? dt * 1.4 : -dt * 1.8)));
  // close in and quieten the world for the moments that need it
  const sm = (w: number) => w * w * (3 - 2 * w);
  const eS = sm(stranger?.weight ?? 0);
  const eP = sm(padWeight);
  const eD = sm(doorScene?.weight ?? 0);
  const eK = sm(Math.max(pickup?.weight ?? 0, peek?.weight ?? 0));
  const eH = tracker?.carried ? sm(saturate(creature.holdDyn.y)) : 0;
  const eI = sm(insideW);
  const eX = sm(strike.fade);
  if (!wake.active) pr.zoomMul = (1 + 0.32 * eS) * (1 + 3.1 * eP) * (1 + 0.4 * eD) * (1 + 0.45 * eK) * (1 + 0.6 * eH) * (1 + 0.8 * eI) * (1 + 0.8 * eX) * debugZoom;
  audio.duck(1 - 0.45 * eS - 0.3 * eP - 0.2 * eD - 0.15 * eK - 0.3 * eH);
  const focus = camDyn.update(dt, debugFocus ?? target);
  // a blast at the ship shakes the ground
  const npcShake = npcStrike.active && specimen?.creature ? npcStrike.shake * 1.4 / (1 + specimen.creature.pos.distanceTo(creature.pos) * 0.15) : 0;
  const shake = Math.max(ship ? ship.shake : 0, strike.shake * 1.8, npcShake);
  if (shake > 0.01) {
    shaken.copy(focus);
    shaken.x += (Math.random() - 0.5) * 0.3 * shake;
    shaken.z += (Math.random() - 0.5) * 0.3 * shake;
    pr.setFocus(shaken);
  } else pr.setFocus(focus);
  terrain.follow(focus.x, focus.z);
  pr.updateShadow(creature.pos);

  const hv = pr.halfView;
  const halfDepth = hv.h / Math.sin(pr.pitch);
  streaks.update(dt, wind, focus.x, focus.z, hv.w, halfDepth, terrainHeight);
  dust.update(dt, wind, terrainHeight);

  audio.update(dt, wind, {
    value: creature.breath,
    exertion: creature.exertion,
    wheeze: Math.max(creature.strain, creature.tired * 0.6),
  });
}

function draw(now: number) {
  const mouseIdle = now - input.lastMouseMove;
  pr.cursorScreen.copy(input.mouse);
  const idleAlpha = input.hasMouse ? saturate(1 - (mouseIdle - 1600) / 400) : 0;
  if (wake.active) {
    // the cursor fades in with the creature's senses, wherever the mouse is
    pr.cursorAlpha = input.hasMouse ? wake.cursorAlpha : 0;
  } else {
    pr.cursorAlpha = idleAlpha;
    pr.cursorGlow = hoverUse || deviceHover || (padMode && ship!.hoveredButton >= 0) ? 1 : 0;
    if (wokeAt < 0) {
      // skipped the opening: a short fade in from black
      pr.dark = 1 - saturate((now - bootTime) / 1400);
      pr.blur = pr.ghost = pr.desat = pr.vignette = 0;
    } else {
      pr.dark = pr.blur = pr.ghost = pr.desat = pr.vignette = 0;
    }
  }
  if (strike.active) {
    // the colour drains away, the edges darken and blur, then it all goes dark
    pr.desat = Math.max(pr.desat, strike.fade * 0.92);
    pr.vignette = Math.max(pr.vignette, strike.fade);
    pr.blur = Math.max(pr.blur, strike.fade * 0.35);
    pr.dark = Math.max(pr.dark, strike.dark);
  }
  pr.dark = Math.max(pr.dark, respawnFade);
  if (hatchMove) {
    const t = hatchMove.t;
    const k = t < HATCH_DARK ? t / HATCH_DARK : 1 - (t - HATCH_DARK) / HATCH_LIGHT;
    pr.dark = Math.max(pr.dark, Math.min(1, Math.max(0, k)) * 0.97);
  }
  if (fxOff) pr.dark = pr.blur = pr.ghost = pr.desat = pr.vignette = 0;
  pr.render(scene);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  (window as unknown as Record<string, unknown>).__akrida = {
    creature,
    world,
    pr,
    wind,
    input,
    audio,
    wake,
    get site() {
      return site;
    },
    get stranger() {
      return stranger;
    },
    get site2() {
      return site2;
    },
    get ship() {
      return ship;
    },
    get doorScene() {
      return doorScene;
    },
    get padMode() {
      return padMode;
    },
    get tracker() {
      return tracker;
    },
    get pickup() {
      return pickup;
    },
    get highlands() {
      return highlands;
    },
    /** Make everything at once, now (for tests): resolves when all of it is in the scene. */
    async buildAll() {
      for (const p of pending.splice(0)) builder.add(p.make());
      while (builder.busy) {
        builder.run(50);
        await new Promise((r) => setTimeout(r, 0));
      }
      highlands?.place(60000);
    },
    get station() {
      return station;
    },
    get inside() {
      return inside;
    },
    drone,
    strike,
    npcStrike,
    get cards() {
      return cards;
    },
    get specimen() {
      return specimen;
    },
    get checkpoint() {
      return checkpoint;
    },
    /** Send the drone now. */
    launchDrone() {
      droneWait = 0.001;
    },
    /** Step into (or out of) the station at once. */
    goInside(on = true) {
      setInside(on);
      insideW = on ? 1 : 0;
    },
    get fallen() {
      return fallen;
    },
    get locusts() {
      return locusts;
    },
    HIGH,
    get peek() {
      return peek;
    },
    get press() {
      return { ...press, going: going?.use.kind ?? null, deviceHover };
    },
    get hovers() {
      return { use: hoverUse?.kind ?? null, deviceHover, nearPad: nearPad(), going: going?.use.kind ?? null };
    },
    SITE3,
    SITE2,
    crater: { craterHeight, siteMask },
    shared,
    dustCount: () => dust.count,
    closeUp(m: number) {
      debugZoom = m;
    },
    focusOn(x: number | null, z = 0) {
      debugFocus = x === null ? null : new Vector3(x, world.height(x, z) + 0.3, z);
    },
    fx(on: boolean) {
      fxOff = !on;
    },
    /** Freeze the clock and step the simulation by hand (for frame captures). */
    pause(p: boolean) {
      paused = p;
    },
    advance(steps: number, dt = 1 / 60) {
      for (let i = 0; i < steps; i++) update(dt, performance.now());
    },
    screenPos() {
      const p = new Vector3(creature.pos.x, creature.pos.y + 0.7, creature.pos.z).project(pr.camera);
      return [((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight];
    },
    teleport(x: number, z: number) {
      creature.teleport(x, z, world);
      camDyn.reset(new Vector3(x, creature.pos.y + 0.6, z));
    },
  };
}
