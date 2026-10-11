import { BoxGeometry, Group, Mesh, Object3D, Vector2, Vector3, type BufferGeometry, type Camera, type Material } from 'three';
import { toonMaterial } from '../render/shared';
import { rgb } from '../render/palette';
import { SHADOW_LAYER } from '../render/PixelRenderer';
import { terrainHeight } from '../world/terrain';
import { pushOutOfRock, type RockInfo } from '../world/rocks';
import type { Station } from '../world/station';
import type { Creature } from '../character/Creature';
import type { Dust } from '../world/particles';
import type { AudioEngine } from '../audio/AudioEngine';

/** The cards' colours: red, green and blue first (the three the reader takes), then the rest. */
const COLORS: [string, number][] = [
  ['red', 0xa23a32],
  ['green', 0x4a8646],
  ['blue', 0x3c5c96],
  ['yellow', 0xb0983e],
  ['orange', 0xa86a36],
  ['purple', 0x684c86],
  ['magenta', 0x904a78],
  ['cyan', 0x4a8a8e],
  ['white', 0xb4b0a4],
  ['grey', 0x5c5c5c],
  ['black', 0x2a2a2e],
  ['brown', 0x684a34],
];

type CardState = 'lying' | 'rising' | 'held' | 'falling' | 'slotting' | 'slot' | 'rejecting' | 'returning';

interface Card {
  mesh: Group;
  /** Index into COLORS: 0 red, 1 green, 2 blue fit the reader. */
  kind: number;
  inside: boolean;
  state: CardState;
  t: number;
  from: Vector3;
  to: Vector3;
  vel: Vector3;
  slot: number;
}

const GLINT = rgb(0xfffbe8).toArray();
/** The cards out on the sand are drawn a little bigger, to be seen. */
const OUTSIDE_SCALE = 1.9;

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

const ease = (k: number) => k * k * (3 - 2 * k);

/**
 * Data cards: a dozen little floppy-sized cards of coloured plastic, each with
 * a sliding metal shutter and a label, spilled through the station and out
 * by the crates when it was raided. Only one is red, one green and one blue;
 * the green one lies off on its own, out among the rocks.
 *
 * One is carried at a time, in the right hand, held out like the tracker:
 * click one and the creature stoops and takes it up. Click it (or the
 * creature) again to let it fall. Take it to the reader on the desk and the
 * creature leans in and slides it home: red, green and blue each go into
 * their own slot with a heavy ka-chunk and their ring lights; any other card
 * is refused with a buzz and pops back up into its hand. When all three are
 * in, `complete` turns true.
 */
export class DataCards {
  readonly group = new Group();
  readonly cards: Card[] = [];
  held: Card | null = null;
  complete = false;
  justCompleted = false;
  /** While true (the drone is hunting), nothing can be picked up. */
  locked = false;
  /** Whether the creature is in the station (a dropped card lands on the same side of the wall). */
  creatureInside = false;
  private readonly filled = [false, false, false];
  private glintTimer = 2;
  private nudged = false;
  private readonly tmp = new Vector3();
  private readonly push = new Vector2();
  private readonly screen = new Vector3();

