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
  ['red', 0xd02828],
  ['green', 0x30b040],
  ['blue', 0x2860d8],
  ['yellow', 0xe8c030],
  ['orange', 0xe07828],
  ['purple', 0x7a40c0],
  ['magenta', 0xd040a0],
  ['cyan', 0x40c0d0],
  ['white', 0xd8d6cc],
  ['grey', 0x6a6a6a],
  ['black', 0x2a2a2e],
  ['brown', 0x7a5232],
];

type CardState = 'lying' | 'flying' | 'carried' | 'slotting' | 'slot' | 'rejecting';

interface Card {
  mesh: Group;
  /** Index into COLORS: 0 red, 1 green, 2 blue fit the reader. */
  kind: number;
  inside: boolean;
  state: CardState;
  t: number;
  from: Vector3;
  to: Vector3;
  slot: number;
}

const GLINT = rgb(0xfffbe8).toArray();

function faceted(g: BufferGeometry) {
  const f = g.index ? g.toNonIndexed() : g;
  f.computeVertexNormals();
  return f;
}

/**
 * Data cards: a dozen little floppy-sized cards of coloured plastic, each with
 * a sliding metal shutter and a label, spilled through the station and out
 * across the sand when it was raided, some half buried. Only one is red, one
 * green and one blue; the green one lies out of the way, off among the rocks.
 *
 * Click one to pick it up: the creature stoops, takes it, and slips it into a
 * fan of cards at its hip. Click the reader on the desk to feed them in: each
 * of red, green and blue clicks into its own slot and its ring lights; any
 * other card is refused with a buzz and pushed back out. When all three are
 * in, `complete` turns true.
 */
export class DataCards {
  readonly group = new Group();
  readonly cards: Card[] = [];
  readonly carried: Card[] = [];
  complete = false;
  justCompleted = false;
  private readonly filled = [false, false, false];
  private queue: Card[] = [];
  private stepTimer = 0;
  private glintTimer = 2;
  private nudged = false;
  private readonly tmp = new Vector3();
  private readonly push = new Vector2();

  constructor(
    private readonly station: Station,
    private readonly creature: Creature,
    private readonly dust: Dust,
    private readonly audio: AudioEngine,
  ) {
    const t = (c: number) => {
      const k = rgb(c);
      const hex = (v: Vector3, f: number) => (Math.min(255, Math.round(v.x * f * 255)) << 16) | (Math.min(255, Math.round(v.y * f * 255)) << 8) | Math.min(255, Math.round(v.z * f * 255));
      return toonMaterial({ dark: hex(k, 0.55), mid: hex(k, 0.85), light: hex(k, 1.12), litAt: 0.5, midAt: -0.1, outline: 0.6, highlight: 0.8 });
    };
    const shutter = toonMaterial({ dark: 0x5a5c60, mid: 0x9a9ca0, light: 0xd8dade, litAt: 0.5, outline: 0.5, highlight: 1 });
    const label = toonMaterial({ dark: 0x9a968a, mid: 0xd0ccbe, light: 0xf0ece0, litAt: 0.5, outline: 0.3, highlight: 0.2 });
    const ink = toonMaterial({ dark: 0x1a1a1e, mid: 0x2a2a2e, light: 0x3a3a3e, litAt: 0.5, outline: 0, highlight: 0 });
    for (const [k, [, color]] of COLORS.entries()) {
      const g = new Group();
      const box = (w: number, h: number, d: number, mat: Material, x: number, y: number, z: number) => {
        const m = new Mesh(faceted(new BoxGeometry(w, h, d)), mat);
        m.position.set(x, y, z);
        g.add(m);
        return m;
      };
      box(0.2, 0.014, 0.21, t(color), 0, 0, 0).layers.enable(SHADOW_LAYER);
      box(0.09, 0.018, 0.075, shutter, 0.02, 0, 0.065);
      box(0.02, 0.019, 0.04, ink, 0.035, 0, 0.07);
      box(0.15, 0.017, 0.085, label, 0, 0, -0.055);
      box(0.1, 0.018, 0.008, ink, -0.01, 0, -0.04);
      box(0.06, 0.018, 0.008, ink, -0.03, 0, -0.065);
      this.group.add(g);
      this.cards.push({ mesh: g, kind: k, inside: true, state: 'lying', t: 0, from: new Vector3(), to: new Vector3(), slot: -1 });
    }
    this.place();
  }

