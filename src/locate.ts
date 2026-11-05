// Locate connected devices: maps the Bluetooth signal strength read from a scanner app around the home, and shades where a
// lost Polar H10 or Watch D2 most likely is. A web page can't read signal strength itself, so the readings are typed in.

import { css } from './charts';
import { make } from './ui';

export interface Reading { x: number; y: number; rssi: number | null } // metres; rssi null = not found there
interface Plan { w: number; h: number; readings: Reading[] }
type Device = 'polar' | 'watch';

const DEVICES = [['polar', 'Polar H10'], ['watch', 'Watch D2']] as const;
const STEP = 0.5, LOSS = 3, SPREAD = 8, FAINTEST = -92, ENOUGH = 6;

export interface Estimate {
  cols: number; rows: number;
  odds: Float64Array; // how likely each 0.5 m cell is, relative to the best
  best: { x: number; y: number }; // the middle of the likely area: a noisy reading moves it less than the single best cell
  areaM2: number; share: number; // the smallest area holding 70 % of the likelihood
  next: { x: number; y: number } | null; // where another reading would help most
}

/** Signal fades with distance; each position is scored by how well that fits the readings. */
export function estimate(readings: readonly Reading[], w: number, h: number): Estimate {
  const cols = Math.max(1, Math.round(w / STEP)), rows = Math.max(1, Math.round(h / STEP));
  const found = readings.filter((r): r is Reading & { rssi: number } => r.rssi != null);
  const log = new Float64Array(cols * rows);
  let top = -Infinity;
  const fall = (x: number, y: number, r: Reading): number => 10 * LOSS * Math.log10(Math.max(0.5, Math.hypot(x - r.x, y - r.y)));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * STEP, y = (j + 0.5) * STEP;
      // the strength at 1 m isn't known, so it is fitted for each possible position
      const fitted = found.length ? found.reduce((s, r) => s + r.rssi + fall(x, y, r), 0) / found.length : -60;
      const atOneMetre = Math.max(-75, Math.min(-45, fitted));
      let miss = 0;
      for (const r of readings) {
        const expected = atOneMetre - fall(x, y, r);
        if (r.rssi != null) miss += (expected - r.rssi) ** 2;
        else if (expected > FAINTEST) miss += (expected - FAINTEST) ** 2;
      }
      const l = -miss / (2 * SPREAD * SPREAD);
      log[j * cols + i] = l;
      if (l > top) top = l;
    }
  }
  const odds = Float64Array.from(log, (l) => Math.exp(l - top));
  const total = odds.reduce((a, b) => a + b, 0);
  const order = [...odds.keys()].sort((a, b) => (odds[b] ?? 0) - (odds[a] ?? 0));
  const at = (k: number): { x: number; y: number } => ({ x: (k % cols + 0.5) * STEP, y: (Math.floor(k / cols) + 0.5) * STEP });
  let held = 0, count = 0, sumX = 0, sumY = 0;
  for (const k of order) {
    if (held >= 0.7 * total) break;
    const o = odds[k] ?? 0, p = at(k);
    held += o; sumX += o * p.x; sumY += o * p.y; count++;
  }
  let next: Estimate['next'] = null, far = -1;
  for (const k of order.slice(0, count)) {
    const p = at(k), d = Math.min(...readings.map((r) => Math.hypot(p.x - r.x, p.y - r.y)));
    if (d > far) { far = d; next = p; }
  }
  return { cols, rows, odds, best: { x: sumX / held, y: sumY / held }, areaM2: count * STEP * STEP, share: count / odds.length, next: far >= 1.5 ? next : null };
}

const KEY = 'openbeat-locate';

function load(): Record<Device, Plan> {
  const blank = (): Plan => ({ w: 12, h: 9, readings: [] });
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Record<Device, Plan>> | null;
    const ok = (p: Plan | undefined): p is Plan => Array.isArray(p?.readings) && typeof p?.w === 'number' && typeof p?.h === 'number';
    return { polar: ok(v?.polar) ? v.polar : blank(), watch: ok(v?.watch) ? v.watch : blank() };
  } catch { return { polar: blank(), watch: blank() }; }
}

