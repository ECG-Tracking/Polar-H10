// Canvas charts: line/scatter plots with hover, live ECG sweep, and a zoomable ECG viewer.

import type { Analysis, EventType } from './dsp';

export function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
  ctx.clearRect(0, 0, w, h);
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
    new ResizeObserver(() => this.draw()).observe(canvas);
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

/** Sweep-style live ECG trace (like a bedside monitor). */
export class LiveTrace {
  private readonly len: number;
  private readonly buf: Float32Array;
  private pos = 0;
  private scale = 1500; // µV half-range

  constructor(private readonly canvas: HTMLCanvasElement, private readonly fs: number, seconds = 6) {
    this.len = Math.round(fs * seconds);
    this.buf = new Float32Array(this.len).fill(NaN);
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  push(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) { this.buf[this.pos] = values[i] ?? NaN; this.pos = (this.pos + 1) % this.len; }
    for (let i = 0; i < 6; i++) this.buf[(this.pos + i) % this.len] = NaN; // gap ahead of the cursor
  }

  clear(): void { this.buf.fill(NaN); this.pos = 0; this.draw(); }

  draw(): void {
    if (!this.canvas.clientWidth) return;
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    drawEcgGrid(ctx, w, h, w / (this.len / this.fs), h / ((2 * this.scale) / 1000));
    let peak = 0;
    for (const v of this.buf) if (Number.isFinite(v)) peak = Math.max(peak, Math.abs(v));
    this.scale = 0.9 * this.scale + 0.1 * Math.max(800, peak * 1.25);
    ctx.strokeStyle = css('--trace'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < this.len; i++) {
      const v = this.buf[i] ?? NaN;
      if (!Number.isFinite(v)) { pen = false; continue; }
      const x = (i / (this.len - 1)) * w, y = h / 2 - (v / this.scale) * (h / 2);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  }
}

// ECG paper: minor every 0.04 s / 0.1 mV, major every 0.2 s / 0.5 mV
function drawEcgGrid(ctx: CanvasRenderingContext2D, w: number, h: number, pxPerS: number, pxPerMv: number, t0 = 0): void {
  const minor = css('--grid'), major = css('--grid-major');
  const drawSet = (stepS: number, stepMv: number, color: string): void => {
    if (pxPerS * stepS < 4) return;
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

export interface ReportEvent { t: number; type: EventType; label: string }

/** Full-session ECG viewer: drag/swipe to pan, wheel/pinch or buttons to zoom. Fires 'move'. */
export class EcgViewer extends EventTarget {
  span = 8; // seconds shown
  t0 = 0; // seconds at the left edge
  duration = 0;
  private analysis: Analysis | null = null;
  private events: readonly ReportEvent[] = [];
  private range = 1000; // µV half-range

  constructor(private readonly canvas: HTMLCanvasElement) {
    super();
    const pointers = new Map<number, number>();
    let last: number | null = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e.clientX); last = null; });
    canvas.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (prev === undefined) return;
      pointers.set(e.pointerId, e.clientX);
      if (pointers.size === 1) {
        this.pan(-((e.clientX - prev) / canvas.clientWidth) * this.span);
      } else if (pointers.size === 2) {
        const [a = 0, b = 0] = [...pointers.values()];
        const dist = Math.abs(a - b);
        if (last) this.zoom(last / Math.max(10, dist));
        last = dist;
      }
    });
    const end = (e: PointerEvent): void => { pointers.delete(e.pointerId); last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.pan((e.deltaX / canvas.clientWidth) * this.span);
      else this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  load(analysis: Analysis, events: readonly ReportEvent[]): void {
    this.analysis = analysis;
    const x = analysis.x;
    this.duration = x.length / analysis.fs;
    this.events = events;
    this.span = Math.min(8, this.duration);
    this.t0 = 0;
    const s: number[] = [];
    for (let i = 0; i < x.length; i += Math.max(1, Math.floor(x.length / 5000))) s.push(Math.abs(x[i] ?? 0));
    s.sort((a, b) => a - b);
    this.range = Math.max(800, (s[Math.floor(s.length * 0.995)] || 1000) * 1.2);
    this.draw();
  }

  pan(dt: number): void { this.goTo(this.t0 + dt); }

  zoom(f: number): void {
    const mid = this.t0 + this.span / 2;
    this.span = Math.max(1.5, Math.min(Math.min(60, this.duration || 60), this.span * f));
    this.goTo(mid - this.span / 2);
  }

  goTo(t: number): void {
    if (!this.analysis) return;
    this.t0 = Math.max(0, Math.min(this.duration - this.span, t));
    this.draw();
    this.dispatchEvent(new Event('move'));
  }

  center(t: number): void { this.goTo(t - this.span / 2); }

  draw(): void {
    const a = this.analysis;
    if (!a || !this.canvas.clientWidth) return;
    const surface = setup(this.canvas);
    if (!surface) return;
    const { ctx, w, h } = surface;
    const x = a.x, fs = a.fs;
    const pxPerS = w / this.span;
    const pxPerMv = (h * 0.85) / ((2 * this.range) / 1000);
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
      const flagged = b.flags.length > 0;
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
