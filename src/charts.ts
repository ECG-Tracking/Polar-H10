// Canvas charts: line/scatter plots with hover, live ECG sweep, and a zoomable ECG viewer.

import type { Analysis, EventType, Samples } from './dsp';
import { DEFAULT_PX_PER_MM, ecgSize, onScaleChange, pxPerMm, scaleNote } from './screenscale';

export function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** What to draw on each chart again when the colours change. */
const painters = new Map<HTMLCanvasElement, () => void>();

function watch(canvas: HTMLCanvasElement, draw: () => void): void {
  painters.set(canvas, draw);
  new ResizeObserver(draw).observe(canvas);
  watchZoom();
}

let zoomWatched = false;
/**
 * A browser zoom or a move to another screen changes the pixel ratio without always resizing the canvas: everything is
 * drawn again, so the picture is never the old one stretched, and the live ECG keeps its calibrated mm per second.
 */
function watchZoom(): void {
  if (zoomWatched || typeof matchMedia !== 'function') return;
  zoomWatched = true;
  const listen = (): void => {
    const q = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    q.addEventListener('change', () => { for (const [c, draw] of painters) if (c.isConnected) draw(); listen(); }, { once: true });
  };
  listen();
}

function repaint(): void {
  for (const [canvas, draw] of painters) {
    if (!canvas.isConnected) { painters.delete(canvas); continue; }
    draw();
    // reading a pixel turns what was just drawn into a finished picture. Printed as a list of drawing steps,
    // a chart becomes a transparency layer, which erased parts of the page in the Mac's PDF viewers.
    canvas.getContext('2d')?.getImageData(0, 0, 1, 1);
  }
}

