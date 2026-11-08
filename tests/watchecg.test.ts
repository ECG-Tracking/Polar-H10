import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EcgSimulator } from '../src/sim';
import { analyze } from '../src/dsp';
import { STRIP_FS, toStrip } from '../src/watchecg';

test('a 30-second watch ECG in millivolts at 500 Hz becomes a strip like the Polar H10’s', () => {
  // a 130 Hz simulated ECG (µV), stretched to 500 Hz and written in mV as the watch stores it
  const uv = new EcgSimulator({ scenario: 'rest', seed: 3 }).next(130 * 30);
  const mv = Array.from({ length: 500 * 30 }, (_, i) => (uv[Math.min(uv.length - 1, Math.floor((i * 130) / 500))] ?? 0) / 1000);
  const { uv: strip, sourceFs } = toStrip({ start: 1_000_000, end: 1_030_000, avgHr: 60, samples: mv });
  assert.equal(sourceFs, 500);
  assert.equal(strip.length, STRIP_FS * 30);
  const big = Math.max(...Array.from(strip, Math.abs));
  assert.ok(big > 300 && big < 5000, `peak ${big} µV`);
  const a = analyze(strip, { fs: STRIP_FS });
  const b = analyze(Int16Array.from(uv), { fs: 130 });
  assert.ok(Math.abs(a.beats.length - b.beats.length) <= 1, `${a.beats.length} beats vs ${b.beats.length}`);
});

test('microvolts are kept as they are, and an odd length still gives the nearest usual rate', () => {
  const { sourceFs, uv } = toStrip({ start: 0, end: 30_000, avgHr: 0, samples: Array.from({ length: 7_710 }, (_, i) => Math.sin(i / 10) * 800) });
  assert.equal(sourceFs, 256);
  assert.ok(Math.max(...Array.from(uv)) <= 800);
});
