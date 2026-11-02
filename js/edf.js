// EDF+ (European Data Format) writer and reader for single-lead ECG with annotations.

const pad = (s, n) => String(s).slice(0, n).padEnd(n, ' ');
const two = (v) => String(v).padStart(2, '0');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ANN_SAMPLES = 64; // 128 bytes of annotation text per 1 s record

function fmtOnset(t) {
  return '+' + (Math.round(t * 1000) / 1000).toString();
}

/**
 * @param samples Int16Array of µV
 * @param events  [{ t (s), label }]
 * @returns Blob
 */
export function writeEdf({ samples, fs, start, alias = 'X', events = [] }) {
  const records = Math.max(1, Math.ceil(samples.length / fs));
  const ns = 2;
  const enc = new TextEncoder();
  const clean = (s) => String(s || 'X').replace(/\s+/g, '_');
  const d = new Date(start);

  let h = '';
  h += pad('0', 8);
  h += pad(`X X X ${clean(alias)}`, 80);
  h += pad(`Startdate ${two(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} X X Polar_H10`, 80);
  h += pad(`${two(d.getDate())}.${two(d.getMonth() + 1)}.${two(d.getFullYear() % 100)}`, 8);
  h += pad(`${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`, 8);
  h += pad(256 * (ns + 1), 8);
  h += pad('EDF+C', 44);
  h += pad(records, 8);
  h += pad(1, 8);
  h += pad(ns, 4);
  const sig = [
    { label: 'ECG', trans: 'Polar H10 chest strap', dim: 'uV', pmin: -32768, pmax: 32767, filt: 'None', spr: fs },
    { label: 'EDF Annotations', trans: '', dim: '', pmin: -1, pmax: 1, filt: '', spr: ANN_SAMPLES },
  ];
  for (const s of sig) h += pad(s.label, 16);
  for (const s of sig) h += pad(s.trans, 80);
  for (const s of sig) h += pad(s.dim, 8);
  for (const s of sig) h += pad(s.pmin, 8);
  for (const s of sig) h += pad(s.pmax, 8);
  for (const _ of sig) h += pad(-32768, 8);
  for (const _ of sig) h += pad(32767, 8);
  for (const s of sig) h += pad(s.filt, 80);
  for (const s of sig) h += pad(s.spr, 8);
  for (const _ of sig) h += pad('', 32);

  const recBytes = 2 * (fs + ANN_SAMPLES);
  const body = new Uint8Array(records * recBytes);
  const view = new DataView(body.buffer);
  const queue = [...events].sort((a, b) => a.t - b.t);
  let q = 0;
  for (let r = 0; r < records; r++) {
    const base = r * recBytes;
    for (let i = 0; i < fs; i++) {
      const k = r * fs + i;
      view.setInt16(base + 2 * i, k < samples.length ? samples[k] : 0, true);
    }
    const ann = new Uint8Array(body.buffer, base + 2 * fs, 2 * ANN_SAMPLES);
    let used = 0;
    const put = (str) => {
      const b = enc.encode(str);
      if (used + b.length > ann.length) return false;
      ann.set(b, used);
      used += b.length;
      return true;
    };
    put(`${fmtOnset(r)}\x14\x14\x00`);
    // overflowing annotations move to the next record; their onset is absolute so timing is kept
    while (q < queue.length && queue[q].t < r + 1 && put(`${fmtOnset(queue[q].t)}\x14${queue[q].label}\x14\x00`)) q++;
  }

  return new Blob([enc.encode(h), body], { type: 'application/octet-stream' });
}

/** Reads the first ECG-like signal and any EDF+ annotations. Returns µV samples. */
export function readEdf(buffer) {
  const bytes = new Uint8Array(buffer);
  const dec = new TextDecoder('ascii');
  const str = (o, n) => dec.decode(bytes.subarray(o, o + n)).trim();
  const headerBytes = parseInt(str(184, 8), 10);
  let records = parseInt(str(236, 8), 10);
  const duration = parseFloat(str(244, 8)) || 1;
  const ns = parseInt(str(252, 4), 10);
  if (!ns || !headerBytes) throw new Error('Not an EDF file');

  let o = 256;
  const field = (n) => { const out = []; for (let i = 0; i < ns; i++, o += n) out.push(str(o, n)); return out; };
  const labels = field(16); field(80);
  const dims = field(8);
  const pmin = field(8).map(Number), pmax = field(8).map(Number);
  const dmin = field(8).map(Number), dmax = field(8).map(Number);
  field(80);
  const spr = field(8).map(Number);

  const recSamples = spr.reduce((a, b) => a + b, 0);
  if (records < 0 || !Number.isFinite(records)) records = Math.floor((bytes.length - headerBytes) / (2 * recSamples));
  const annIdx = labels.findIndex((l) => l === 'EDF Annotations');
  let ecgIdx = labels.findIndex((l, i) => i !== annIdx && /ecg|ekg/i.test(l));
  if (ecgIdx < 0) ecgIdx = labels.findIndex((_, i) => i !== annIdx);
  if (ecgIdx < 0) throw new Error('No signal found');

  const unit = dims[ecgIdx].toLowerCase();
  const toUv = unit === 'mv' ? 1000 : unit === 'v' ? 1e6 : 1;
  const gain = ((pmax[ecgIdx] - pmin[ecgIdx]) / (dmax[ecgIdx] - dmin[ecgIdx])) * toUv;
  const n = spr[ecgIdx];
  const samples = new Float32Array(records * n);
  const view = new DataView(buffer);
  const events = [];
  const offsets = [];
  let acc = 0;
  for (let i = 0; i < ns; i++) { offsets.push(acc); acc += spr[i]; }

  for (let r = 0; r < records; r++) {
    const base = headerBytes + r * recSamples * 2;
    if (base + recSamples * 2 > bytes.length) { records = r; break; }
    for (let i = 0; i < n; i++) {
      const dig = view.getInt16(base + 2 * (offsets[ecgIdx] + i), true);
      samples[r * n + i] = ((dig - dmin[ecgIdx]) * gain) + pmin[ecgIdx] * toUv;
    }
    if (annIdx >= 0) {
      const raw = bytes.subarray(base + 2 * offsets[annIdx], base + 2 * (offsets[annIdx] + spr[annIdx]));
      for (const tal of dec.decode(raw).split('\x00')) {
        const parts = tal.split('\x14');
        if (parts.length < 3) continue;
        const onset = parseFloat(parts[0].split('\x15')[0]);
        for (const label of parts.slice(1)) if (label) events.push({ t: onset, label });
      }
    }
  }

  // start date/time: dd.mm.yy hh.mm.ss
  const [dd, mm, yy] = str(168, 8).split('.').map(Number);
  const [hh, mi, ss] = str(176, 8).split('.').map(Number);
  const year = yy >= 85 ? 1900 + yy : 2000 + yy;
  const start = new Date(year, (mm || 1) - 1, dd || 1, hh || 0, mi || 0, ss || 0).getTime();
  const patient = str(8, 80).split(' ');

  return {
    fs: n / duration,
    samples: samples.subarray(0, records * n),
    start,
    alias: patient[3] && patient[3] !== 'X' ? patient[3] : '',
    events,
  };
}