/** `back`: returns to Sync & backups. */
export function initLocate(root: HTMLElement, back: () => void): { refresh: () => void } {
  const plans = load();
  let device: Device = 'polar', notFound = false, photo: HTMLImageElement | null = null;
  const save = (): void => { try { localStorage.setItem(KEY, JSON.stringify(plans)); } catch { /* kept for this visit */ } };
  const plan = (): Plan => plans[device];
  const name = (): string => DEVICES.find((d) => d[0] === device)?.[1] ?? '';

  const backBtn = make('button', 'no-print', '← Sync & backups');
  backBtn.addEventListener('click', back);
  const lead = make('p', 'note', 'Mark the signal strength around your home, and the map shades where the device most likely is. The device must be awake: a Polar H10 needs damp electrodes, usually on its strap, and a Watch D2 must be on.');

  const pick = make('select');
  pick.setAttribute('aria-label', 'Device to find');
  for (const [v, t] of DEVICES) { const o = make('option', '', t); o.value = v; pick.appendChild(o); }
  const pickLabel = make('label', 'd2-days', 'Find ');
  pickLabel.appendChild(pick);

  const headline = make('h3', 'sync-h'), detail = make('p', 'note');
  const result = make('section', 'card');
  result.append(pickLabel, headline, detail);

  const value = make('div', 'locate-value');
  const slider = make('input');
  Object.assign(slider, { type: 'range', min: '-100', max: '-30', step: '1', value: '-70' });
  slider.setAttribute('aria-label', 'Signal from your scanner app, in dBm');
  const sliderBox = make('label', 'locate-slider', 'Signal from your scanner app');
  sliderBox.appendChild(slider);
  const noneBtn = make('button', '', 'Not found here');
  const top = make('div', 'row wrap locate-top');
  top.append(value, sliderBox, noneBtn);

  const canvas = make('canvas', 'locate-plan');
  canvas.setAttribute('aria-label', 'Plan of your home with readings and the most likely area');
  const hint = make('p', 'note');

  const undoBtn = make('button', '', 'Undo last'), clearBtn = make('button', '', 'Clear all');
  const photoInput = make('input');
  photoInput.type = 'file'; photoInput.accept = 'image/*'; photoInput.hidden = true;
  const photoLabel = make('label', 'button', 'Add a floor plan photo');
  photoLabel.appendChild(photoInput);
  const sizeInput = (label: string, key: 'w' | 'h'): { el: HTMLElement; input: HTMLInputElement } => {
    const input = make('input');
    Object.assign(input, { type: 'number', min: '3', max: '60', step: '1' });
    input.setAttribute('aria-label', `${label} in metres`);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (v >= 3 && v <= 60) plan()[key] = Math.round(v);
      save();
      draw();
    });
    const el = make('label', 'd2-days', `${label} `);
    el.append(input, ' m');
    return { el, input };
  };
  const width = sizeInput('Width', 'w'), depth = sizeInput('Depth', 'h');
  const tools = make('div', 'row wrap');
  tools.append(undoBtn, clearBtn, photoLabel, width.el, depth.el);
  const mapCard = make('section', 'card locate-card');
  mapCard.append(top, canvas, hint, tools);

  const steps = make('ol', 'tips');
  for (const s of [
    'Open a scanner app such as nRF Connect or LightBlue on your phone and find the device in the scan.',
    'Stand still for about 10 seconds with the phone at waist height, and note the typical number.',
    'Set that number here and tap your position on the plan. If the device isn’t listed, choose Not found here and tap.',
    `Repeat in at least ${ENOUGH} places across different rooms, including the dashed ring on the plan.`,
  ]) steps.appendChild(make('li', '', s));
  const help = make('section', 'card');
  help.append(make('h3', 'sync-h', 'How to use it'), steps,
    make('p', 'note', 'A web page can’t read Bluetooth signal strength for you, so you enter it. Walls and furniture weaken the signal, so the shaded area is where to start, not an exact spot. Readings stay on this device.'));

  root.replaceChildren(backBtn, make('h2', '', 'Locate connected devices'), lead, result, mapCard, help);

  function say(est: Estimate | null): void {
    const { readings } = plan();
    const found = readings.filter((r) => r.rssi != null).length;
    if (!est) { headline.textContent = `Add your first ${name()} reading`; detail.textContent = 'Set the signal, then tap your position on the plan.'; return; }
    if (!found) { headline.textContent = 'No signal found yet'; detail.textContent = 'The shaded area is simply away from where you looked. If the device never appears, it is probably asleep or out of range.'; return; }
    headline.textContent = `Search first around ${est.best.x.toFixed(1)} m across, ${est.best.y.toFixed(1)} m down`;
    const left = ENOUGH - readings.length;
    const more = left > 0 ? `Take ${left} more reading${left === 1 ? '' : 's'} before you rely on this.` : est.next ? 'A reading inside the dashed ring would narrow it most.' : 'Search low around the cross, then walk the shaded area with the scanner.';
    detail.textContent = `The shaded area covers about ${Math.round(est.areaM2)} m², ${Math.round(est.share * 100)} % of the plan. ${more}`;
  }

  function draw(): void {
    const p = plan();
    value.textContent = notFound ? 'None' : `${slider.value} dBm`;
    slider.disabled = notFound;
    noneBtn.classList.toggle('primary', notFound);
    undoBtn.disabled = clearBtn.disabled = !p.readings.length;
    width.input.value = String(p.w); depth.input.value = String(p.h);
    hint.textContent = `Tap where you are standing to save the reading. Each square is 1 m; the plan is ${p.w} × ${p.h} m.`;
    const est = p.readings.length ? estimate(p.readings, p.w, p.h) : null;
    say(est);
    const cssW = canvas.clientWidth;
    if (!cssW) return;
    const cssH = Math.min(cssW * (p.h / p.w), 560), dpr = window.devicePixelRatio || 1;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = cssW / p.w, sy = cssH / p.h;
    g.fillStyle = css('--surface'); g.fillRect(0, 0, cssW, cssH);
    if (photo) { g.globalAlpha = 0.45; g.drawImage(photo, 0, 0, cssW, cssH); g.globalAlpha = 1; }
    if (est) {
      const cw = cssW / est.cols, ch = cssH / est.rows;
      g.fillStyle = css('--critical');
      est.odds.forEach((o, k) => {
        g.globalAlpha = 0.7 * o;
        g.fillRect((k % est.cols) * cw, Math.floor(k / est.cols) * ch, cw + 0.5, ch + 0.5);
      });
      g.globalAlpha = 1;
    }
    g.strokeStyle = css('--chart-grid'); g.lineWidth = 1; g.beginPath();
    for (let x = 1; x < p.w; x++) { g.moveTo(x * sx, 0); g.lineTo(x * sx, cssH); }
    for (let y = 1; y < p.h; y++) { g.moveTo(0, y * sy); g.lineTo(cssW, y * sy); }
    g.stroke();
    const mark = css('--series-1'), surface = css('--surface'), ink = css('--ink');
    if (est?.next) { g.strokeStyle = mark; g.lineWidth = 2; g.setLineDash([4, 4]); g.beginPath(); g.arc(est.next.x * sx, est.next.y * sy, 13, 0, 7); g.stroke(); g.setLineDash([]); }
    g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const r of p.readings) {
      const x = r.x * sx, y = r.y * sy;
      g.beginPath(); g.arc(x, y, 5, 0, 7); g.fillStyle = r.rssi == null ? surface : mark; g.fill(); g.strokeStyle = mark; g.lineWidth = 2; g.stroke();
      const text = r.rssi == null ? 'none' : String(r.rssi), tw = g.measureText(text).width + 8;
      const tx = Math.min(cssW - tw / 2 - 2, Math.max(tw / 2 + 2, x)), ty = y > 22 ? y - 15 : y + 15;
      g.fillStyle = surface; g.fillRect(tx - tw / 2, ty - 8, tw, 16);
      g.fillStyle = ink; g.fillText(text, tx, ty);
    }
    if (est) {
      const x = est.best.x * sx, y = est.best.y * sy;
      g.strokeStyle = ink; g.lineWidth = 2; g.beginPath();
      g.moveTo(x - 9, y); g.lineTo(x + 9, y); g.moveTo(x, y - 9); g.lineTo(x, y + 9); g.stroke();
    }
  }

  const changed = (): void => { save(); draw(); };
  canvas.addEventListener('click', (e) => {
    const b = canvas.getBoundingClientRect(), p = plan();
    const x = ((e.clientX - b.left) / b.width) * p.w, y = ((e.clientY - b.top) / b.height) * p.h;
    p.readings.push({ x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), rssi: notFound ? null : Number(slider.value) });
    changed();
  });
  pick.addEventListener('change', () => { device = pick.value === 'watch' ? 'watch' : 'polar'; draw(); });
  slider.addEventListener('input', draw);
  noneBtn.addEventListener('click', () => { notFound = !notFound; draw(); });
  undoBtn.addEventListener('click', () => { plan().readings.pop(); changed(); });
  clearBtn.addEventListener('click', () => { plan().readings = []; changed(); });
  photoInput.addEventListener('change', () => {
    const f = photoInput.files?.[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { photo = img; draw(); };
    img.src = URL.createObjectURL(f);
  });
  new ResizeObserver(() => draw()).observe(mapCard);
  return { refresh: draw };
}