  constructor(
    private readonly station: Station,
    private readonly creature: Creature,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    const t = (c: number) => {
      const k = rgb(c);
      const hex = (v: Vector3, f: number) => (Math.min(255, Math.round(v.x * f * 255)) << 16) | (Math.min(255, Math.round(v.y * f * 255)) << 8) | Math.min(255, Math.round(v.z * f * 255));
      return toonMaterial({ dark: hex(k, 0.6), mid: hex(k, 0.88), light: hex(k, 1.04), litAt: 0.5, midAt: -0.1, outline: 0.6, highlight: 0.6 });
    };
    // its light: the card's colour, lit from within
    const glow = (c: number) => {
      const k = rgb(c);
      const m = Math.max(k.x, k.y, k.z, 0.001);
      const v = (f: number) => Math.min(255, Math.round(Math.min(1, (f / m) * 0.95) * 255));
      const hex = (v(k.x) << 16) | (v(k.y) << 8) | v(k.z);
      return toonMaterial({ dark: hex, mid: hex, light: hex, unlit: true, outline: 0 });
    };
    const frame = toonMaterial({ dark: 0x18191c, mid: 0x26282c, light: 0x3c3f45, litAt: 0.5, outline: 0.6, highlight: 0.9 });
    const gold = toonMaterial({ dark: 0x6a4e1a, mid: 0xb08a34, light: 0xe8c86a, litAt: 0.5, outline: 0, highlight: 1 });
    const crystal = toonMaterial({ dark: 0x0e1418, mid: 0x1c2a32, light: 0x4a6a78, litAt: 0.45, outline: 0.3, highlight: 1 });
    for (const [k, [, color]] of COLORS.entries()) {
      const g = new Group();
      const box = (w: number, h: number, d: number, mat: Material, x: number, y: number, z: number) => {
        const m = new Mesh(faceted(new BoxGeometry(w, h, d)), mat);
        m.position.set(x, y, z);
        g.add(m);
        return m;
      };
      // a slim data shard: a coloured slab in a dark frame, chamfered at its back corners,
      // a strip of its colour lit along one edge, a crystal core, and gold contacts at
      // the end that goes into the reader
      box(0.15, 0.012, 0.19, t(color), 0.005, 0, 0).layers.enable(SHADOW_LAYER);
      box(0.17, 0.016, 0.035, frame, 0, 0, 0.09);
      for (const sx of [-1, 1]) {
        const c = box(0.03, 0.014, 0.03, frame, sx * 0.074, 0, -0.088);
        c.rotation.y = Math.PI / 4;
      }
      box(0.012, 0.016, 0.17, frame, -0.08, 0, -0.005);
      box(0.008, 0.017, 0.14, glow(color), -0.08, 0.001, -0.01);
      box(0.05, 0.016, 0.06, crystal, 0.03, 0, -0.025);
      box(0.012, 0.017, 0.012, glow(color), 0.03, 0.001, -0.025);
      box(0.11, 0.015, 0.004, frame, 0.0, 0, 0.035);
      for (let p = 0; p < 5; p++) box(0.016, 0.018, 0.022, gold, -0.05 + p * 0.025, 0, 0.1);
      this.group.add(g);
      this.cards.push({ mesh: g, kind: k, inside: true, state: 'lying', t: 0, from: new Vector3(), to: new Vector3(), vel: new Vector3(), slot: -1 });
    }
    this.place();
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }

  /** Every card back where it was found, the reader empty, the hand empty (after a death). */
  reset() {
    if (this.held) this.creature.carrying = false;
    this.held = null;
    this.complete = false;
    this.justCompleted = false;
    for (const c of this.cards) {
      this.group.add(c.mesh);
      c.mesh.scale.setScalar(1);
      c.state = 'lying';
      c.t = 0;
      c.slot = -1;
      c.vel.set(0, 0, 0);
    }
    for (let i = 0; i < 3; i++) {
      this.filled[i] = false;
      this.station.interior.setLed(i, 'dim');
    }
    this.place();
    this.nudged = false;
  }

  /** Where they lie: seven inside, four spilled by the crates, and the green one off on its own. */
  private place() {
    const I = this.station.interior.root;
    const G = this.station.group;
    const D = 0.85;
    // inside, in the habitat's frame: [kind, x, y, z, yaw]
    const inside: [number, number, number, number, number][] = [
      [0, 7.9, D, 1.15, 0.7], // red: by the smashed tank, among the glass
      [3, -4.4, 2.17, -1.25, 0.3], // yellow: on the top bunk
      [4, -2.95, 1.565, -1.28, -0.4], // orange: on the table, by the cups
      [8, 0.25, D, -0.92, 1.2], // white: under the suit rack
      [5, 2.6, D, 0.75, 2.1], // purple: among the papers
      [7, 8.6, 1.535, -1.52, 0.2], // cyan: on the lab bench
      [9, -4.55, D, 0.22, -0.9], // grey: by the lockers
    ];
    for (const [k, x, y, z, yaw] of inside) {
      const c = this.cards[k];
      c.inside = true;
      I.localToWorld(c.mesh.position.set(x, y + 0.008, z));
      c.mesh.rotation.set(0, yaw + this.station.yaw, 0);
    }
    // outside, in the station's frame: spilled round the crates by the airlock, the green one
    // a little out of the way, behind them
    const outside: [number, number, number, number][] = [
      [2, 2.4, 5.0, 0.4], // blue: among the tipped crate's spilled contents
      [10, 3.5, 4.7, 2.0], // black: in front of the stack
      [6, 5.7, 3.9, -0.9], // magenta: off the stack's right side
      [11, 2.0, 3.0, 1.3], // brown: beside the tipped crate
      [1, 6.1, 1.6, -2.3], // green: behind the crates, against the habitat
    ];
    for (const [i, [k, x, z, yaw]] of outside.entries()) {
      const c = this.cards[k];
      c.inside = false;
      G.localToWorld(c.mesh.position.set(x, 0, z));
      c.mesh.position.y = terrainHeight(c.mesh.position.x, c.mesh.position.z) + 0.016;
      c.mesh.rotation.set(0.06 * (i % 2 ? 1 : -1), yaw + this.station.yaw, 0.05, 'YXZ');
      // a little bigger out on the sand, so they read against it
      c.mesh.scale.setScalar(OUTSIDE_SCALE);
    }
  }

