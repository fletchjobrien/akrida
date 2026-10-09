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
import { CRATER_REACH, craterHeight, POD_DIR, SITE, SITE2, siteMask, SKID, SKIP_REACH, TRENCH_LENGTH } from './world/crater';
import { SiteSpawner } from './story/SiteSpawner';
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
const dust = new Dust();
scene.add(dust.mesh);

const world: World = { height: terrainHeight, rocks: rocks.nearby };
const START = new Vector2(-46, 11);
rocks.update(START.x, START.y);
const creature = new Creature(world, START.x, START.y);
creature.setYaw(1.0);
creature.snap = (p, out) => pr.snapDelta(p, out);
scene.add(creature.rig.root);

const wind = new Wind();
const audio = new AudioEngine();
// the wreck turns up ahead of the player once they have wandered and held a heading
let site: CrashSite | null = null;
const spawner = new SiteSpawner();
// a second pod lands near the first, and its survivor lies at the end of a trail
let site2: CrashSite | null = null;
let stranger: Stranger | null = null;

interface SecondPodLayout {
  pod: Vector2;
  slide: Vector2;
  end: Vector2;
  mid: Vector2;
  axis: Vector2;
  skid: Vector2[];
  score: number;
}

/** How far the second pod lies from the crater, and its survivor's trail from the pod. */
const POD2_DISTANCE = 26;
const TRAIL_LENGTH = 22;

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
  const side = Math.random() < 0.5 ? -1 : 1;
  let best: SecondPodLayout | null = null;
  let bestScore = -Infinity;
  function layout(deg: number, slideAngle: number, slideSign: number, bend: number): SecondPodLayout | null {
    const u = rot(h.x, h.y, side * deg * (Math.PI / 180));
    const pod = u.clone().multiplyScalar(POD2_DISTANCE);
    const tw = rot(...(u.clone().multiplyScalar(0.5).add(h).normalize().toArray() as [number, number]), bend);
    const end = pod.clone().addScaledVector(tw, TRAIL_LENGTH);
    const mid = pod.clone().addScaledVector(tw, TRAIL_LENGTH / 2);
    for (const p of [pod, mid, end, pod.clone().addScaledVector(tw, TRAIL_LENGTH / 4), pod.clone().addScaledVector(tw, (TRAIL_LENGTH * 3) / 4)]) {
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
    return { pod, slide, end, mid, axis, skid, score };
  }
  for (const deg of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
    for (const bend of [0, 0.3, -0.3]) {
      for (const a of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
        for (const sgn of [1, -1]) {
          const l = layout(deg, a, sgn, bend);
          if (l && l.score > bestScore) {
            bestScore = l.score;
            best = l;
          }
        }
      }
    }
    if (best) break;
  }
  return best as SecondPodLayout | null;
}

/** Put the crash site just out of sight in the direction of travel. */
function spawnSite() {
  spawner.done = true;
  const h = spawner.heading;
  // how far the visible ground reaches along the heading: trace the screen's edge onto the terrain
  let reach = 0;
  const edgePoint = new Vector3();
  const W = window.innerWidth;
  const H = window.innerHeight;
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    for (const [sx, sy] of [
      [u * W, 0],
      [u * W, H],
      [0, u * H],
      [W, u * H],
    ]) {
      pr.screenToGround(sx, sy, terrainHeight, edgePoint);
      reach = Math.max(reach, (edgePoint.x - creature.pos.x) * h.x + (edgePoint.z - creature.pos.z) * h.y);
    }
  }
  reach += 2.5; // the camera keeps drifting ahead a little
  // the pod lies nose-right, so the skid always comes in from the left, along its axis
  const dx = POD_DIR.x;
  const dz = POD_DIR.y;
  // push the crater out until all of it, trench included, is beyond the visible ground
  let need = CRATER_REACH;
  for (const t of [-0.15, 1.02]) {
    for (const s of [-6, 6]) {
      const ox = -dx * t * TRENCH_LENGTH - dz * s;
      const oz = -dz * t * TRENCH_LENGTH + dx * s;
      need = Math.max(need, -(ox * h.x + oz * h.y));
    }
  }
  const plan = planSecondPod(h);
  if (plan) {
    for (const [p, r] of [[plan.pod, 6.5], [plan.mid, 6.5], [plan.end, 6.5], ...plan.skid.map((k) => [k, 5] as const)] as const) {
      need = Math.max(need, -(p.x * h.x + p.y * h.y) + r);
    }
  }
  const d = reach + need + 0.8;
  const cx = creature.pos.x + h.x * d;
  const cz = creature.pos.z + h.y * d;
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
  }
}
/** Seconds left of the creature staring at something it has just noticed. */
let noticeTime = 0;
let noticeWhat: CrashSite | 'stranger' | null = null;
/** The cursor is over the stranger, close enough to reach. */
let strangerHover = false;
const input = new Input(canvas);
const params = new URLSearchParams(location.search);

// The opening: lying limp in the sand until the player clicks.
const wake = new WakeUp(creature, world, pr, audio, dust, footprints, () => elapsed);
if (params.has('skipintro')) wake.skip();
const clickGround = new Vector3();
window.addEventListener('pointerdown', (e) => {
  wake.begin();
  // kneel by the stranger: judged where the click lands, not where the cursor was last frame
  if (e.button !== 0 || !stranger || wake.active || stranger.busy) return;
  pr.screenToGround(e.clientX, e.clientY, terrainHeight, clickGround);
  if (stranger.canInteract(creature.pos, clickGround)) stranger.interact();
});
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

  // where the creature looks
  const mouseIdle = now - input.lastMouseMove;
  let look: Vector3 | null = null;
  if (input.hasMouse) {
    pr.screenToGround(input.mouse.x, input.mouse.y, terrainHeight, mouseGround);
  }
  const holding = stranger?.busy ?? false;
  if (holding) {
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
    control.crouch = true;
  }
  strangerHover = !!stranger && input.hasMouse && !holding && stranger.canInteract(creature.pos, mouseGround);
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
  if (stranger && stranger.weight > 0) {
    // the encounter draws the camera in between the two of them
    const w = stranger.weight;
    focusTarget.lerp(stranger.focus(creature.pos, encounterFocus), w);
  }
  finishFrame(dt, focusTarget);
}

/** Camera, streamed world, particles and sound: shared by play and the opening. */
function finishFrame(dt: number, target: Vector3) {
  if (!wake.active && spawner.update(dt, creature.vel.x, creature.vel.z)) spawnSite();
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
    // close in a little and quieten the world while it sings
    const w = stranger.weight;
    const e = w * w * (3 - 2 * w);
    if (!wake.active) pr.zoomMul = (1 + 0.32 * e) * debugZoom;
    audio.duck(1 - 0.45 * e);
  }
  const focus = camDyn.update(dt, debugFocus ?? target);
  pr.setFocus(focus);
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
    pr.cursorGlow = strangerHover ? 1 : 0;
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
    SITE2,
    spawner,
    spawnSite,
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
