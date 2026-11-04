import test from 'node:test';
import assert from 'node:assert/strict';
import { atZoom, BAR_MM, DEFAULT_PX_PER_MM, ecgSize, parseScale, parseSize, pxPerMm } from '../src/screenscale';

test('an uncalibrated screen uses the default', () => {
  assert.equal(pxPerMm(), DEFAULT_PX_PER_MM);
});

test('a saved scale is read back, and nonsense is ignored', () => {
  assert.deepEqual(parseScale('{"pxPerMm":4.45,"dpr":2}'), { pxPerMm: 4.45, dpr: 2 });
  assert.equal(parseScale(null), null);
  assert.equal(parseScale('not json'), null);
  assert.equal(parseScale('{"pxPerMm":1,"dpr":2}'), null); // too small to be a screen
  assert.equal(parseScale('{"pxPerMm":4.45}'), null);
});

test('browser zoom keeps a square at 1 mm', () => {
  const s = { pxPerMm: 4.45, dpr: 2 };
  assert.equal(atZoom(s, 2), 4.45);
  assert.equal(atZoom(s, 4), 2.225); // zoomed to 200 %: page pixels are twice as big
});

test('the ECG size is actual, double or triple', () => {
  assert.equal(ecgSize(), 1);
  assert.equal(parseSize('2'), 2);
  assert.equal(parseSize('3'), 3);
  assert.equal(parseSize('4'), 1);
  assert.equal(parseSize(null), 1);
});

test('the bar fits on a phone', () => {
  assert.ok(BAR_MM < 64);
});
