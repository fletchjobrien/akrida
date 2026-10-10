import { Scene, Vector2, Vector3 } from 'three';
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
import { Tracker } from './world/tracker';
import { StainMap } from './world/stains';
import { Stranger } from './story/Stranger';

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

const world: World = { height: terrainHeight, rocks: rocks.nearby };
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
let doorHover = false;
let padHover = false;
let stranger: Stranger | null = null;
// the tracker left in the ship's doorway, and taking it up
let tracker: Tracker | null = null;
let pickup: PickupScene | null = null;
/** Walking up to the tracker to take it. */
let approach = false;
let approachTime = 0;
/** The nearest it has come, and for how long it has come no nearer (blocked by the hull or a rock). */
let approachBest = Infinity;
let approachStuck = 0;
const approachTo = new Vector3();
/** The left button while the tracker is in hand: a click on it drops it, holding raises it to look at. */
const press = { down: false, t: 0, onDevice: false, out: false };
let deviceHover = false;
/** Holding the tracker out: the way the cursor turns the creature. */
let spinYaw: number | null = null;
/** How near the cursor (CSS pixels) must be to the tracker to use it, and how far the creature walks to it. */
const DEVICE_PX = 30;
const DEVICE_WALK = 7;

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
    }
  }
  rocks.refresh();
  site = new CrashSite(rocks, dust, audio, 'first');
  scene.add(site.group);
  if (plan) {
    site2 = new CrashSite(rocks, dust, audio, 'second');
    scene.add(site2.group);
    const axis = { x: plan.axis.x, z: plan.axis.y };
    stranger = new Stranger(world, SITE2.ex, SITE2.ez, axis, rocks, dust, audio, (p, o) => pr.snapDelta(p, o));
    scene.add(stranger.creature.rig.root);
    // keep the dunes and rocks off the trail where it actually bends
    const path = stranger.trailPath(site2.hatchGround);
    SITE2.mx = path.mid.x;
    SITE2.mz = path.mid.z;
    shared.uSite2Trail.value.set(SITE2.mx, SITE2.mz, SITE2.ex, SITE2.ez);
    rocks.refresh();
    // the map of blood and marks covers the trail and the body
    const xs = [site2.hatchGround.x, path.control.x, path.end.x, SITE2.ex];
    const zs = [site2.hatchGround.z, path.control.z, path.end.z, SITE2.ez];
    const minX = Math.min(...xs) - 3;
    const minZ = Math.min(...zs) - 3;
    const size = Math.max(Math.max(...xs) + 3 - minX, Math.max(...zs) + 3 - minZ);
    const stains = new StainMap(minX, minZ, size);
    stranger.paint(stains, site2.hatchGround);
    if (SITE3.on) {
      ship = new Ship(rocks, dust, audio);
      ship.addTo(scene);
      doorScene = new DoorScene(creature, world, ship, audio, dust);
      tracker = new Tracker(ship, dust, audio, rocks.nearby);
      tracker.addTo(scene);
      pickup = new PickupScene(creature, world, tracker, audio);
      rocks.refresh();
    }
  }
}
/** Seconds left of the creature staring at something it has just noticed. */
let noticeTime = 0;
let noticeWhat: { lookPoint: Vector3 } | 'stranger' | null = null;
/** The cursor is over the stranger, close enough to reach. */
let strangerHover = false;
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
  if (e.button !== 0 || wake.active || doorScene?.active || pickup?.active) return;
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
  if (ship && nearPad() && ship.state === 'locked' && ship.padAt(clickAt, pr.camera)) {
    padMode = true;
    return;
  }
  if (ship && doorScene && doorScene.canStart(creature.pos) && ship.doorAt(clickAt, pr.camera)) {
    doorScene.begin();
    return;
  }
  // the tracker where it lies: walk up to it and take it
  if (tracker && pickup && canTakeTracker(clickAt)) {
    approach = true;
    approachTime = 0;
    approachBest = Infinity;
    approachStuck = 0;
    pickup.approachPoint(creature.pos, approachTo);
    return;
  }
  // kneel by the stranger: judged where the click lands, not where the cursor was last frame
  if (!stranger || stranger.busy) return;
  pr.screenToGround(e.clientX, e.clientY, terrainHeight, clickGround);
  if (stranger.canInteract(creature.pos, clickGround)) stranger.interact();
});

function endPress() {
  press.down = false;
  creature.holdOut = 0;
}
window.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !press.down) return;
  // a quick click on it lets it go
  if (!press.out && press.onDevice && press.t < 0.3 && tracker?.carried) {
    tracker.drop(creature);
    creature.carrying = false;
  }
  endPress();
});
window.addEventListener('blur', endPress);

/** The tracker lies under the cursor, near enough to walk to and take. */
function canTakeTracker(mouse: Vector2) {
  if (!tracker || !tracker.takeable || tracker.carried) return false;
  const p = tracker.position;
  if (Math.hypot(p.x - creature.pos.x, p.z - creature.pos.z) > DEVICE_WALK) return false;
  return tracker.screenDistance(mouse, pr.camera) < DEVICE_PX;
}

const smooth = (w: number) => w * w * (3 - 2 * w);

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
  requestAnimationFrame(frame);
}

