// Unified input: keyboard, mouse-look, and an on-screen stick and buttons for
// touch devices. Everything funnels into the same axis/sprint/jump/look surface
// so the player controller never learns which device it is being driven by.

const isTouchDevice = () =>
  (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  || 'ontouchstart' in window
  || navigator.maxTouchPoints > 0;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.axis = { forward: 0, right: 0 };
    this.sprint = false;
    this.jumpQueued = false;
    this.jumpHeld = false;

    this.look = { dx: 0, dy: 0 };
    this.zoomDelta = 0;
    this.pointerLocked = false;
    this.dragging = false;

    this.sensitivity = 0.0024;
    this.touchSensitivity = 0.0052;
    this.onPress = new Map();

    this.touch = isTouchDevice();
    this._stick = { active: false, id: null, x: 0, y: 0, cx: 0, cy: 0, radius: 56 };
    this._lookPointer = null;

    this._bindKeyboard();
    this._bindPointer();
    if (this.touch) {
      document.body.classList.add('touch');
      this._bindTouchUi();
    }
  }

  /** Register a one-shot handler for a key code, e.g. onKey('KeyF', fn). */
  onKey(code, handler) {
    this.onPress.set(code, handler);
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        this.jumpQueued = true;
        this.jumpHeld = true;
        e.preventDefault();
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = true;
      const handler = this.onPress.get(e.code);
      if (handler) handler();
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.jumpHeld = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.sprint = false;
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.sprint = false;
      this.dragging = false;
      this.jumpHeld = false;
    });
  }

  _bindPointer() {
    // Pointer lock is a desktop nicety; on touch it is unavailable and the
    // capture gesture would fight the on-screen controls.
    if (!this.touch) {
      this.dom.addEventListener('click', () => {
        if (!this.pointerLocked && this.dom.requestPointerLock) this.dom.requestPointerLock();
      });
      document.addEventListener('pointerlockchange', () => {
        this.pointerLocked = document.pointerLockElement === this.dom;
        if (this.onLockChange) this.onLockChange(this.pointerLocked);
      });
    }

    this.dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        // Second finger anywhere on the canvas steers the camera.
        if (this._lookPointer === null) {
          this._lookPointer = e.pointerId;
          this._lookLast = { x: e.clientX, y: e.clientY };
        }
      } else if (e.button === 0) {
        this.dragging = true;
      }
      if (this.onFirstInput) { this.onFirstInput(); this.onFirstInput = null; }
    });

    window.addEventListener('pointerup', (e) => {
      if (e.pointerId === this._lookPointer) this._lookPointer = null;
      this.dragging = false;
    });
    window.addEventListener('pointercancel', (e) => {
      if (e.pointerId === this._lookPointer) this._lookPointer = null;
    });

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (e.pointerId !== this._lookPointer) return;
        this.look.dx += (e.clientX - this._lookLast.x) * this.touchSensitivity;
        this.look.dy += (e.clientY - this._lookLast.y) * this.touchSensitivity;
        this._lookLast = { x: e.clientX, y: e.clientY };
        return;
      }
      if (!this.pointerLocked && !this.dragging) return;
      // movementX is unavailable in some embedded contexts; fall back to deltas.
      const dx = e.movementX ?? 0;
      const dy = e.movementY ?? 0;
      this.look.dx += dx * this.sensitivity;
      this.look.dy += dy * this.sensitivity;
    });

    this.dom.addEventListener('wheel', (e) => {
      this.zoomDelta += Math.sign(e.deltaY) * 0.6;
      e.preventDefault();
    }, { passive: false });

    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _bindTouchUi() {
    const stick = document.getElementById('stick');
    const knob = stick?.querySelector('.knob');
    const jump = document.getElementById('btn-jump');
    const run = document.getElementById('btn-run');
    const cam = document.getElementById('btn-cam');

    if (stick && knob) {
      const begin = (e) => {
        const rect = stick.getBoundingClientRect();
        this._stick.active = true;
        this._stick.id = e.pointerId;
        this._stick.cx = rect.left + rect.width / 2;
        this._stick.cy = rect.top + rect.height / 2;
        this._stick.radius = rect.width * 0.40;
        stick.setPointerCapture(e.pointerId);
        move(e);
        if (this.onFirstInput) { this.onFirstInput(); this.onFirstInput = null; }
      };
      const move = (e) => {
        if (!this._stick.active || e.pointerId !== this._stick.id) return;
        const dx = e.clientX - this._stick.cx;
        const dy = e.clientY - this._stick.cy;
        const len = Math.hypot(dx, dy) || 1;
        const capped = Math.min(len, this._stick.radius);
        const nx = (dx / len) * capped;
        const ny = (dy / len) * capped;
        knob.style.transform = `translate(${nx}px, ${ny}px)`;
        this._stick.x = nx / this._stick.radius;
        this._stick.y = ny / this._stick.radius;
        e.preventDefault();
      };
      const end = (e) => {
        if (e.pointerId !== this._stick.id) return;
        this._stick.active = false;
        this._stick.id = null;
        this._stick.x = 0;
        this._stick.y = 0;
        knob.style.transform = '';
      };
      stick.addEventListener('pointerdown', begin);
      stick.addEventListener('pointermove', move);
      stick.addEventListener('pointerup', end);
      stick.addEventListener('pointercancel', end);
    }

    const hold = (el, down, up) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        el.classList.add('down');
        el.setPointerCapture(e.pointerId);
        down();
        e.preventDefault();
        if (this.onFirstInput) { this.onFirstInput(); this.onFirstInput = null; }
      });
      const release = () => { el.classList.remove('down'); if (up) up(); };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    };

    hold(jump, () => { this.jumpQueued = true; this.jumpHeld = true; }, () => { this.jumpHeld = false; });

    // Dash is a latch on touch: holding a button while steering is awkward.
    if (run) {
      run.addEventListener('pointerdown', (e) => {
        this.sprint = !this.sprint;
        run.classList.toggle('locked', this.sprint);
        e.preventDefault();
      });
    }
    if (cam) {
      cam.addEventListener('pointerdown', (e) => {
        const handler = this.onPress.get('KeyF');
        if (handler) handler();
        e.preventDefault();
      });
    }
  }

  /** Call once per frame, after everything has read the accumulated deltas. */
  update() {
    const k = this.keys;
    let forward = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);

    if (this._stick.active) {
      // Screen-down on the stick means walk away from the camera.
      forward = clamp(forward - this._stick.y, -1, 1);
      right = clamp(right + this._stick.x, -1, 1);
    }

    this.axis.forward = forward;
    this.axis.right = right;
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