/** Charts are pixels in the page's colours: for printing they are drawn again in the light ones, for white paper. */
export function printInLightColours(): void {
  const root = document.documentElement;
  let theme: string | undefined;
  window.addEventListener('beforeprint', () => { theme = root.dataset['theme']; root.dataset['theme'] = 'light'; repaint(); });
  window.addEventListener('afterprint', () => {
    if (theme == null) delete root.dataset['theme']; else root.dataset['theme'] = theme;
    repaint();
  });
}

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const top = hi > lo ? hi : lo + 1;
  const raw = (top - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= top + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** [x, y, highlighted?]; y null leaves a gap in a line. */
export type Point = readonly [number, number | null, boolean?];
type DrawnPoint = readonly [number, number, boolean?];

export interface PlotSpec {
  type: 'line' | 'scatter';
  points: readonly Point[];
  xLabel?: string;
  yLabel?: string;
  xFmt?: (v: number) => string;
  yFmt?: (v: number) => string;
  tooltip?: (p: DrawnPoint) => string; // HTML
  refLines?: readonly { y: number; label: string }[];
  vLines?: readonly { x: number; label: string; row?: number }[];
  identity?: boolean; // square axes with a y = x line
  xDomain?: readonly [number, number];
  yDomain?: readonly [number, number];
  color?: string;
  empty?: string;
}

interface Layout { l: number; r: number; t: number; b: number; pw: number; ph: number }
interface PlotMap { X: (v: number) => number; Y: (v: number) => number; pts: DrawnPoint[]; L: Layout }

export class Plot {
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private spec: PlotSpec | null = null;
  private hover: DrawnPoint | null = null;
  private map: PlotMap | null = null;

  constructor(wrap: HTMLElement) {
    const canvas = wrap.querySelector('canvas');
    if (!canvas) throw new Error('chart has no canvas');
    this.canvas = canvas;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    wrap.appendChild(this.tip);
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.style.display = 'none'; this.draw(); });
    watch(canvas, () => this.draw());
  }

  set(spec: PlotSpec): void { this.spec = spec; this.hover = null; this.draw(); }

  private layout(w: number, h: number): Layout {
    const m = { l: 48, r: 12, t: 10, b: 34 };
    return { ...m, pw: w - m.l - m.r, ph: h - m.t - m.b };
  }

  draw(): void {
    const spec = this.spec;
    if (!spec || !this.canvas.clientWidth) return;
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const L = this.layout(w, h);
    const pts = spec.points.filter((p): p is DrawnPoint => p[1] != null && Number.isFinite(p[1]));
    const ink2 = css('--ink-2'), muted = css('--muted'), grid = css('--chart-grid'), series = spec.color ?? css('--series-1');
    ctx.font = '11px system-ui, sans-serif';

    if (!pts.length) {
      ctx.fillStyle = muted; ctx.textAlign = 'center';
      ctx.fillText(spec.empty ?? 'Not enough data', w / 2, h / 2);
      return;
    }
    let [x0, x1] = spec.xDomain ?? [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
    let [y0, y1] = spec.yDomain ?? [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
    if (spec.identity) { x0 = y0 = Math.min(x0, y0); x1 = y1 = Math.max(x1, y1); }
    const padY = (y1 - y0) * 0.08 || 5, padX = spec.type === 'scatter' ? (x1 - x0) * 0.06 || 5 : 0;
    if (!spec.yDomain) { y0 -= padY; y1 += padY; }
    if (!spec.xDomain) { x0 -= padX; x1 += padX; }
    const xt = niceTicks(x0, x1, Math.max(2, Math.floor(L.pw / 80)));
    const yt = niceTicks(y0, y1, Math.max(2, Math.floor(L.ph / 40)));
    const X = (v: number): number => L.l + ((v - x0) / (x1 - x0 || 1)) * L.pw;
    const Y = (v: number): number => L.t + L.ph - ((v - y0) / (y1 - y0 || 1)) * L.ph;
    this.map = { X, Y, pts, L };
    const xFmt = spec.xFmt ?? String, yFmt = spec.yFmt ?? String;

    // grid + axes
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = muted;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt) {
      if (v < y0 || v > y1) continue;
      ctx.beginPath(); ctx.moveTo(L.l, Y(v) + 0.5); ctx.lineTo(L.l + L.pw, Y(v) + 0.5); ctx.stroke();
      ctx.fillText(yFmt(v), L.l - 6, Y(v));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt) if (v >= x0 && v <= x1) ctx.fillText(xFmt(v), X(v), L.t + L.ph + 6);
    ctx.fillStyle = ink2;
    if (spec.xLabel) ctx.fillText(spec.xLabel, L.l + L.pw / 2, h - 13);
    if (spec.yLabel) {
      ctx.save(); ctx.translate(11, L.t + L.ph / 2); ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle'; ctx.fillText(spec.yLabel, 0, 0); ctx.restore();
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(L.l, L.t, L.pw, L.ph); ctx.clip();
    if (spec.identity) {
      ctx.strokeStyle = grid; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(x0), Y(y0)); ctx.lineTo(X(x1), Y(y1)); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const r of spec.refLines ?? []) {
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(L.l, Y(r.y)); ctx.lineTo(L.l + L.pw, Y(r.y)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ink2; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(r.label, L.l + L.pw - 4, Y(r.y) - 2);
    }
    for (const v of spec.vLines ?? []) {
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(v.x), L.t); ctx.lineTo(X(v.x), L.t + L.ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(v.label, X(v.x) + 3, L.t + 2 + (v.row ?? 0) * 13);
    }

    if (spec.type === 'line') {
      ctx.strokeStyle = series; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (const [px, py] of spec.points) {
        if (py == null) { pen = false; continue; }
        if (pen) ctx.lineTo(X(px), Y(py)); else { ctx.moveTo(X(px), Y(py)); pen = true; }
      }
      ctx.stroke();
    } else {
      const r = pts.length > 2000 ? 2 : 3;
      const critical = css('--critical');
      ctx.globalAlpha = pts.length > 500 ? 0.45 : 0.8;
      for (const p of pts) {
        ctx.fillStyle = p[2] ? critical : series;
        ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), r, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // hover
    if (this.hover) {
      const p = this.hover;
      ctx.strokeStyle = ink2; ctx.lineWidth = 1;
      if (spec.type === 'line') {
        ctx.beginPath(); ctx.moveTo(X(p[0]) + 0.5, L.t); ctx.lineTo(X(p[0]) + 0.5, L.t + L.ph); ctx.stroke();
      }
      ctx.fillStyle = series; ctx.strokeStyle = css('--surface'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  private move(e: PointerEvent): void {
    const spec = this.spec, map = this.map;
    if (!map || !spec) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { X, Y, pts } = map;
    let best: DrawnPoint | null = null, bd = Infinity;
    for (const p of pts) {
      const d = spec.type === 'line' ? Math.abs(X(p[0]) - mx) : Math.hypot(X(p[0]) - mx, Y(p[1]) - my);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best || (spec.type === 'scatter' && bd > 16)) {
      this.hover = null; this.tip.style.display = 'none'; this.draw(); return;
    }
    this.hover = best;
    this.draw();
    this.tip.innerHTML = spec.tooltip ? spec.tooltip(best) : `${best[0]}, ${best[1]}`;
    this.tip.style.display = 'block';
    const tx = Math.min(rect.width - this.tip.offsetWidth - 4, Math.max(4, X(best[0]) + 10));
    this.tip.style.left = `${tx}px`;
    this.tip.style.top = `${Math.max(4, Y(best[1]) - this.tip.offsetHeight - 8)}px`;
  }
}

// The standard clinical ECG: 25 mm/s and 10 mm/mV. A small square stands for 1 mm: on paper exactly, on a screen once it is calibrated.
const MM_PER_S = 25, MM_PER_MV = 10;
/** Every ECG strip is 4 big squares tall (20 mm, ±1 mV about the middle): the user's ECGs never go beyond that. */
export const STRIP_BIG_SQUARES = 4;
const BIG_SQUARE_MM = 5;
/** Sets an ECG canvas to 4 big squares tall at the screen calibration and the ECG size setting. */
function stripHeight(canvas: HTMLCanvasElement, mm: number): void {
  const px = `${Math.round(STRIP_BIG_SQUARES * BIG_SQUARE_MM * mm)}px`;
  if (canvas.style.height !== px) canvas.style.height = px;
}
export const PX_PER_S = MM_PER_S * DEFAULT_PX_PER_MM;
export const PX_PER_MV = MM_PER_MV * DEFAULT_PX_PER_MM;
export const ECG_SCALE_NOTE = 'Standard ECG scale: speed 25 mm/s, height 10 mm/mV. One small square is 0.04 s and 0.1 mV; one large square is 0.2 s and 0.5 mV. The box at the left is the calibration mark: 1 mV tall and 0.2 s wide.';
// the calibration mark takes one large square, one large square in from the left; the trace starts after it
const CAL_LEFT_MM = 5, CAL_WIDTH_MM = 5, CAL_MARGIN_MM = CAL_LEFT_MM + CAL_WIDTH_MM + 1;
export const CAL_MARGIN = CAL_MARGIN_MM * DEFAULT_PX_PER_MM;

/** The standard calibration mark, on the trace's baseline. It is drawn, not a signal from the strap. */
function drawCalibration(ctx: CanvasRenderingContext2D, base: number, mm: number): void {
  const left = CAL_LEFT_MM * mm, right = left + CAL_WIDTH_MM * mm, top = base - MM_PER_MV * mm;
  ctx.beginPath();
  ctx.moveTo(left - 2 * mm, base);
  ctx.lineTo(left, base);
  ctx.lineTo(left, top);
  ctx.lineTo(right, top);
  ctx.lineTo(right, base);
  ctx.lineTo(CAL_MARGIN_MM * mm, base);
  ctx.stroke();
}

/** Sweep-style live ECG trace (like a bedside monitor), always at the standard scale: a wider screen shows more seconds. */
export class LiveTrace {
  private len: number;
  private buf: Float32Array;
  private pos = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly fs: number, seconds = 6) {
    this.len = Math.round(fs * seconds);
    this.buf = new Float32Array(this.len).fill(NaN);
    watch(canvas, () => this.draw());
    canvas.after(scaleNote(ECG_SCALE_NOTE));
  }

  /** The sweep is as many seconds as the canvas shows at the standard speed. */
  private fit(w: number, pxPerS: number): void {
    const len = Math.round((w / pxPerS) * this.fs);
    if (len === this.len) return;
    this.len = len;
    this.buf = new Float32Array(len).fill(NaN);
    this.pos = 0;
  }

  push(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) { this.buf[this.pos] = values[i] ?? NaN; this.pos = (this.pos + 1) % this.len; }
    for (let i = 0; i < 6; i++) this.buf[(this.pos + i) % this.len] = NaN; // gap ahead of the cursor
  }

  clear(): void { this.buf.fill(NaN); this.pos = 0; this.draw(); }

  draw(): void {
    if (!this.canvas.clientWidth) return;
    this.canvas.dataset['size'] = String(ecgSize()); // bigger waves need a taller trace (styles.css)
    // the page's width, never the picture's: a canvas without a CSS width would grow to its own pixels and be stretched
    if (!this.canvas.style.width) this.canvas.style.width = '100%';
    stripHeight(this.canvas, pxPerMm() * ecgSize());
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const mm = pxPerMm() * ecgSize(), pxPerS = MM_PER_S * mm, pxPerMv = MM_PER_MV * mm, margin = CAL_MARGIN_MM * mm;
    this.fit(w - margin, pxPerS);
    drawEcgGrid(ctx, w, h, pxPerS, pxPerMv);
    ctx.strokeStyle = css('--trace'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    drawCalibration(ctx, h / 2, mm);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < this.len; i++) {
      const v = this.buf[i] ?? NaN;
      if (!Number.isFinite(v)) { pen = false; continue; }
      const x = margin + (i / this.fs) * pxPerS, y = h / 2 - (v / 1000) * pxPerMv;
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  }
}

// ECG paper: minor every 0.04 s / 0.1 mV, major every 0.2 s / 0.5 mV
function drawEcgGrid(ctx: CanvasRenderingContext2D, w: number, h: number, pxPerS: number, pxPerMv: number, t0 = 0): void {
  const minor = css('--grid'), major = css('--grid-major');
  const drawSet = (stepS: number, stepMv: number, color: string): void => {
    if (pxPerS * stepS < 2.5) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    const first = Math.ceil(t0 / stepS) * stepS;
    for (let t = first; (t - t0) * pxPerS <= w; t += stepS) { const x = Math.round((t - t0) * pxPerS) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = (h / 2) % (pxPerMv * stepMv); y <= h; y += pxPerMv * stepMv) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  };
  drawSet(0.04, 0.1, minor);
  drawSet(0.2, 0.5, major);
}

const STRIP_S = 6, STRIP_MV = (STRIP_BIG_SQUARES * BIG_SQUARE_MM) / MM_PER_MV, STRIP_SHARPNESS = 3;

/** A strip for the printed report, `t` seconds into `x`, 161 × 20 mm on paper at the standard scale (see .event-strip). */
export function drawEventStrip(canvas: HTMLCanvasElement, x: Samples, fs: number, t: number): void {
  painters.set(canvas, () => drawEventStrip(canvas, x, fs, t));
  const w = CAL_MARGIN + STRIP_S * PX_PER_S, h = STRIP_MV * PX_PER_MV;
  canvas.width = w * STRIP_SHARPNESS;
  canvas.height = h * STRIP_SHARPNESS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(STRIP_SHARPNESS, 0, 0, STRIP_SHARPNESS, 0, 0);
  ctx.fillStyle = css('--surface');
  ctx.fillRect(0, 0, w, h);
  const t0 = Math.max(0, Math.min(x.length / fs - STRIP_S, t - STRIP_S / 2));
  drawEcgGrid(ctx, w, h, PX_PER_S, PX_PER_MV);
  ctx.strokeStyle = css('--trace'); ctx.lineWidth = 1; ctx.lineJoin = 'round';
  drawCalibration(ctx, h / 2, DEFAULT_PX_PER_MM);
  ctx.beginPath();
  const i0 = Math.ceil(t0 * fs), i1 = Math.min(x.length - 1, Math.floor((t0 + STRIP_S) * fs));
  for (let i = i0; i <= i1; i++) {
    const px = CAL_MARGIN + (i / fs - t0) * PX_PER_S, py = h / 2 - ((x[i] ?? 0) / 1000) * PX_PER_MV;
    if (i === i0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  const mark = CAL_MARGIN + (t - t0) * PX_PER_S;
  ctx.fillStyle = css('--critical');
  ctx.beginPath(); ctx.moveTo(mark - 5, 2); ctx.lineTo(mark + 5, 2); ctx.lineTo(mark, 11); ctx.fill();
}

export interface ReportEvent { t: number; type: EventType; label: string }

/**
 * Full-session ECG viewer at the calibrated scale (25 mm/s, 10 mm/mV, the screen calibration and the ECG size setting,
 * as the live trace): drag or swipe to move through it; the mouse wheel scrolls the page, and a sideways scroll (or
 * Shift + wheel) moves through the ECG. It doesn't zoom, so waves keep their true width. Fires 'move'.
 */
export class EcgViewer extends EventTarget {
  /** Seconds shown: as many as the width holds at the calibrated speed. Set by the calibration, never by zooming. */
  get span(): number {
    const w = this.canvas.clientWidth || 600;
    return w / (MM_PER_S * pxPerMm() * ecgSize());
  }
  set span(_seconds: number) { /* fixed by the calibration: kept so older callers still work */ }
  t0 = 0; // seconds at the left edge
  duration = 0;
  private analysis: Analysis | null = null;
  private events: readonly ReportEvent[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    super();
    const pointers = new Map<number, number>();
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e.clientX); });
    canvas.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (prev === undefined) return;
      pointers.set(e.pointerId, e.clientX);
      if (pointers.size === 1) this.pan(-((e.clientX - prev) / canvas.clientWidth) * this.span);
    });
    const end = (e: PointerEvent): void => { pointers.delete(e.pointerId); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    // the wheel scrolls the page as anywhere else; only a sideways scroll (or Shift + wheel) moves through the ECG
    canvas.addEventListener('wheel', (e) => {
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!sideways) return;
      e.preventDefault();
      this.pan((sideways / canvas.clientWidth) * this.span);
    }, { passive: false });
    watch(canvas, () => this.draw());
    onScaleChange(() => { if (canvas.isConnected) this.goTo(this.t0); });
  }

  load(analysis: Analysis, events: readonly ReportEvent[]): void {
    this.analysis = analysis;
    const x = analysis.x;
    this.duration = x.length / analysis.fs;
    this.events = events;
    this.t0 = 0;
    this.draw();
  }

  pan(dt: number): void { this.goTo(this.t0 + dt); }

  /** No zoom: the scale is the calibrated one. Kept so older callers still work. */
  zoom(_f: number): void { /* fixed scale */ }

  goTo(t: number): void {
    if (!this.analysis) return;
    this.t0 = Math.max(0, Math.min(Math.max(0, this.duration - this.span), t));
    this.draw();
    this.dispatchEvent(new Event('move'));
  }

  center(t: number): void { this.goTo(t - this.span / 2); }

  draw(): void {
    const a = this.analysis;
    if (!a || !this.canvas.clientWidth) return;
    this.canvas.dataset['size'] = String(ecgSize());
    stripHeight(this.canvas, pxPerMm() * ecgSize());
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const x = a.x, fs = a.fs;
    const mm = pxPerMm() * ecgSize(), pxPerS = MM_PER_S * mm, pxPerMv = MM_PER_MV * mm; // as on paper, whatever the width
    drawEcgGrid(ctx, w, h, pxPerS, pxPerMv, this.t0);
    const i0 = Math.max(0, Math.floor(this.t0 * fs)), i1 = Math.min(x.length - 1, Math.ceil((this.t0 + this.span) * fs));
    const X = (i: number): number => (i / fs - this.t0) * pxPerS;
    const Y = (v: number): number => h / 2 - (v / 1000) * pxPerMv;

    ctx.strokeStyle = css('--trace'); ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const y = Y(x[i] ?? 0);
      if (i === i0) ctx.moveTo(X(i), y); else ctx.lineTo(X(i), y);
    }
    ctx.stroke();

    // beat annotations
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const showDetail = this.span <= 12;
    const critical = css('--critical'), muted = css('--muted'), series = css('--series-1');
    for (const b of a.beats) {
      if (b.t < this.t0 - 1 || b.t > this.t0 + this.span + 1) continue;
      const bx = X(b.t * fs);
      const flagged = b.flags.some((f) => f !== 'artifact'); // a likely connection error isn't marked as an event
      ctx.fillStyle = flagged ? critical : muted;
      if (b.rr && showDetail) ctx.fillText(`${Math.round(b.rr)}`, bx, 4);
      if (flagged) {
        ctx.beginPath(); ctx.moveTo(bx - 5, 20); ctx.lineTo(bx + 5, 20); ctx.lineTo(bx, 27); ctx.fill();
      }
      if (showDetail && b.m && this.span <= 6) {
        ctx.fillStyle = series;
        for (const idx of [b.m.onset, b.m.offset, b.m.tEnd]) {
          if (idx == null) continue;
          ctx.fillRect(X(idx) - 1, h - 14, 2, 10);
        }
      }
    }
    for (const e of this.events) {
      if (e.type !== 'user' || e.t < this.t0 || e.t > this.t0 + this.span) continue;
      const ex = (e.t - this.t0) * pxPerS;
      ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ex, 30); ctx.lineTo(ex, h); ctx.stroke();
      ctx.fillStyle = css('--ink-2'); ctx.fillText('Marked', ex, 32);
    }
  }
}