  addTo(scene: Object3D) {
    scene.add(this.group);
  }

  /** Where they lie: seven inside, five out on the sand. */
  private place() {
    const I = this.station.interior.root;
    const G = this.station.group;
    const D = 0.85;
    // inside, in the habitat's frame: [kind, x, y, z, yaw, tilt]
    const inside: [number, number, number, number, number, number][] = [
      [0, 7.9, D, 1.15, 0.7, 0], // red: by the smashed tank, among the glass
      [3, -4.4, 2.17, -1.25, 0.3, 0], // yellow: on the top bunk
      [4, -2.95, 1.565, -1.28, -0.4, 0], // orange: on the table, by the cups
      [8, 0.25, D, -0.92, 1.2, 0], // white: under the suit rack
      [5, 3.9, D, 0.62, 2.1, 0], // purple: among the papers
      [7, 8.6, 1.535, -1.52, 0.2, 0], // cyan: on the lab bench
      [9, -4.55, D, 0.22, -0.9, 0], // grey: by the lockers
    ];
    for (const [k, x, y, z, yaw, tilt] of inside) {
      const c = this.cards[k];
      c.inside = true;
      I.localToWorld(c.mesh.position.set(x, y + 0.008, z));
      c.mesh.rotation.set(tilt, yaw + this.station.yaw, 0);
    }
    // outside, in the station's frame, most of them half sunk in the sand
    const outside: [number, number, number, number, number][] = [
      [2, -1.6, 2.9, 0.4, 0.9], // blue: by the dead, half buried
      [10, 6.3, 4.7, 2.2, 0.7], // black: past the spilled crates
      [6, 6.6, -5.0, -0.8, 0], // magenta: under the solar panels
      [11, -3.4, 7.3, 1.1, 1.0], // brown: by a lamp post, nearly buried
      [1, -12.5, 4.5, -2.3, 0.8], // green: out of the way, off among the rocks
    ];
    for (const [k, x, z, yaw, sunk] of outside) {
      const c = this.cards[k];
      c.inside = false;
      G.localToWorld(c.mesh.position.set(x, 0, z));
      c.mesh.position.y = terrainHeight(c.mesh.position.x, c.mesh.position.z) + 0.01 - sunk * 0.06;
      c.mesh.rotation.set(sunk * 0.9, yaw + this.station.yaw, sunk * 0.3, 'YXZ');
    }
  }

