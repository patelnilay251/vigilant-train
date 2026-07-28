// Keyboard, mouse-look and wheel input.
//
// Supports both pointer-lock (click to capture) and click-drag looking, because
// pointer lock is unavailable in some embedded and headless contexts.

const MOVEMENT_KEYS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.axis = { forward: 0, right: 0 };
    this.sprint = false;
    this.jumpQueued = false;

    this.look = { dx: 0, dy: 0 };
    this.zoomDelta = 0;
    this.pointerLocked = false;
    this.dragging = false;

    this.sensitivity = 0.0024;
    this.onPress = new Map();

    this._bind();
  }

  /** Register a one-shot handler for a key code, e.g. onKey('KeyF', fn). */
  onKey(code, handler) {
    this.onPress.set(code, handler);
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.jumpQueued = true;
        e.preventDefault();
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = true;
      const handler = this.onPress.get(e.code);
      if (handler) handler();
      if (MOVEMENT_KEYS[e.code]) e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = false;
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.sprint = false;
      this.dragging = false;
    });

    this.dom.addEventListener('click', () => {
      if (!this.pointerLocked && this.dom.requestPointerLock) {
        this.dom.requestPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    });

    this.dom.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.dragging = true;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked && !this.dragging) return;
      this.look.dx += e.movementX * this.sensitivity;
      this.look.dy += e.movementY * this.sensitivity;
    });

    this.dom.addEventListener('wheel', (e) => {
      this.zoomDelta += Math.sign(e.deltaY) * 0.6;
      e.preventDefault();
    }, { passive: false });

    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Call once per frame, after everything has read the accumulated deltas. */
  update() {
    const k = this.keys;
    this.axis.forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    this.axis.right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
  }

  consumeLook() {
    const out = { dx: this.look.dx, dy: this.look.dy };
    this.look.dx = 0;
    this.look.dy = 0;
    return out;
  }

  consumeZoom() {
    const z = this.zoomDelta;
    this.zoomDelta = 0;
    return z;
  }

  consumeJump() {
    const j = this.jumpQueued;
    this.jumpQueued = false;
    return j;
  }
}