// ---------- The Polar H10's other signals under its ECG ----------

/** What ChestStrips draws: the signals of a sleep recording (see chestsignals.ts). */
export interface ChestStripData {
  fs: number; breathing: Float32Array; movement: Float32Array; beatT: Float64Array; hr: Float32Array;
}

/**
 * Breathing, movement and heart-rate strips under the recorded ECG, showing the same seconds at the same width: they
 * follow the ECG viewer's position, and dragging one of them moves the ECG too (one slider for all).
 */
/** A blood pressure reading for the BP graph: when (ms), systolic and diastolic (mmHg), and pulse (bpm). */
export interface BpPoint { at: number; systolic: number | null; diastolic: number | null; pulse: number | null }

/**
 * Blood pressure as a line chart: systolic and diastolic as two lines over time, each reading's value written at its
 * point, mmHg up the side and the date and time along the bottom. Above an ECG it covers the hour before to the hour
 * after the recording, with the recording shaded and the part the ECG shows marked (the mark moves with the slider).
 */
export class BpStrip {
  private readings: readonly BpPoint[] = [];
  private span: [number, number] = [0, 1];
  private recording: [number, number] | null = null;
  private shown: [number, number] | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly value: HTMLElement;
  readonly el: HTMLElement;

  /** `alwaysShown`: shown with "No readings" when there are none (on a page of its own), rather than hidden. */
  constructor(private readonly alwaysShown = false) {
    this.el = document.createElement('figure');
    this.el.className = 'chest-strip bp-strip';
    const cap = document.createElement('figcaption');
    const name = document.createElement('span');
    name.textContent = 'Blood pressure (mmHg)';
    this.value = document.createElement('span');
    this.value.className = 'muted';
    cap.append(name, this.value);
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'Blood pressure readings: systolic and diastolic over time');
    this.el.append(cap, this.canvas);
    this.el.hidden = !alwaysShown;
    watch(this.canvas, () => this.draw());
  }

  /** The readings, the time the chart covers, and the recording's own span (all ms). */
  set(readings: readonly BpPoint[], span: [number, number], recording: [number, number] | null): void {
    this.readings = [...readings].filter((r) => r.systolic != null || r.diastolic != null).sort((a, b) => a.at - b.at);
    this.span = span;
    this.recording = recording;
    this.el.hidden = !this.readings.length && !this.alwaysShown;
    const n = this.readings.length;
    this.value.textContent = n ? ` · ${n} reading${n > 1 ? 's' : ''}` : '';
    this.draw();
  }

  /** The moments the ECG shows now (ms), marked on the chart; null: none. */
  mark(from: number | null, to: number | null = from): void {
    this.shown = from == null || to == null ? null : [from, to];
    this.draw();
  }

  private draw(): void {
    if (this.el.hidden || !this.canvas.clientWidth) return;
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const L = { l: 44, r: 16, t: 24, b: 26 };
    const pw = Math.max(10, w - L.l - L.r), ph = Math.max(10, h - L.t - L.b);
    const [a, b] = this.span;
    const X = (t: number): number => L.l + ((t - a) / Math.max(1, b - a)) * pw;
    const vals = this.readings.flatMap((r) => [r.systolic, r.diastolic]).filter((v): v is number => v != null);
    // mmHg: whole tens around the readings, 60–140 when there are none
    const lo = vals.length ? Math.floor((Math.min(...vals) - 10) / 10) * 10 : 60, hi = vals.length ? Math.ceil((Math.max(...vals) + 10) / 10) * 10 : 140;
    const Y = (v: number): number => L.t + ph - ((v - lo) / (hi - lo)) * ph;
    ctx.font = '11px system-ui, sans-serif';

    // grid, mmHg up the side
    const step = hi - lo > 100 ? 20 : 10;
    ctx.strokeStyle = css('--chart-grid') || css('--line'); ctx.lineWidth = 1;
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = lo; v <= hi; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L.l, y); ctx.lineTo(L.l + pw, y); ctx.stroke();
      ctx.fillText(String(v), L.l - 6, y);
    }
    ctx.strokeStyle = css('--line');
    ctx.beginPath(); ctx.moveTo(L.l + 0.5, L.t); ctx.lineTo(L.l + 0.5, L.t + ph); ctx.lineTo(L.l + pw, L.t + ph + 0.5); ctx.stroke();

    // date and time along the bottom
    const long = b - a > 36 * 3600000;
    // at round times: the smallest step that leaves room for each label
    const MIN = 60000, room = Math.max(2, Math.floor(pw / (long ? 90 : 60)));
    const stepMs = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 43200].map((m) => m * MIN).find((m) => (b - a) / m <= room) ?? 43200 * MIN;
    const zone = new Date(a).getTimezoneOffset() * MIN; // round in local time
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = css('--muted');
    for (let t = Math.ceil((a - zone) / stepMs) * stepMs + zone; t <= b; t += stepMs) {
      ctx.strokeStyle = css('--line');
      ctx.beginPath(); ctx.moveTo(Math.round(X(t)) + 0.5, L.t + ph); ctx.lineTo(Math.round(X(t)) + 0.5, L.t + ph + 4); ctx.stroke();
      ctx.fillText(stepMs >= 1440 * MIN ? dateOnly(t) : long ? dateShort(t) : clockText(t), X(t), L.t + ph + 7);
    }

    // the recording, and what the ECG shows now
    if (this.recording) {
      ctx.fillStyle = css('--line');
      ctx.fillRect(X(this.recording[0]), L.t, Math.max(2, X(this.recording[1]) - X(this.recording[0])), ph);
    }
    if (this.shown) {
      ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.35;
      ctx.fillRect(X(this.shown[0]) - 1, L.t, Math.max(2, X(this.shown[1]) - X(this.shown[0])) + 2, ph);
      ctx.globalAlpha = 1;
    }

    if (!this.readings.length) {
      ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No readings in this time', L.l + pw / 2, L.t + ph / 2);
      return;
    }
    // systolic and diastolic: a line each, every value written at its point (systolic above, diastolic below)
    const series = [['systolic', 'Systolic', css('--series-1'), -1], ['diastolic', 'Diastolic', css('--critical'), 1]] as const;
    for (const [key, , color, side] of series) {
      const pts = this.readings.flatMap((r) => (r[key] == null ? [] : [[X(r.at), Y(r[key]!), r[key]!] as const]));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.fillStyle = color;
      for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI); ctx.fill(); }
      ctx.fillStyle = css('--ink'); ctx.textAlign = 'center'; ctx.textBaseline = side < 0 ? 'bottom' : 'top';
      for (const [x, y, v] of pts) ctx.fillText(String(v), Math.min(L.l + pw - 10, Math.max(L.l + 10, x)), y + side * 7);
    }
    // legend, top right
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let lx = L.l + pw;
    for (const [, name, color] of [...series].reverse()) {
      const tw = ctx.measureText(name).width;
      lx -= tw + 30;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, 10); ctx.lineTo(lx + 16, 10); ctx.stroke();
      ctx.fillStyle = css('--ink-2');
      ctx.fillText(name, lx + 21, 10);
    }
  }
}

