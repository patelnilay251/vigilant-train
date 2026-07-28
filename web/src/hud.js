// Thin wrapper over the static markup in index.html. Values are only written
// when they change, so the HUD costs nothing on a typical frame.

export class Hud {
  constructor() {
    this.el = {
      fps: document.getElementById('s-fps'),
      time: document.getElementById('s-time'),
      alt: document.getElementById('s-alt'),
      berries: document.getElementById('s-berries'),
      total: document.getElementById('s-total'),
      toast: document.getElementById('toast'),
      loader: document.getElementById('loader'),
      loaderSub: document.getElementById('loader-sub'),
      bar: document.querySelector('#bar i'),
      startHint: document.getElementById('startHint'),
      score: document.getElementById('score'),
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
    setTimeout(() => { this.el.loader.style.display = 'none'; }, 750);
  }

  fail(message) {
    this.el.loaderSub.textContent = message;
    this.el.loaderSub.style.color = '#d3574e';
  }

  set(key, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.el[key].textContent = value;
  }

  hideStartHint() {
    this.el.startHint.classList.add('hidden');
  }

  toast(message, duration = 1.5) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add('show');
    this._toastTimer = duration;
  }

  /** Bounces the berry counter, so a pickup registers even off-centre. */
  pulseScore() {
    const node = this.el.score;
    node.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.11)' }, { transform: 'scale(1)' }],
      { duration: 330, easing: 'cubic-bezier(.3,1.6,.4,1)' },
    );
  }

  update(rawDt, { altitude, clock, berries, total }) {
    this.frames++;
    this.accumulated += rawDt;
    if (this.accumulated >= 0.45) {
      this.set('fps', String(Math.round(this.frames / this.accumulated)));
      this.frames = 0;
      this.accumulated = 0;
    }

    this.set('time', clock);
    this.set('alt', `${altitude.toFixed(1)}m`);
    this.set('berries', String(berries));
    this.set('total', String(total));

    if (this._toastTimer > 0) {
      this._toastTimer -= rawDt;
      if (this._toastTimer <= 0) this.el.toast.classList.remove('show');
    }
  }
}
