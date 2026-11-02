// Synthetic single-lead ECG (µV) so the app can be explored without a sensor.

import { ECG_FS } from './polar.js';

// Wave components relative to the R peak: [offset s, amplitude µV, width s]
const NORMAL = [
  [-0.17, 110, 0.026], // P
  [-0.026, -90, 0.008], // Q
  [0, 1250, 0.009], // R
  [0.028, -260, 0.009], // S
];
const ECTOPIC = [
  [-0.02, -150, 0.02],
  [0.01, 1100, 0.025],
  [0.07, -400, 0.03],
];

function gauss(t, mu, amp, w) {
  const z = (t - mu) / w;
  return amp * Math.exp(-0.5 * z * z);
}

// Heart-rate target over time (bpm)
export const SCENARIOS = {
  rest: () => 66,
  workout: (t) => {
    if (t < 45) return 72;
    if (t < 120) return 72 + ((t - 45) / 75) * 103; // ramp to 175
    if (t < 200) return 175;
    return 95 + 80 * Math.exp(-(t - 200) / 35); // recovery
  },
};

export class EcgSimulator {
  constructor({ scenario = 'rest', fs = ECG_FS, seed = 1 } = {}) {
    this.fs = fs;
    this.target = SCENARIOS[scenario] || SCENARIOS.rest;
    this.n = 0;
    this.beats = []; // { t, rr, ectopic }
    this.nextBeat = 0.6;
    this.lastRR = 0.9;
    this.pendingPause = 0;
    this._s = seed >>> 0 || 1;
    this.timer = null;
  }

  _rand() {
    // xorshift32 for reproducible demos/tests
    let x = this._s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._s = x >>> 0;
    return this._s / 4294967296;
  }

  _scheduleBeats(tEnd) {
    while (this.nextBeat < tEnd) {
      const t = this.nextBeat;
      const hr = this.target(t);
      const base = 60 / hr;
      const rsa = 0.045 * Math.sin(2 * Math.PI * 0.25 * t) * Math.min(1, 75 / hr) ** 2;
      let rr = base + rsa + (this._rand() - 0.5) * 0.03;
      let ectopic = false;
      if (this.pendingPause) {
        rr = this.pendingPause;
        this.pendingPause = 0;
      } else if (this.beats.length > 5 && hr < 130 && this._rand() < 0.012) {
        ectopic = true;
        this.pendingPause = base * 1.35;
        rr = base * 0.65;
      }
      // the beat at nextBeat ends an interval of length lastRR; mark ectopic on the premature beat
      this.beats.push({ t, rr: this.lastRR, ectopic: this._prevEctopicNext || false });
      this._prevEctopicNext = ectopic;
      this.lastRR = rr;
      this.nextBeat = t + rr;
    }
    while (this.beats.length > 8 && this.beats[0].t < tEnd - 3) this.beats.shift();
  }

  _sampleAt(t) {
    let v = 0;
    for (const b of this.beats) {
      const dt = t - b.t;
      if (dt < -0.35 || dt > 0.8) continue;
      const waves = b.ectopic ? ECTOPIC : NORMAL;
      for (const [mu, a, w] of waves) v += gauss(dt, mu, a, w);
      const qt = 0.4 * Math.sqrt(Math.min(1.4, Math.max(0.3, b.rr)));
      const tPeak = qt - 0.11;
      v += gauss(dt, b.ectopic ? tPeak + 0.03 : tPeak, b.ectopic ? -320 : 290, 0.045);
    }
    v += 60 * Math.sin(2 * Math.PI * 0.18 * t) + 25 * Math.sin(2 * Math.PI * 50 * t);
    v += (this._rand() - 0.5) * 30;
    return Math.round(v);
  }

  /** Next `count` samples as Int32Array (µV). */
  next(count) {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++, this.n++) {
      // schedule one second at a time; old beats are pruned, so a long request must not schedule far ahead
      if (i % this.fs === 0) this._scheduleBeats((this.n + this.fs) / this.fs + 1);
      out[i] = this._sampleAt(this.n / this.fs);
    }
    return out;
  }

  /** Stream in real time like the sensor (~13 samples every 100 ms). */
  start(onSamples) {
    let t0 = performance.now();
    let sent = 0;
    this.timer = setInterval(() => {
      const due = Math.floor(((performance.now() - t0) / 1000) * this.fs);
      if (due > sent) {
        onSamples(this.next(due - sent));
        sent = due;
      }
    }, 100);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