const dateOnly = (ms: number): string => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
const dateShort = (ms: number): string => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const clockText = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** One device's sleep stages: `startS` seconds from the start of the sleep recording, one stage every `stepS` seconds. */
export interface StageTrack { startS: number; stepS: number; stages: readonly (SleepStageKey | 'asleep' | null)[] }

/**
 * The night's sleep stages from the Polar H10 and from the Watch D2, as colour blocks one big square tall above a sleep's
 * ECG, at the same moments; dragging one moves the ECG and every strip.
 */
export class StageStrips {
  private tracks: { polar: StageTrack | null; watch: StageTrack | null } | null = null;
  /** Seconds to add to a time in the ECG to get the same moment in the sleep recording. */
  private offsetS = 0;
  private readonly rows: { canvas: HTMLCanvasElement; value: HTMLElement; which: 'polar' | 'watch'; name: string }[] = [];

  constructor(private readonly box: HTMLElement, private readonly view: () => { t0: number; span: number }, private readonly pan: (dt: number) => void) {
    for (const [which, name] of [['polar', 'Sleep stages: Polar H10'], ['watch', 'Sleep stages: Watch D2']] as const) {
      const fig = document.createElement('figure');
      fig.className = 'chest-strip stage-strip';
      const cap = document.createElement('figcaption');
      const title = document.createElement('span');
      title.textContent = name;
      const value = document.createElement('span');
      value.className = 'muted';
      cap.append(title, value);
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', `${name}, at the same moments as the ECG below`);
      fig.append(cap, canvas);
      box.appendChild(fig);
      const row = { canvas, value, which, name };
      this.rows.push(row);
      this.drag(canvas);
      watch(canvas, () => this.drawOne(row));
    }
  }

