// Thin wrapper over the static markup in index.html. Values are only written
// when they change, so the HUD costs nothing on a typical frame.

export class Hud {
  constructor() {
    this.el = {
      fps: document.getElementById('s-fps'),
      time: document.getElementById('s-time'),
      alt: document.getElementById('s-alt'),
      tris: document.getElementById('s-tris'),
      berries: document.getElementById('s-berries'),
      total: document.getElementById('s-total'),
      toast: document.getElementById('toast'),
      loader: document.getElementById('loader'),
      loaderSub: document.getElementById('loader-sub'),
      bar: document.querySelector('#bar i'),
      startHint: document.getElementById('startHint'),
    };

    this.cache = {};
    this.frames = 0;
    this.accumulated = 0;
    this._toastTimer = 0;
  }

  progress(fraction, label) {
    this.el.bar.style.width = `${Math.round(fraction * 100)}%`;
    if (label) this.el.loaderSub.textContent = label;
  }

  ready() {
    this.el.loader.classList.add('hidden');
    setTimeout(() => { this.el.loader.style.display = 'none'; }, 700);
  }

  set(key, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.el[key].textContent = value;
  }

  hideStartHint() {
    this.el.startHint.classList.add('hidden');
  }

  toast(message, duration = 1.4) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add('show');
    this._toastTimer = duration;
  }

  update(dt, { altitude, clock, triangles, berries, total }) {
    this.frames++;
    this.accumulated += dt;
    if (this.accumulated >= 0.4) {
      this.set('fps', Math.round(this.frames / this.accumulated));
      this.frames = 0;
      this.accumulated = 0;
      this.set('tris', triangles.toLocaleString());
    }

    this.set('time', clock);
    this.set('alt', `${altitude.toFixed(1)} m`);
    this.set('berries', String(berries));
    this.set('total', String(total));

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.el.toast.classList.remove('show');
    }
  }
}
