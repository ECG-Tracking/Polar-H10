// Canvas charts: line/scatter plots with hover, live ECG sweep, and a zoomable ECG viewer.

export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

export function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * spec: { type: 'line'|'scatter', points: [[x,y]], xLabel, yLabel, xFmt, yFmt,
 *         tooltip(p) -> string, refLines: [{y,label}], vLines: [{x,label}], identity, xDomain, yDomain }
 */
export class Plot {
  constructor(wrap) {
    this.wrap = wrap;
    this.canvas = wrap.querySelector('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    wrap.appendChild(this.tip);
    this.spec = null;
    this.hover = null;
    this.canvas.addEventListener('pointermove', (e) => this._move(e));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.style.display = 'none'; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  set(spec) { this.spec = spec; this.hover = null; this.draw(); }

  _layout(w, h) {
    const m = { l: 48, r: 12, t: 10, b: 34 };
    return { ...m, pw: w - m.l - m.r, ph: h - m.t - m.b };
  }

  draw() {
    const spec = this.spec;
    if (!spec || !this.canvas.clientWidth) return;
    const { ctx, w, h } = setup(this.canvas);
    const L = this._layout(w, h);
    const pts = spec.points.filter((p) => p[1] != null && Number.isFinite(p[1]));
    const ink2 = css('--ink-2'), muted = css('--muted'), grid = css('--chart-grid'), series = spec.color || css('--series-1');
    ctx.font = '11px system-ui, sans-serif';

    if (!pts.length) {
      ctx.fillStyle = muted; ctx.textAlign = 'center';
      ctx.fillText(spec.empty || 'Not enough data', w / 2, h / 2);
      return;
    }
    let [x0, x1] = spec.xDomain || [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))];
    let [y0, y1] = spec.yDomain || [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
    if (spec.identity) { x0 = y0 = Math.min(x0, y0); x1 = y1 = Math.max(x1, y1); }
    const padY = (y1 - y0) * 0.08 || 5, padX = spec.type === 'scatter' ? (x1 - x0) * 0.06 || 5 : 0;
    if (!spec.yDomain) { y0 -= padY; y1 += padY; }
    if (!spec.xDomain) { x0 -= padX; x1 += padX; }
    const xt = niceTicks(x0, x1, Math.max(2, Math.floor(L.pw / 80)));
    const yt = niceTicks(y0, y1, Math.max(2, Math.floor(L.ph / 40)));
    const X = (v) => L.l + ((v - x0) / (x1 - x0 || 1)) * L.pw;
    const Y = (v) => L.t + L.ph - ((v - y0) / (y1 - y0 || 1)) * L.ph;
    this._map = { X, Y, pts, L };

    // grid + axes
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = muted;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt) {
      if (v < y0 || v > y1) continue;
      ctx.beginPath(); ctx.moveTo(L.l, Y(v) + 0.5); ctx.lineTo(L.l + L.pw, Y(v) + 0.5); ctx.stroke();
      ctx.fillText((spec.yFmt || String)(v), L.l - 6, Y(v));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt) if (v >= x0 && v <= x1) ctx.fillText((spec.xFmt || String)(v), X(v), L.t + L.ph + 6);
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
    for (const r of spec.refLines || []) {
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(L.l, Y(r.y)); ctx.lineTo(L.l + L.pw, Y(r.y)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ink2; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(r.label, L.l + L.pw - 4, Y(r.y) - 2);
    }
    for (const v of spec.vLines || []) {
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(v.x), L.t); ctx.lineTo(X(v.x), L.t + L.ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(v.label, X(v.x) + 3, L.t + 2 + (v.row || 0) * 13);
    }

    if (spec.type === 'line') {
      ctx.strokeStyle = series; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (const p of spec.points) {
        if (p[1] == null) { pen = false; continue; }
        if (pen) ctx.lineTo(X(p[0]), Y(p[1])); else { ctx.moveTo(X(p[0]), Y(p[1])); pen = true; }
      }
      ctx.stroke();
    } else {
      const r = pts.length > 2000 ? 2 : 3;
      ctx.globalAlpha = pts.length > 500 ? 0.45 : 0.8;
      for (const p of pts) {
        ctx.fillStyle = p[2] ? css('--critical') : series;
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

  _move(e) {
    if (!this._map || !this.spec) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { X, Y, pts } = this._map;
    let best = null, bd = Infinity;
    for (const p of pts) {
      const d = this.spec.type === 'line' ? Math.abs(X(p[0]) - mx) : Math.hypot(X(p[0]) - mx, Y(p[1]) - my);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best || (this.spec.type === 'scatter' && bd > 16)) {
      this.hover = null; this.tip.style.display = 'none'; this.draw(); return;
    }
    this.hover = best;
    this.draw();
    this.tip.innerHTML = this.spec.tooltip ? this.spec.tooltip(best) : `${best[0]}, ${best[1]}`;
    this.tip.style.display = 'block';
    const tx = Math.min(rect.width - this.tip.offsetWidth - 4, Math.max(4, X(best[0]) + 10));
    this.tip.style.left = `${tx}px`;
    this.tip.style.top = `${Math.max(4, Y(best[1]) - this.tip.offsetHeight - 8)}px`;
  }
}

/** Sweep-style live ECG trace (like a bedside monitor). */
export class LiveTrace {
  constructor(canvas, fs, seconds = 6) {
    this.canvas = canvas;
    this.fs = fs;
    this.len = Math.round(fs * seconds);
    this.buf = new Float32Array(this.len).fill(NaN);
    this.pos = 0;
    this.scale = 1500; // µV half-range
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  push(values) {
    for (const v of values) { this.buf[this.pos] = v; this.pos = (this.pos + 1) % this.len; }
    for (let i = 0; i < 6; i++) this.buf[(this.pos + i) % this.len] = NaN; // gap ahead of the cursor
  }
  clear() { this.buf.fill(NaN); this.pos = 0; this.draw(); }
  draw() {
    if (!this.canvas.clientWidth) return;
    const { ctx, w, h } = setup(this.canvas);
    drawEcgGrid(ctx, w, h, w / (this.len / this.fs), h / (2 * this.scale / 1000));
    let peak = 0;
    for (const v of this.buf) if (Number.isFinite(v)) peak = Math.max(peak, Math.abs(v));
    this.scale = 0.9 * this.scale + 0.1 * Math.max(800, peak * 1.25);
    ctx.strokeStyle = css('--trace'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < this.len; i++) {
      const v = this.buf[i];
      if (!Number.isFinite(v)) { pen = false; continue; }
      const x = (i / (this.len - 1)) * w, y = h / 2 - (v / this.scale) * (h / 2);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
  }
}

// ECG paper: minor every 0.04 s / 0.1 mV, major every 0.2 s / 0.5 mV
function drawEcgGrid(ctx, w, h, pxPerS, pxPerMv, t0 = 0) {
  const minor = css('--grid'), major = css('--grid-major');
  const drawSet = (stepS, stepMv, color) => {
    if (pxPerS * stepS < 4) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    const first = Math.ceil(t0 / stepS) * stepS;
    for (let t = first; (t - t0) * pxPerS <= w; t += stepS) { const x = Math.round((t - t0) * pxPerS) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = h / 2 % (pxPerMv * stepMv); y <= h; y += pxPerMv * stepMv) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  };
  drawSet(0.04, 0.1, minor);
  drawSet(0.2, 0.5, major);
}

/** Full-session ECG viewer: drag/swipe to pan, wheel/pinch or buttons to zoom. */
export class EcgViewer extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.x = null;
    this.span = 8;
    this.t0 = 0;
    const pointers = new Map();
    let last = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, e.clientX); last = null; });
    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, e.clientX);
      if (pointers.size === 1) {
        this.pan(-((e.clientX - prev) / canvas.clientWidth) * this.span);
      } else if (pointers.size === 2) {
        const xs = [...pointers.values()];
        const dist = Math.abs(xs[0] - xs[1]);
        if (last) this.zoom(last / Math.max(10, dist));
        last = dist;
      }
    });
    const end = (e) => { pointers.delete(e.pointerId); last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.pan((e.deltaX / canvas.clientWidth) * this.span);
      else this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  load(analysis, events) {
    this.a = analysis;
    this.x = analysis.x;
    this.fs = analysis.fs;
    this.duration = this.x.length / this.fs;
    this.events = events;
    this.span = Math.min(8, this.duration);
    this.t0 = 0;
    let s = [];
    for (let i = 0; i < this.x.length; i += Math.max(1, Math.floor(this.x.length / 5000))) s.push(Math.abs(this.x[i]));
    s.sort((a, b) => a - b);
    this.range = Math.max(800, (s[Math.floor(s.length * 0.995)] || 1000) * 1.2);
    this.draw();
  }

  pan(dt) { this.goTo(this.t0 + dt); }
  zoom(f) {
    const mid = this.t0 + this.span / 2;
    this.span = Math.max(1.5, Math.min(Math.min(60, this.duration || 60), this.span * f));
    this.goTo(mid - this.span / 2);
  }
  goTo(t) {
    if (!this.x) return;
    this.t0 = Math.max(0, Math.min(this.duration - this.span, t));
    this.draw();
    this.dispatchEvent(new Event('move'));
  }
  center(t) { this.goTo(t - this.span / 2); }

  draw() {
    if (!this.x || !this.canvas.clientWidth) return;
    const { ctx, w, h } = setup(this.canvas);
    const pxPerS = w / this.span;
    const pxPerMv = (h * 0.85) / (2 * this.range / 1000);
    drawEcgGrid(ctx, w, h, pxPerS, pxPerMv, this.t0);
    const fs = this.fs;
    const i0 = Math.max(0, Math.floor(this.t0 * fs)), i1 = Math.min(this.x.length - 1, Math.ceil((this.t0 + this.span) * fs));
    const X = (i) => (i / fs - this.t0) * pxPerS;
    const Y = (v) => h / 2 - (v / 1000) * pxPerMv;

    ctx.strokeStyle = css('--trace'); ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) i === i0 ? ctx.moveTo(X(i), Y(this.x[i])) : ctx.lineTo(X(i), Y(this.x[i]));
    ctx.stroke();

    // beat annotations
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const showDetail = this.span <= 12;
    for (const b of this.a.beats) {
      if (b.t < this.t0 - 1 || b.t > this.t0 + this.span + 1) continue;
      const bx = X(b.t * fs);
      const flagged = b.flags.length > 0;
      ctx.fillStyle = flagged ? css('--critical') : css('--muted');
      if (b.rr && showDetail) ctx.fillText(`${Math.round(b.rr)}`, bx, 4);
      if (flagged) {
        ctx.beginPath(); ctx.moveTo(bx - 5, 20); ctx.lineTo(bx + 5, 20); ctx.lineTo(bx, 27); ctx.fill();
      }
      if (showDetail && b.m && this.span <= 6) {
        ctx.fillStyle = css('--series-1');
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