  /** The stages to show (null: none, the strips are hidden), and where the ECG starts in the sleep recording. */
  set(tracks: { polar: StageTrack | null; watch: StageTrack | null } | null, offsetS = 0): void {
    this.tracks = tracks;
    this.offsetS = offsetS;
    this.box.hidden = !tracks;
    this.redraw();
  }

  /** Draws again: call when the ECG viewer moves. */
  redraw(): void { if (this.tracks) for (const r of this.rows) this.drawOne(r); }

  private drawOne(r: (typeof this.rows)[number]): void {
    if (!this.tracks) return;
    // one big square tall (5 mm) at the screen calibration and the ECG size setting, as the ECG's grid
    const px = `${Math.round(5 * pxPerMm() * ecgSize())}px`;
    if (r.canvas.style.height !== px) r.canvas.style.height = px;
    if (!r.canvas.clientWidth) return;
    const surface = setup(r.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const { t0, span } = this.view();
    const from = t0 + this.offsetS, to = from + span, pxPerS = w / span;
    const track = this.tracks[r.which];
    const at = (t: number): SleepStageKey | 'asleep' | null => {
      if (!track) return null;
      return track.stages[Math.floor((t - track.startS) / track.stepS)] ?? null;
    };
    let any = false;
    if (track) {
      const k0 = Math.max(0, Math.floor((from - track.startS) / track.stepS)), k1 = Math.min(track.stages.length - 1, Math.floor((to - track.startS) / track.stepS));
      for (let k = k0; k <= k1; k++) {
        const st = track.stages[k];
        if (!st) continue;
        any = true;
        const a = Math.max(0, (track.startS + k * track.stepS - from) * pxPerS), b = Math.min(w, (track.startS + (k + 1) * track.stepS - from) * pxPerS);
        ctx.fillStyle = css(st === 'asleep' ? '--muted' : STAGE_COLOR_VAR[st]);
        ctx.fillRect(Math.round(a), 0, Math.max(1, Math.round(b) - Math.round(a)), h);
      }
      // a change of stage inside the window: a thin surface gap marks the boundary
      ctx.fillStyle = css('--surface');
      for (let k = k0 + 1; k <= k1; k++) {
        if (track.stages[k] && track.stages[k - 1] && track.stages[k] !== track.stages[k - 1]) ctx.fillRect(Math.round((track.startS + k * track.stepS - from) * pxPerS) - 1, 0, 2, h);
      }
    }
    // the stage at the middle of the window, in words, so the colour isn't the only way to tell
    const mid = at(from + span / 2);
    r.value.textContent = !track ? ' · no sleep stages from this device for this night'
      : !any ? ' · no stage at this moment'
      : ` · ${mid === 'asleep' ? 'Asleep (stage not known)' : mid ? STAGE_LABEL[mid] : 'no stage'} at the middle`;
  }

  /** Dragging a strip moves the ECG and every strip together. */
  private drag(canvas: HTMLCanvasElement): void {
    let last: number | null = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); last = e.clientX; });
    canvas.addEventListener('pointermove', (e) => {
      if (last == null) return;
      const dx = e.clientX - last;
      last = e.clientX;
      this.pan(-(dx / canvas.clientWidth) * this.view().span);
    });
    const end = (): void => { last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }
}