function update(dt: number, now: number) {
  elapsed += dt;
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
  // walking up to take the tracker: any move of the player's own calls it off
  if (approach && (input.move.lengthSq() > 0 || !tracker?.takeable)) approach = false;

  // where the creature looks
  const mouseIdle = now - input.lastMouseMove;
  let look: Vector3 | null = null;
  if (input.hasMouse) {
    pr.screenToGround(input.mouse.x, input.mouse.y, terrainHeight, mouseGround);
  }
  // stepping away (or the door cracking open behind its work) ends using the keypad
  if (padMode && (input.move.lengthSq() > 0 || !ship || ship.state === 'cracked' || !nearPad())) padMode = false;
  const holding = (stranger?.busy ?? false) || padMode;
  if (padMode) {
    look = lookPoint.copy(ship!.padCenter);
  } else if (tracker && (approach || creature.holdOut > 0)) {
    look = lookPoint.copy(tracker.position);
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
  if (approach && pickup) {
    approachTime += dt;
    const dx = approachTo.x - creature.pos.x;
    const dz = approachTo.z - creature.pos.z;
    const d = Math.hypot(dx, dz);
    control.sprint = false;
    control.crouch = false;
    if (d < approachBest - 0.01) {
      approachBest = d;
      approachStuck = 0;
    } else approachStuck += dt;
    if (d < 0.12 || (approachStuck > 0.35 && d < 0.8)) {
      approach = false;
      pickup.begin();
    } else if (approachTime > 6) approach = false;
    else control.move.set((dx / d) * Math.min(0.75, d * 2.2), (-dz / d) * Math.min(0.75, d * 2.2));
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
  strangerHover = !!stranger && input.hasMouse && !holding && stranger.canInteract(creature.pos, mouseGround);
  deviceHover =
    !!tracker && input.hasMouse && (tracker.carried ? tracker.screenDistance(input.mouse, pr.camera) < DEVICE_PX : canTakeTracker(input.mouse));
  // what the cursor is over at the ship: a keypad button, the keypad, the cracked door
  padHover = doorHover = false;
  if (ship && input.hasMouse) {
    ship.hover = padMode ? ship.buttonAt(input.mouse, pr.camera) : -1;
    if (!padMode && ship.state === 'locked' && nearPad()) padHover = ship.padAt(input.mouse, pr.camera);
    if (doorScene?.canStart(creature.pos)) doorHover = ship.doorAt(input.mouse, pr.camera);
  }
  creature.update(dt, control, world);

  for (const ev of creature.events) {
    footprints.add(ev.x, ev.y, ev.z, ev.yaw, elapsed, 1 - ev.crouch * 0.15);
    const sp = Math.max(creature.speed, 0.001);
    const amount = Math.round(ev.run * 7 + (ev.speed > 1.5 ? 1 : 0) + (ev.scuff ? 1 : 0));
    if (amount > 0) dust.kick(ev.x, ev.y, ev.z, creature.vel.x / sp, creature.vel.z / sp, amount, 0.4 + ev.run);
    audio.step(ev);
  }
  for (const cue of creature.cues) audio.cue(cue);

  // digging in hard to stop throws sand forward
  const skid = creature.skid;
  if (skid > 0 && Math.random() < skid * dt * 40) {
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
  if (stranger && stranger.weight > 0) {
    // the encounter draws the camera in between the two of them
    const w = stranger.weight;
    focusTarget.lerp(stranger.focus(creature.pos, encounterFocus), w);
  }
  finishFrame(dt, focusTarget);
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
  if (doorScene && !doorScene.active) doorScene.update(dt); // eases the camera back out
  if (pickup && !pickup.active) pickup.update(dt);
  tracker?.update(dt, creature, creature.pos);
  padWeight = Math.min(1, Math.max(0, padWeight + (padMode ? dt * 1.4 : -dt * 1.8)));
  // close in and quieten the world for the moments that need it
  const sm = (w: number) => w * w * (3 - 2 * w);
  const eS = sm(stranger?.weight ?? 0);
  const eP = sm(padWeight);
  const eD = sm(doorScene?.weight ?? 0);
  const eK = sm(pickup?.weight ?? 0);
  const eH = tracker?.carried ? sm(saturate(creature.holdDyn.y)) : 0;
  if (!wake.active) pr.zoomMul = (1 + 0.32 * eS) * (1 + 1.9 * eP) * (1 + 0.4 * eD) * (1 + 0.45 * eK) * (1 + 0.6 * eH) * debugZoom;
  audio.duck(1 - 0.45 * eS - 0.3 * eP - 0.2 * eD - 0.15 * eK - 0.3 * eH);
  const focus = camDyn.update(dt, debugFocus ?? target);
  // a blast at the ship shakes the ground
  const shake = ship ? ship.shake : 0;
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
    pr.cursorGlow = strangerHover || padHover || doorHover || deviceHover || (padMode && ship!.hoveredButton >= 0) ? 1 : 0;
    if (wokeAt < 0) {
      // skipped the opening: a short fade in from black
      pr.dark = 1 - saturate((now - bootTime) / 1400);
      pr.blur = pr.ghost = pr.desat = pr.vignette = 0;
    } else {
      pr.dark = pr.blur = pr.ghost = pr.desat = pr.vignette = 0;
    }
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
    get press() {
      return { ...press, approach, deviceHover };
    },
    get hovers() {
      return { padHover, doorHover, strangerHover, deviceHover, nearPad: nearPad() };
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
