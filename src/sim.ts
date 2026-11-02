// Synthetic single-lead ECG (µV) so the app can be explored without a sensor.

import { ECG_FS } from './polar';

/** Wave component relative to the R peak: [offset s, amplitude µV, width s] */
type Wave = readonly [number, number, number];

const NORMAL: readonly Wave[] = [
  [-0.17, 110, 0.026], // P
  [-0.026, -90, 0.008], // Q
  [0, 1250, 0.009], // R
  [0.028, -260, 0.009], // S
];
const ECTOPIC: readonly Wave[] = [
  [-0.02, -150, 0.02],
  [0.01, 1100, 0.025],
  [0.07, -400, 0.03],
];

function gauss(t: number, mu: number, amp: number, w: number): number {
  const z = (t - mu) / w;
  return amp * Math.exp(-0.5 * z * z);
}

export type Scenario = 'rest' | 'workout';

// Heart-rate target over time (bpm)
export const SCENARIOS: Readonly<Record<Scenario, (t: number) => number>> = {
  rest: () => 66,
  workout: (t) => {
    if (t < 45) return 72;
    if (t < 120) return 72 + ((t - 45) / 75) * 103; // ramp to 175
    if (t < 200) return 175;
    return 95 + 80 * Math.exp(-(t - 200) / 35); // recovery
  },
};

interface SimBeat { t: number; rr: number; ectopic: boolean }

export interface SimOptions { scenario?: Scenario; fs?: number; seed?: number }

export class EcgSimulator {
  readonly fs: number;
  /** Beats currently contributing to the signal (recent ones only). */
  readonly beats: SimBeat[] = [];
  private readonly target: (t: number) => number;
  private n = 0;
  private nextBeat = 0.6;
  private lastRR = 0.9;
  private pendingPause = 0;
  private prevEctopicNext = false;
  private seed: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor({ scenario = 'rest', fs = ECG_FS, seed = 1 }: SimOptions = {}) {
    this.fs = fs;
    this.target = SCENARIOS[scenario];
    this.seed = seed >>> 0 || 1;
  }

  private rand(): number {
    // xorshift32 for reproducible demos/tests
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  private scheduleBeats(tEnd: number): void {
    while (this.nextBeat < tEnd) {
      const t = this.nextBeat;
      const hr = this.target(t);
      const base = 60 / hr;
      const rsa = 0.045 * Math.sin(2 * Math.PI * 0.25 * t) * Math.min(1, 75 / hr) ** 2;
      let rr = base + rsa + (this.rand() - 0.5) * 0.03;
      let ectopic = false;
      if (this.pendingPause) {
        rr = this.pendingPause;
        this.pendingPause = 0;
      } else if (this.beats.length > 5 && hr < 130 && this.rand() < 0.012) {
        ectopic = true;
        this.pendingPause = base * 1.35;
        rr = base * 0.65;
      }
      // the beat at nextBeat ends an interval of length lastRR; mark ectopic on the premature beat
      this.beats.push({ t, rr: this.lastRR, ectopic: this.prevEctopicNext });
      this.prevEctopicNext = ectopic;
      this.lastRR = rr;
      this.nextBeat = t + rr;
    }
    while (this.beats.length > 8 && (this.beats[0]?.t ?? Infinity) < tEnd - 3) this.beats.shift();
  }

  private sampleAt(t: number): number {
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
    v += (this.rand() - 0.5) * 30;
    return Math.round(v);
  }

  /** Next `count` samples as Int32Array (µV). */
  next(count: number): Int32Array {
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++, this.n++) {
      // schedule one second at a time; old beats are pruned, so a long request must not schedule far ahead
      if (i % this.fs === 0) this.scheduleBeats((this.n + this.fs) / this.fs + 1);
      out[i] = this.sampleAt(this.n / this.fs);
    }
    return out;
  }

  /** Stream in real time like the sensor (~13 samples every 100 ms). */
  start(onSamples: (samples: Int32Array) => void): void {
    const t0 = performance.now();
    let sent = 0;
    this.timer = setInterval(() => {
      const due = Math.floor(((performance.now() - t0) / 1000) * this.fs);
      if (due > sent) {
        onSamples(this.next(due - sent));
        sent = due;
      }
    }, 100);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