export class ChestStrips {
  private data: ChestStripData | null = null;
  /** Seconds to add to a time in the ECG to get the same moment in the sleep recording. */
  private offsetS = 0;
  private readonly rows: { canvas: HTMLCanvasElement; value: HTMLElement; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void }[] = [];

  /** The ECG viewer's window, in seconds of the ECG: its left edge and how many seconds it shows. */
  private get t0(): number { return this.view().t0; }
  private get span(): number { return this.view().span; }

  constructor(private readonly box: HTMLElement, private readonly view: () => { t0: number; span: number }, private readonly pan: (dt: number) => void) {
    const row = (title: string, help: string, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void => {
      const fig = document.createElement('figure');
      fig.className = 'chest-strip';
      const cap = document.createElement('figcaption');
      const name = document.createElement('span');
      name.textContent = title;
      const value = document.createElement('span');
      value.className = 'muted';
      cap.append(name, value);
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', help);
      fig.append(cap, canvas);
      box.appendChild(fig);
      this.rows.push({ canvas, value, draw });
      this.drag(canvas);
      watch(canvas, () => this.drawOne(this.rows.find((r) => r.canvas === canvas)!));
    };
    row('Breathing (chest rise and fall)', 'Breathing from the chest strap’s movement, at the same moments as the ECG above', (ctx, w, h) => this.drawWave(ctx, w, h, 'breathing'));
    row('Movement', 'Body movement from the chest strap, at the same moments as the ECG above', (ctx, w, h) => this.drawWave(ctx, w, h, 'movement'));
    row('Heart rate (each beat)', 'Heart rate of each beat from the chest strap, at the same moments as the ECG above', (ctx, w, h) => this.drawHr(ctx, w, h));
  }

  /** The signals to show (null: none, the strips are hidden), and where the ECG starts in the sleep recording. */
  set(data: ChestStripData | null, offsetS = 0): void {
    this.data = data;
    this.offsetS = offsetS;
    this.box.hidden = !data;
    this.drawAll();
  }

  /** Draws again: call when the ECG viewer moves. */
  redraw(): void { this.drawAll(); }

  private drawAll(): void { if (this.data) for (const r of this.rows) this.drawOne(r); }

  private drawOne(r: (typeof this.rows)[number]): void {
    if (!this.data || !r.canvas.clientWidth) return;
    const surface = setup(r.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    // a faint second grid, as under the ECG: one line a second
    ctx.strokeStyle = css('--chart-grid') || css('--grid'); ctx.lineWidth = 1;
    const pxPerS = w / this.span;
    for (let s = Math.ceil(this.t0); s <= this.t0 + this.span; s++) {
      const x = Math.round((s - this.t0) * pxPerS) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    r.value.textContent = '';
    r.draw(ctx, w, h);
  }

  /** Breathing goes up and down around a middle line; movement rises from the bottom. Scaled to the minute around. */
  private drawWave(ctx: CanvasRenderingContext2D, w: number, h: number, which: 'breathing' | 'movement'): void {
    const d = this.data!, v = d[which], fs = d.fs;
    const from = this.t0 + this.offsetS, to = from + this.span;
    const i0 = Math.max(0, Math.floor(from * fs)), i1 = Math.min(v.length - 1, Math.ceil(to * fs));
    // the scale comes from the 30 s on each side, so it doesn't jump as the strip moves
    const w0 = Math.max(0, Math.floor((from - 30) * fs)), w1 = Math.min(v.length - 1, Math.ceil((to + 30) * fs));
    let top = 0;
    for (let i = w0; i <= w1; i++) { const x = Math.abs(v[i] ?? NaN); if (x > top) top = x; }
    const row = this.rows[which === 'breathing' ? 0 : 1]!;
    let any = false;
    for (let i = i0; i <= i1; i++) if (Number.isFinite(v[i])) { any = true; break; }
    if (!any || i1 < i0) { this.noReading(ctx, w, h, row); return; }
    top = Math.max(top, which === 'breathing' ? 5 : 20); // a still chest stays a flat line, not magnified noise
    const mid = which === 'breathing' ? h / 2 : h - 4;
    const scale = which === 'breathing' ? (h / 2 - 6) / top : (h - 10) / top;
    if (which === 'breathing') {
      ctx.strokeStyle = css('--line'); ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5); ctx.stroke();
    }
    ctx.strokeStyle = css(which === 'breathing' ? '--accent' : '--ink-2');
    ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const y = v[i] ?? NaN;
      if (!Number.isFinite(y)) { pen = false; continue; }
      const X = (i / fs - from) * (w / this.span), Y = mid - y * scale;
      if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
    }
    ctx.stroke();
    row.value.textContent = which === 'breathing' ? ` · scale ±${Math.round(top)} mG` : ` · scale 0–${Math.round(top)} mG`;
  }

  /** Each beat's heart rate as a step line, scaled to the minute around. */
  private drawHr(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const d = this.data!, row = this.rows[2]!;
    const from = this.t0 + this.offsetS, to = from + this.span;
    const first = lowerBound(d.beatT, from - 30), last = lowerBound(d.beatT, to + 30);
    let lo = Infinity, hi = -Infinity;
    for (let k = first; k < last; k++) { const v = d.hr[k] ?? NaN; if (v < lo) lo = v; if (v > hi) hi = v; }
    const a = Math.max(0, lowerBound(d.beatT, from) - 1), b = Math.min(d.beatT.length, lowerBound(d.beatT, to) + 1);
    if (!(hi >= lo) || b - a < 2) { this.noReading(ctx, w, h, row); return; }
    lo = Math.floor(lo - 3); hi = Math.ceil(hi + 3);
    const Y = (v: number): number => h - 6 - ((v - lo) / (hi - lo)) * (h - 18);
    const X = (t: number): number => (t - from) * (w / this.span);
    ctx.strokeStyle = css('--series-1'); ctx.fillStyle = css('--series-1'); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = a; k < b; k++) {
      const x = X(d.beatT[k] ?? 0), y = Y(d.hr[k] ?? 0);
      if (k === a) ctx.moveTo(x, y); else { ctx.lineTo(x, Y(d.hr[k - 1] ?? 0)); ctx.lineTo(x, y); }
    }
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let k = a; k < b; k++) {
      const x = X(d.beatT[k] ?? 0), y = Y(d.hr[k] ?? 0);
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill();
      if (this.span <= 15) { ctx.fillStyle = css('--muted'); ctx.fillText(String(Math.round(d.hr[k] ?? 0)), x, y - 4); ctx.fillStyle = css('--series-1'); }
    }
    row.value.textContent = ` · ${lo}–${hi} bpm`;
  }

  private noReading(ctx: CanvasRenderingContext2D, w: number, h: number, row: (typeof this.rows)[number]): void {
    ctx.fillStyle = css('--muted'); ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No reading from the strap at this moment', w / 2, h / 2);
    row.value.textContent = '';
  }

  /** Dragging a strip, or scrolling it sideways, moves the ECG and every strip together. */
  private drag(canvas: HTMLCanvasElement): void {
    let last: number | null = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); last = e.clientX; });
    canvas.addEventListener('pointermove', (e) => {
      if (last == null) return;
      const dx = e.clientX - last;
      last = e.clientX;
      this.pan(-(dx / canvas.clientWidth) * this.span);
    });
    const end = (): void => { last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!sideways) return;
      e.preventDefault();
      this.pan((sideways / canvas.clientWidth) * this.span);
    }, { passive: false });
  }
}

