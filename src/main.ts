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
creature.snap = (p, out) => pr.snapDelta(p, out);
scene.add(creature.rig.root);

const wind = new Wind();
const audio = new AudioEngine();
const input = new Input(canvas);
input.onGesture(() => audio.start());
input.onWheel((dir) => pr.zoom(dir));
window.addEventListener('resize', () => pr.resize());
canvas.focus();

const focusTarget = new Vector3();
const camDyn = new DynVec3(0.9, 1, 0, new Vector3(creature.pos.x, creature.pos.y + 0.6, creature.pos.z));
const mouseGround = new Vector3();
const lookPoint = new Vector3();
const wanderPoint = new Vector3();
let wanderTimer = 0;
let skidSound = 0;
const control: CreatureInput = { move: new Vector2(), sprint: false, crouch: false, look: null };

const bootTime = performance.now();
let last = bootTime;
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

  // where the creature looks
  const mouseIdle = now - input.lastMouseMove;
  let look: Vector3 | null = null;
  if (input.hasMouse) {
    pr.screenToGround(input.mouse.x, input.mouse.y, terrainHeight, mouseGround);
  }
  if (input.hasMouse && mouseIdle < 7000) {
    look = lookPoint.copy(mouseGround);
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
  const focus = camDyn.update(dt, focusTarget);
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
  pr.cursorAlpha = input.hasMouse ? saturate(1 - (mouseIdle - 1600) / 400) : 0;
  pr.fade = saturate((now - bootTime) / 1400);
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
