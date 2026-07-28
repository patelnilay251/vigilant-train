// Procedurally synthesised sound. No audio files: every cue is a few
// oscillators and an envelope, which keeps the project asset-free and lets the
// pickup chime transpose up the scale as a streak builds.

const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]; // major pentatonic, two octaves

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.streak = 0;
    this._lastPickup = 0;
  }

  /** Browsers require a gesture before audio starts; call this from one. */
  resume() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.34;

      // A touch of reverb-ish body so the cues do not sound bone dry. A short
      // noise burst convolved in is cheaper than any real reverb.
      const convolver = this.ctx.createConvolver();
      convolver.buffer = this._impulse(1.1, 2.6);
      const wet = this.ctx.createGain();
      wet.gain.value = 0.20;

      this.master.connect(this.ctx.destination);
      this.master.connect(wet);
      wet.connect(convolver);
      convolver.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
      }
    }
    return buffer;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.34;
  }

  get ready() {
    return this.ctx && !this.muted && this.ctx.state === 'running';
  }

  /** Single enveloped oscillator. */
  _tone(freq, { at = 0, duration = 0.18, type = 'sine', gain = 0.3, sweep = 0, attack = 0.006 } = {}) {
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * sweep), t0 + duration);

    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(env);
    env.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** Band-passed noise burst, for footfalls and splashes. */
  _noise(duration, frequency, q, gain) {
    const t0 = this.ctx.currentTime;
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.value = gain;

    source.connect(filter);
    filter.connect(env);
    env.connect(this.master);
    source.start(t0);
  }

  step(running) {
    if (!this.ready) return;
    this._noise(0.075, 320 + Math.random() * 260, 1.1, running ? 0.16 : 0.10);
  }

  splash() {
    if (!this.ready) return;
    this._noise(0.22, 1500 + Math.random() * 900, 0.7, 0.16);
  }

  jump() {
    if (!this.ready) return;
    this._tone(430, { duration: 0.15, type: 'triangle', gain: 0.22, sweep: 1.7 });
  }

  land() {
    if (!this.ready) return;
    this._tone(150, { duration: 0.12, type: 'sine', gain: 0.20, sweep: 0.55 });
    this._noise(0.09, 260, 1.0, 0.10);
  }

  /**
   * Pickup chime. Consecutive pickups climb the pentatonic scale, which is the
   * oldest trick in the collect-a-thon book and still the most satisfying.
   */
  pickup() {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this._lastPickup > 2600) this.streak = 0;
    this._lastPickup = now;

    const semitone = SCALE[Math.min(this.streak, SCALE.length - 1)];
    this.streak++;
    const root = 523.25 * (2 ** (semitone / 12));

    this._tone(root, { duration: 0.20, type: 'triangle', gain: 0.26 });
    this._tone(root * 1.5, { at: 0.055, duration: 0.26, type: 'sine', gain: 0.20 });
    this._tone(root * 2, { at: 0.105, duration: 0.34, type: 'sine', gain: 0.13 });
  }

  fanfare() {
    if (!this.ready) return;
    [0, 4, 7, 12, 16].forEach((semi, i) => {
      const f = 523.25 * (2 ** (semi / 12));
      this._tone(f, { at: i * 0.11, duration: 0.42, type: 'triangle', gain: 0.24 });
      this._tone(f * 2, { at: i * 0.11, duration: 0.42, type: 'sine', gain: 0.10 });
    });
  }
}