/** The first index whose value is at least `t` (the array is in order). */
function lowerBound(a: Float64Array, t: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if ((a[m] ?? 0) < t) lo = m + 1; else hi = m; }
  return lo;
}

// ---------- Sleep charts ----------

export type SleepStageKey = 'deep' | 'light' | 'rem' | 'awake';

/** Stage colour tokens (defined in styles.css for light and dark themes). */
export const STAGE_COLOR_VAR: Readonly<Record<SleepStageKey, string>> = {
  deep: '--stage-deep', light: '--stage-light', rem: '--stage-rem', awake: '--stage-awake',
};
export const STAGE_LABEL: Readonly<Record<SleepStageKey, string>> = {
  deep: 'Deep sleep', light: 'Light sleep', rem: 'REM sleep', awake: 'Awake',
};
const STAGE_ROWS: readonly SleepStageKey[] = ['awake', 'rem', 'light', 'deep']; // top to bottom

export const fmtClock = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** Sleep stages over the night as blocks on four rows, with a hover readout. */
export class Hypnogram {
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private stages: readonly (SleepStageKey | null)[] = [];
  private startMs = 0;
  private epochS = 30;
  private hover: number | null = null;

  constructor(wrap: HTMLElement) {
    const canvas = wrap.querySelector('canvas');
    if (!canvas) throw new Error('hypnogram has no canvas');
    this.canvas = canvas;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    wrap.appendChild(this.tip);
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.style.display = 'none'; this.draw(); });
    watch(canvas, () => this.draw());
  }

  set(stages: readonly (SleepStageKey | null)[], startMs: number, epochS: number): void {
    this.stages = stages; this.startMs = startMs; this.epochS = epochS; this.hover = null; this.draw();
  }

  private geometry(w: number, h: number): { l: number; r: number; t: number; rowH: number; pw: number } {
    const l = 78, r = 8, t = 6, b = 26;
    return { l, r, t, rowH: (h - t - b) / STAGE_ROWS.length, pw: w - l - r };
  }

  draw(): void {
    if (!this.stages.length || !this.canvas.clientWidth) return;
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const g = this.geometry(w, h);
    const n = this.stages.length;
    const X = (e: number): number => g.l + (e / n) * g.pw;
    ctx.font = '11px system-ui, sans-serif';
    // row labels and guides
    STAGE_ROWS.forEach((s, row) => {
      const y = g.t + row * g.rowH;
      ctx.fillStyle = css('--ink-2'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(STAGE_LABEL[s].replace(' sleep', ''), g.l - 8, y + g.rowH / 2);
      ctx.strokeStyle = css('--chart-grid'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.l, Math.round(y + g.rowH) + 0.5); ctx.lineTo(g.l + g.pw, Math.round(y + g.rowH) + 0.5); ctx.stroke();
    });
    // blocks, one per run of the same stage, with a 1 px gap between runs
    for (let e = 0; e < n;) {
      const s = this.stages[e] ?? null;
      let end = e + 1;
      while (end < n && (this.stages[end] ?? null) === s) end++;
      if (s) {
        const row = STAGE_ROWS.indexOf(s);
        const x0 = X(e), x1 = X(end);
        ctx.fillStyle = css(STAGE_COLOR_VAR[s]);
        const inset = g.rowH * 0.12;
        ctx.beginPath();
        ctx.roundRect(x0 + 0.5, g.t + row * g.rowH + inset, Math.max(1, x1 - x0 - 1), g.rowH - 2 * inset, 3);
        ctx.fill();
      }
      e = end;
    }
    // time axis: whole hours
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const totalMs = n * this.epochS * 1000;
    const firstHour = Math.ceil(this.startMs / 3600000) * 3600000;
    const stepH = g.pw / (totalMs / 3600000) < 45 ? 2 : 1;
    for (let tMs = firstHour; tMs <= this.startMs + totalMs; tMs += stepH * 3600000) {
      const x = g.l + ((tMs - this.startMs) / totalMs) * g.pw;
      ctx.fillText(fmtClock(tMs), x, h - 20);
    }
    if (this.hover !== null) {
      const x = X(this.hover + 0.5);
      ctx.strokeStyle = css('--ink-2'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, g.t); ctx.lineTo(Math.round(x) + 0.5, g.t + 4 * g.rowH); ctx.stroke();
    }
  }

  private move(e: PointerEvent): void {
    if (!this.stages.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const g = this.geometry(rect.width, rect.height);
    const n = this.stages.length;
    const idx = Math.floor(((e.clientX - rect.left - g.l) / g.pw) * n);
    if (idx < 0 || idx >= n) { this.hover = null; this.tip.style.display = 'none'; this.draw(); return; }
    // whole run under the pointer
    const s = this.stages[idx] ?? null;
    let a = idx, b = idx + 1;
    while (a > 0 && (this.stages[a - 1] ?? null) === s) a--;
    while (b < n && (this.stages[b] ?? null) === s) b++;
    this.hover = idx;
    this.draw();
    const from = this.startMs + a * this.epochS * 1000, to = this.startMs + b * this.epochS * 1000;
    const mins = Math.round(((b - a) * this.epochS) / 60);
    this.tip.innerHTML = `<b>${s ? STAGE_LABEL[s] : 'No data'}</b> · ${fmtClock(from)}–${fmtClock(to)} · ${mins} min`;
    this.tip.style.display = 'block';
    this.tip.style.left = `${Math.min(rect.width - this.tip.offsetWidth - 4, Math.max(4, e.clientX - rect.left + 10))}px`;
    this.tip.style.top = '4px';
  }
}

/** Ring of stage shares with a 2 px gap between segments; labels are shown next to it in HTML. */
export function drawDonut(canvas: HTMLCanvasElement, parts: readonly { key: SleepStageKey; value: number }[]): void {
  painters.set(canvas, () => drawDonut(canvas, parts));
  const surface = setup(canvas);
  if (!surface) return;
  const { ctx, w, h } = surface;
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = Math.min(w, h) / 2 - 4, cx = w / 2, cy = h / 2, thick = Math.max(10, r * 0.28);
  if (r <= thick) return; // not laid out yet (hidden)
  if (!total) {
    ctx.strokeStyle = css('--chart-grid'); ctx.lineWidth = thick;
    ctx.beginPath(); ctx.arc(cx, cy, r - thick / 2, 0, 2 * Math.PI); ctx.stroke();
    return;
  }
  const gap = 2 / (r - thick / 2); // 2 px of arc
  let a = -Math.PI / 2;
  for (const p of parts) {
    if (!p.value) continue;
    const sweep = (p.value / total) * 2 * Math.PI;
    ctx.strokeStyle = css(STAGE_COLOR_VAR[p.key]); ctx.lineWidth = thick; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, r - thick / 2, a + gap / 2, a + Math.max(gap, sweep - gap / 2)); ctx.stroke();
    a += sweep;
  }
}