  /** The card under the mouse (lying where it can be seen), if any. */
  cardAt(mouse: Vector2, camera: Camera, inside: boolean): Card | null {
    if (this.locked) return null;
    let best: Card | null = null;
    let bd = 22;
    for (const c of this.cards) {
      if (c.state !== 'lying' || c.inside !== inside) continue;
      const d = this.screenDist(c, mouse, camera);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** Distance in CSS pixels from `mouse` to the held card on screen (Infinity when none). */
  heldDistance(mouse: Vector2, camera: Camera) {
    return this.held && this.held.state === 'held' ? this.screenDist(this.held, mouse, camera) : Infinity;
  }

  private screenDist(c: Card, mouse: Vector2, camera: Camera) {
    c.mesh.getWorldPosition(this.screen).project(camera);
    const sx = ((this.screen.x + 1) / 2) * window.innerWidth;
    const sy = ((1 - this.screen.y) / 2) * window.innerHeight;
    return Math.hypot(sx - mouse.x, sy - mouse.y);
  }

  /** Take it up: it rises from where it lies into the creature's hand. */
  grab(c: Card) {
    if (c.state !== 'lying') return;
    if (this.held) this.drop();
    c.state = 'rising';
    c.t = 0;
    c.from.copy(c.mesh.position);
    this.held = c;
    this.audio.cardPickup(0.35);
    if (!c.inside) this.dust.kick(c.from.x, c.from.y, c.from.z, 0, 0, 2, 0.3);
  }

  /** Let the held card fall where the creature stands. */
  drop() {
    const c = this.held;
    if (!c) return;
    this.held = null;
    this.creature.carrying = false;
    this.toWorld(c);
    c.state = 'falling';
    c.vel.set(Math.sin(this.creature.yaw) * 0.6 + this.creature.vel.x * 0.5, 0.8, Math.cos(this.creature.yaw) * 0.6 + this.creature.vel.z * 0.5);
    this.audio.cardPickup(0.15);
  }

  /** Slide the held card into the reader (the creature leaning in to do it). */
  insert() {
    const c = this.held;
    if (!c || c.state !== 'held' || this.complete) return;
    this.held = null;
    this.creature.carrying = false;
    this.toWorld(c);
    c.from.copy(c.mesh.position);
    c.t = 0;
    const fits = c.kind < 3 && !this.filled[c.kind];
    c.slot = fits ? c.kind : Math.max(0, this.filled.indexOf(false));
    c.state = fits ? 'slotting' : 'rejecting';
    c.to.copy(this.station.interior.reader.slots[c.slot]);
  }

  get busy() {
    return this.cards.some((c) => c.state === 'rising' || c.state === 'slotting' || c.state === 'rejecting' || c.state === 'returning');
  }

  /**
   * Put a card that has just landed somewhere the creature can get it: on the
   * creature's side of the station's walls, out of the hull, the rocks and the
   * furniture, never under the raised floor.
   */
  private reachable(c: Card, rocks: RockInfo[]) {
    const p = c.mesh.position;
    const interior = this.station.interior;
    const inside = this.creatureInside;
    const home = this.creature.pos;
    for (let i = 0; i < 12 && interior.contains(p) !== inside; i++) {
      p.x += (home.x - p.x) * 0.3;
      p.z += (home.z - p.z) * 0.3;
    }
    if (interior.contains(p) !== inside) p.set(home.x, p.y, home.z);
    const walls = inside ? interior.colliders : rocks;
    for (let pass = 0; pass < 4; pass++) for (const r of walls) pushOutOfRock(r, p, 0.14, this.push);
    if (!inside && interior.contains(p)) p.set(home.x, p.y, home.z);
    c.inside = inside;
    p.y = (inside && interior.floorY ? interior.floorY : terrainHeight(p.x, p.z)) + 0.012;
  }

  update(dt: number, rocks: RockInfo[]) {
    this.justCompleted = false;
    const interior = this.station.interior;
    const yaw = this.station.yaw;
    // once: make sure the ones out on the sand are not lying inside a rock or a crate
    if (!this.nudged && rocks.length > 20) {
      this.nudged = true;
      for (const c of this.cards) {
        if (c.inside) continue;
        const p = c.mesh.position;
        const y = p.y - terrainHeight(p.x, p.z);
        for (let pass = 0; pass < 4; pass++) for (const r of rocks) pushOutOfRock(r, p, 0.16, this.push);
        p.y = terrainHeight(p.x, p.z) + y;
      }
    }
    const hand = this.creature.rig.arms[1].hand;
    for (const c of this.cards) {
      if (c.state === 'rising') {
        c.t += dt;
        // it waits for the hand to come down to it, then rises with it
        const k = Math.min(1, Math.max(0, (c.t - 0.18) / 0.3));
        hand.getWorldPosition(this.tmp);
        c.mesh.position.lerpVectors(c.from, this.tmp, ease(k));
        if (k >= 1) this.toHand(c);
      } else if (c.state === 'returning') {
        c.t += dt;
        const k = Math.min(1, c.t / 0.25);
        hand.getWorldPosition(this.tmp);
        c.mesh.position.lerpVectors(c.from, this.tmp, ease(k));
        if (k >= 1) this.toHand(c);
      } else if (c.state === 'falling') {
        c.vel.y -= 9 * dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        c.mesh.rotation.x += dt * 9;
        c.mesh.rotation.z += dt * 5;
        const inside = this.creatureInside;
        const g = inside && interior.floorY ? interior.floorY : terrainHeight(c.mesh.position.x, c.mesh.position.z);
        if (c.mesh.position.y <= g + 0.012) {
          c.mesh.rotation.set(0, c.mesh.rotation.y, 0);
          c.state = 'lying';
          this.reachable(c, rocks);
          c.mesh.scale.setScalar(inside ? 1 : OUTSIDE_SCALE);
          this.audio.cardPickup(0.12);
        }
      } else if (c.state === 'slotting' || c.state === 'rejecting') {
        c.t += dt;
        // lined up over the slot, standing on its edge, then pushed home
        const k = Math.min(1, c.t / 0.28);
        const home = Math.min(1, Math.max(0, (c.t - 0.3) / 0.12));
        this.tmp.copy(c.to);
        this.tmp.y += 0.16 - (c.state === 'slotting' ? home * 0.13 : home * 0.06);
        c.mesh.position.lerpVectors(c.from, this.tmp, ease(k));
        c.mesh.rotation.set(Math.PI / 2, yaw, 0, 'YXZ');
        if (c.state === 'slotting' && c.t > 0.42) {
          c.state = 'slot';
          this.filled[c.kind] = true;
          interior.setLed(c.kind, 'full');
          interior.showScreen(c.kind, [0xd02828, 0x30b040, 0x2860d8][c.kind], 1.6);
          this.audio.cardInsert(0.5, true);
          if (this.filled.every(Boolean)) {
            this.complete = true;
            this.justCompleted = true;
          }
        } else if (c.state === 'rejecting' && c.t > 0.42 && c.t - dt <= 0.42) {
          this.audio.cardInsert(0.4, false);
          interior.showScreen(1, 0xe02020, 0.6);
        } else if (c.state === 'rejecting' && c.t > 0.95) {
          // pushed back out, and taken up again
          c.state = 'returning';
          c.t = 0;
          c.from.copy(c.mesh.position);
          this.held = c;
        }
      }
    }
    // the ones still lying about catch the light now and then
    this.glintTimer -= dt;
    if (this.glintTimer <= 0) {
      this.glintTimer = 0.5 + Math.random() * 1.2;
      // the ones out in the sun catch it most
      const lying = this.cards.filter((c) => c.state === 'lying' && (!c.inside || Math.random() < 0.4));
      const c = lying[Math.floor(Math.random() * lying.length)];
      if (c) {
        const p = c.mesh.position;
        this.dust.spawn(p.x, p.y + 0.03, p.z, 0, 0.02, 0, 0.18, GLINT, 2, { g: 0, drag: 0, windK: 0 });
      }
    }
  }

  /** Into the right hand, held up and out like the tracker. */
  private toHand(c: Card) {
    c.state = 'held';
    this.held = c;
    const hand = this.creature.rig.arms[1].hand;
    hand.add(c.mesh);
    c.mesh.position.set(0, -0.07, 0.06);
    c.mesh.rotation.set(Math.PI / 2, 0, 0);
    c.mesh.scale.setScalar(1);
    this.creature.carrying = true;
  }

  /** Out of the hand and back into the world, where it is now. */
  private toWorld(c: Card) {
    c.mesh.getWorldPosition(this.tmp);
    this.group.add(c.mesh);
    c.mesh.position.copy(this.tmp);
    c.mesh.scale.setScalar(1);
    c.mesh.rotation.set(0, this.creature.yaw, 0);
  }
}
