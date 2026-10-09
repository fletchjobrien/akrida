import { Vector2 } from 'three';

const GAME_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'KeyC',
  'Space',
]);

/**
 * Keyboard and mouse state. Ctrl is crouch, which collides with browser
 * shortcuts: most (Ctrl+S, Ctrl+D...) can be cancelled, but Ctrl+W cannot.
 * While Ctrl is held we ask the browser to confirm before closing the tab,
 * and in fullscreen we use the Keyboard Lock API where it exists.
 */
export class Input {
  private readonly keys = new Set<string>();
  readonly mouse = new Vector2(-1, -1);
  hasMouse = false;
  lastMouseMove = -1e9;
  private gestureHandlers: (() => void)[] = [];
  private wheelHandlers: ((dir: number) => void)[] = [];
  private readonly moveVec = new Vector2();
  private lastWheel = 0;

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => this.keys.clear());
    window.addEventListener('pointermove', (e) => {
      this.mouse.set(e.clientX, e.clientY);
      this.hasMouse = true;
      this.lastMouseMove = performance.now();
    });
    window.addEventListener('pointerdown', (e) => {
      this.mouse.set(e.clientX, e.clientY);
      this.hasMouse = true;
      this.lastMouseMove = performance.now();
      this.gesture();
      el.focus();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const now = performance.now();
        if (Math.abs(e.deltaY) < 1 || now - this.lastWheel < 180) return;
        this.lastWheel = now;
        // wheel up zooms in
        for (const h of this.wheelHandlers) h(e.deltaY < 0 ? -1 : 1);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => this.toggleFullscreen());
    window.addEventListener('beforeunload', (e) => {
      if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  onGesture(h: () => void) {
    this.gestureHandlers.push(h);
  }

  onWheel(h: (dir: number) => void) {
    this.wheelHandlers.push(h);
  }

  private gesture() {
    for (const h of this.gestureHandlers) h();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (GAME_KEYS.has(e.code) || e.ctrlKey) {
      // keep Ctrl+key browser shortcuts from firing while crouch-walking
      if (!(e.ctrlKey && (e.code === 'KeyR' || e.code === 'F5')) && e.code !== 'F11' && e.code !== 'F12') {
        e.preventDefault();
      }
    }
    if (e.code === 'Escape' && document.fullscreenElement) void document.exitFullscreen();
    this.keys.add(e.code);
    this.gesture();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (GAME_KEYS.has(e.code)) e.preventDefault();
  };

  private async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        const kb = (navigator as unknown as { keyboard?: { lock?: (codes?: string[]) => Promise<void> } }).keyboard;
        if (kb?.lock) await kb.lock(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ControlLeft', 'ControlRight', 'Escape']);
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // fullscreen or keyboard lock unavailable: nothing to do
    }
  }

  down(code: string) {
    return this.keys.has(code);
  }

  get move(): Vector2 {
    const k = this.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.moveVec.set(x, y);
    if (x !== 0 && y !== 0) this.moveVec.multiplyScalar(Math.SQRT1_2);
    return this.moveVec;
  }

  get sprint() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  get crouch() {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC');
  }
}