/** Simple vertical bars with value labels and a hover readout. */
export class Bars {
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private items: readonly { label: string; value: number; title: string; highlight?: boolean }[] = [];
  private hover = -1;

  constructor(wrap: HTMLElement) {
    const canvas = wrap.querySelector('canvas');
    if (!canvas) throw new Error('bar chart has no canvas');
    this.canvas = canvas;
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    wrap.appendChild(this.tip);
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => { this.hover = -1; this.tip.style.display = 'none'; this.draw(); });
    watch(canvas, () => this.draw());
  }

  set(items: readonly { label: string; value: number; title: string; highlight?: boolean }[]): void {
    this.items = items; this.hover = -1; this.draw();
  }

  private slot(w: number): number { return (w - 16) / Math.max(1, this.items.length); }

  draw(): void {
    if (!this.canvas.clientWidth) return;
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const top = 18, bottom = 22, ph = h - top - bottom;
    const max = Math.max(1, ...this.items.map((i) => i.value));
    const slot = this.slot(w), bw = Math.min(28, slot * 0.55);
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.strokeStyle = css('--chart-grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8, top + ph + 0.5); ctx.lineTo(w - 8, top + ph + 0.5); ctx.stroke();
    this.items.forEach((it, i) => {
      const x = 8 + slot * (i + 0.5);
      const bh = (it.value / max) * ph;
      ctx.fillStyle = it.highlight ? css('--series-1') : css('--muted');
      ctx.globalAlpha = this.hover === -1 || this.hover === i ? 1 : 0.6;
      if (bh > 0) {
        ctx.beginPath();
        ctx.roundRect(x - bw / 2, top + ph - bh, bw, bh, [4, 4, 0, 0]);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = css('--ink-2'); ctx.textBaseline = 'bottom';
      ctx.fillText(String(it.value), x, top + ph - bh - 3);
      ctx.fillStyle = css('--muted'); ctx.textBaseline = 'top';
      ctx.fillText(it.label, x, top + ph + 6);
    });
  }

  private move(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - 8) / this.slot(rect.width));
    const it = this.items[i];
    if (!it) { this.hover = -1; this.tip.style.display = 'none'; this.draw(); return; }
    this.hover = i;
    this.draw();
    this.tip.innerHTML = it.title;
    this.tip.style.display = 'block';
    this.tip.style.left = `${Math.min(rect.width - this.tip.offsetWidth - 4, Math.max(4, e.clientX - rect.left + 10))}px`;
    this.tip.style.top = '4px';
  }
}