  /** The card under the mouse (lying where it can be seen), if any. */
  cardAt(mouse: Vector2, camera: Camera, inside: boolean): Card | null {
    let best: Card | null = null;
    let bd = 20;
    for (const c of this.cards) {
      if (c.state !== 'lying' || c.inside !== inside) continue;
      this.tmp.copy(c.mesh.position).project(camera);
      const sx = ((this.tmp.x + 1) / 2) * window.innerWidth;
      const sy = ((1 - this.tmp.y) / 2) * window.innerHeight;
      const d = Math.hypot(sx - mouse.x, sy - mouse.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** Pick it up: it flies to the creature's hand, then to the fan at its hip. */
  grab(c: Card) {
    if (c.state !== 'lying') return;
    c.state = 'flying';
    c.t = 0;
    c.from.copy(c.mesh.position);
    this.audio.cardPickup(0.35);
    // sand shaken off a buried one
    if (!c.inside) this.dust.kick(c.from.x, c.from.y, c.from.z, 0, 0, 3, 0.4);
  }

  /** Feed every carried card to the reader in turn. */
  insertAll() {
    if (this.queue.length || !this.carried.length) return;
    this.queue = [...this.carried];
    this.stepTimer = 0;
  }

  get busy() {
    return this.queue.length > 0 || this.cards.some((c) => c.state === 'flying' || c.state === 'slotting' || c.state === 'rejecting');
  }

  update(dt: number, time: number, rocks: RockInfo[]) {
    this.justCompleted = false;
    const interior = this.station.interior;
    // once: make sure the ones out on the sand are not lying inside a rock
    if (!this.nudged && rocks.length > 20) {
      this.nudged = true;
      for (const c of this.cards) {
        if (c.inside) continue;
        const p = c.mesh.position;
        for (let pass = 0; pass < 4; pass++) for (const r of rocks) pushOutOfRock(r, p, 0.3, this.push);
        p.y = terrainHeight(p.x, p.z) + 0.01 - (c.mesh.rotation.x / 0.9) * 0.06;
      }
    }
    // the reader takes them one at a time
    if (this.queue.length) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        const c = this.queue.shift()!;
        this.stepTimer = 0.6;
        const i = this.carried.indexOf(c);
        if (i >= 0) this.carried.splice(i, 1);
        this.toWorld(c);
        c.from.copy(c.mesh.position);
        c.t = 0;
        const fits = c.kind < 3 && !this.filled[c.kind];
        c.slot = fits ? c.kind : this.filled.indexOf(false);
        if (c.slot < 0) c.slot = 1;
        c.state = fits ? 'slotting' : 'rejecting';
        c.to.copy(interior.reader.slots[c.slot]);
      }
    }
    for (const c of this.cards) {
      if (c.state === 'flying') {
        c.t += dt;
        const k = Math.min(1, c.t / 0.32);
        this.creature.rig.arms[1].hand.getWorldPosition(this.tmp);
        c.mesh.position.lerpVectors(c.from, this.tmp, k * k * (3 - 2 * k));
        c.mesh.position.y += Math.sin(k * Math.PI) * 0.15;
        c.mesh.rotation.x += dt * 6;
        if (k >= 1) this.toBelt(c);
      } else if (c.state === 'slotting' || c.state === 'rejecting') {
        c.t += dt;
        const k = Math.min(1, c.t / 0.3);
        // into the slot, standing on its edge, half in
        this.tmp.copy(c.to);
        this.tmp.y += 0.06;
        c.mesh.position.lerpVectors(c.from, this.tmp, k * k * (3 - 2 * k));
        c.mesh.rotation.set((Math.PI / 2) * k, this.station.yaw, 0);
        if (c.state === 'slotting' && k >= 1) {
          c.state = 'slot';
          this.filled[c.kind] = true;
          interior.setLed(c.kind, 'full');
          interior.showScreen(c.kind, [0xd02828, 0x30b040, 0x2860d8][c.kind], 1.6);
          this.audio.cardInsert(0.4, true);
          if (this.filled.every(Boolean)) {
            this.complete = true;
            this.justCompleted = true;
            this.queue = [];
          }
        } else if (c.state === 'rejecting' && c.t > 0.3 && c.t < 0.3 + dt * 1.5) {
          this.audio.cardInsert(0.3, false);
          interior.showScreen(1, 0xe02020, 0.6);
        } else if (c.state === 'rejecting' && c.t > 0.55) {
          // pushed back out: back to the hip
          this.toBelt(c);
        }
      }
    }
    // the ones still lying about catch the light now and then
    this.glintTimer -= dt;
    if (this.glintTimer <= 0) {
      this.glintTimer = 1.5 + Math.random() * 2.5;
      const lying = this.cards.filter((c) => c.state === 'lying');
      const c = lying[Math.floor(Math.random() * lying.length)];
      if (c) {
        const p = c.mesh.position;
        this.dust.spawn(p.x, p.y + 0.03, p.z, 0, 0.02, 0, 0.15, GLINT, 2, { g: 0, drag: 0, windK: 0 });
      }
    }
    void time;
  }

  /** Into the fan of cards at its hip. */
  private toBelt(c: Card) {
    c.state = 'carried';
    if (!this.carried.includes(c)) this.carried.push(c);
    const pelvis = this.creature.rig.pelvis;
    pelvis.add(c.mesh);
    this.layoutBelt();
  }

  private layoutBelt() {
    for (const [i, c] of this.carried.entries()) {
      c.mesh.position.set(0.17 + i * 0.004, -0.02 + (i % 2) * 0.01, -0.06 + i * 0.012);
      c.mesh.rotation.set(0, 0, Math.PI / 2 - 0.25 + i * 0.05);
      c.mesh.scale.setScalar(0.55);
    }
  }

  /** Out of the hip pouch and back into the world, where it is now. */
  private toWorld(c: Card) {
    c.mesh.getWorldPosition(this.tmp);
    this.group.add(c.mesh);
    c.mesh.position.copy(this.tmp);
    c.mesh.scale.setScalar(1);
  }
}
