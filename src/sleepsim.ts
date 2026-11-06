// Simulated night for the "Demo night" button and tests: a plausible hypnogram (about 90-minute cycles,
// more deep sleep early and more REM late, a few awakenings) turned into RR intervals and chest accelerometer data.

import { ACC_FS } from './polar';
import { EPOCH_S, type SleepData, type Stage } from './sleep';

type SleepStage = Exclude<Stage, 'nodata' | 'uncertain'>;

interface StageParams { hr: number; rsa: number; noise: number; breath: number; breathCv: number; move: number }
const PARAMS: Readonly<Record<SleepStage, StageParams>> = {
  awake: { hr: 68, rsa: 25, noise: 30, breath: 15, breathCv: 0.2, move: 40 },
  light: { hr: 58, rsa: 35, noise: 12, breath: 14, breathCv: 0.07, move: 0 },
  deep: { hr: 53, rsa: 45, noise: 5, breath: 13, breathCv: 0.03, move: 0 },
  rem: { hr: 62, rsa: 20, noise: 28, breath: 16.5, breathCv: 0.2, move: 0 },
};

export interface SimulatedNight { data: SleepData; truth: SleepStage[] }

export function simulateNight(seed = 1, fs = ACC_FS): SimulatedNight {
  let s = seed >>> 0 || 1;
  const rand = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

  // ---- hypnogram, in minutes ----
  const plan: [SleepStage, number][] = [['awake', 14]];
  const deepByCycle = [38, 26, 12, 4, 0];
  const remByCycle = [8, 16, 22, 28, 30];
  deepByCycle.forEach((deep, c) => {
    plan.push(['light', 22 + Math.round(rand() * 8)]);
    if (deep) plan.push(['deep', deep]);
    plan.push(['light', 16 + Math.round(rand() * 6)]);
    plan.push(['rem', remByCycle[c] ?? 20]);
    if (c === 1 || c === 3) plan.push(['awake', 3 + Math.round(rand() * 3)]); // brief awakenings between cycles
  });
  plan.push(['awake', 8]);
  const truth: SleepStage[] = [];
  for (const [stage, minutes] of plan) for (let k = 0; k < (minutes * 60) / EPOCH_S; k++) truth.push(stage);
  const durationS = truth.length * EPOCH_S;
  const hrOffset = (rand() - 0.5) * 8; // people and nights differ
  const stageAt = (t: number): SleepStage => truth[Math.min(truth.length - 1, Math.floor(t / EPOCH_S))] ?? 'awake';

  // ---- breathing phase, sample by sample ----
  const n = Math.round(durationS * fs);
  const breathPhase = new Float64Array(n);
  let phase = 0, breathRate = PARAMS.awake.breath;
  for (let i = 0; i < n; i++) {
    const p = PARAMS[stageAt(i / fs)];
    const before = phase;
    phase += (2 * Math.PI * breathRate) / 60 / fs;
    if (Math.floor(phase / (2 * Math.PI)) !== Math.floor(before / (2 * Math.PI))) {
      breathRate = Math.max(6, p.breath * (1 + p.breathCv * gauss())); // each breath slightly different
    }
    breathPhase[i] = phase;
  }

  // ---- RR intervals: stage heart rate, slow drift down, breathing-linked variation (RSA) ----
  const rrT: number[] = [], rr: number[] = [];
  for (let t = 0.8; t < durationS;) {
    const p = PARAMS[stageAt(t)];
    const drift = -3 * (t / durationS);
    const ph = breathPhase[Math.min(n - 1, Math.floor(t * fs))] ?? 0;
    const v = 60000 / (p.hr + hrOffset + drift) + p.rsa * Math.sin(ph) + p.noise * gauss();
    t += v / 1000;
    rrT.push(t);
    rr.push(v);
  }

  // ---- accelerometer: gravity for the current posture + chest movement from breathing + body movement ----
  const postures: [number, number, number][] = [[0, -980, -200], [300, -900, -250], [-300, -900, -250], [0, -950, 300]];
  const acc = new Int16Array(3 * n);
  let posture = postures[0] ?? [0, -1000, 0];
  let lastStage: SleepStage = 'awake';
  let burst = 0; // samples of turning-over movement left
  for (let i = 0; i < n; i++) {
    const stage = stageAt(i / fs);
    if (stage !== lastStage && (stage === 'light' || lastStage === 'awake') && rand() < 0.5) {
      posture = postures[Math.floor(rand() * postures.length)] ?? posture; // turning over between stages
      burst = Math.round(8 * fs);
    }
    lastStage = stage;
    const p = PARAMS[stage];
    const chest = 9 * Math.sin(breathPhase[i] ?? 0);
    const moving = burst > 0 || (p.move > 0 && rand() < 0.02) ? 60 : 0;
    if (burst > 0) burst--;
    for (let a = 0; a < 3; a++) {
      const g = posture[a] ?? 0;
      const motion = moving ? moving * gauss() : 0;
      acc[3 * i + a] = Math.round(g + (a === 2 ? chest : chest * 0.3) + motion + 2 * gauss() + (p.move ? p.move * 0.3 * gauss() : 0));
    }
  }

  return { data: { durationS, rrT: Float64Array.from(rrT), rr: Float32Array.from(rr), acc, accFs: fs }, truth };
}
