# OpenBeat ECG

Free ECG recording and analysis for the **Polar H10** chest strap. It is an installable web app (PWA) that runs on desktop and mobile with no account, no usage limit and no upload: recordings stay in the browser's storage on your device.

> Not a medical device. Results are statistical estimates from a single-lead chest strap and can be wrong.

## Features
- **Live:** ECG trace, heart rate, HRV score, pNN50, event count and training zone. Start/Stop recording, *Mark event* button, files split automatically every 4 h, screen kept awake while recording.
- **Alerts (optional):** beep/vibrate when HR leaves your zone, pNN50 > 45 %, or an event is detected.
- **Report:** mean HR, HRV score (15 × ln RMSSD), RMSSD, SDNN, pNN50, pNN200, Poincaré SD1/SD2, QRS, QT, QTc (Bazett or Fridericia), % positive T waves, J point, ST at J+60 ms, R amplitude, 2–8 Hz energy share, TRIMP effort, 60 s heart-rate recovery, time in zones.
- **Charts:** HR over time, median beat with Q/J/T-end markers, Poincaré plot, RR vs QTc, and a zoomable/pannable ECG viewer (drag, wheel, pinch) with RR labels and events.
- **Events:** premature beats, pauses and irregular beat shapes are detected automatically. User marks are shown too.
- **Export/import:** EDF+ (signal + annotations, opens in EDFBrowser/MATLAB), per-beat CSV, JSON report, print to PDF. EDF files can be imported back.
- **Sign-in:** email and password (Supabase). Each account has its own data on the device. **Summaries sync** to the account and appear on your other devices: each ECG recording's results, heart-rate trend, average beat, first 30 s and up to 50 event strips, and each night's sleep report. The full ECG, raw sleep data and settings stay on the device that recorded them.
- **Users 1–9:** choose a user at the top of the Live or Settings screen; each has their own recordings, settings and biodata (age, sex, height, weight, waist, resting and max HR), with BMI and waist-to-height shown. Recordings from before users existed belong to User 1.
- **Sleep monitor:** overnight recording of heart beats and chest movement. The report shows night sleep, a sleep-stage graph, bed/asleep/wake times, a sleep score, awakenings over the last 7 nights, deep/light/REM shares, heart rate, HRV, breathing rate and regularity, efficiency, and reference or personal ranges. Stages are estimates; SpO₂ isn't available (the H10 has no optical sensor). A **Demo night** shows a full report without recording.
- **Demo modes** (rest and workout) with a simulated ECG, so everything can be tried without a sensor.

## Supabase setup (once)
1. **Authentication → Sign In / Providers → Email:** turn off **Confirm email**, then Save.
2. **SQL Editor → New query:** paste `supabase/setup.sql`, then Run. It creates the `ecg_sessions` and `sleep_nights` tables and the access rules.

## Develop
The source is strict TypeScript in `src/` (same compiler settings as the Portfolio Optimizer project). `app.js` is **generated**: never edit it by hand.

Needs Node.js 18+. On this Mac it is the official build in `~/.local/node` (add `export PATH="$HOME/.local/node/bin:$PATH"` to `~/.zprofile` to use it in Terminal).

| Command | Does |
|---|---|
| `npm install` | Installs TypeScript 5.4.5, esbuild 0.21.5 and type definitions into `node_modules/` (not uploaded) |
| `npm run typecheck` | Strict type check of `src/` and `tests/` |
| `npm run build` | Bundles `src/main.ts` (and everything it uses) into a minified `app.js` |
| `npm test` | Runs `tests/*.test.ts` with `node --test` |
| `npm run check` | All three. `publish.command` runs this first and uploads nothing if it fails |

Run locally after building:
```bash
python3 -m http.server 8130
```
Open http://localhost:8130 in Chrome or Edge. Web Bluetooth works on `localhost` and on `https://` pages.

## Use on a phone
Web Bluetooth needs HTTPS, so host the folder (after `npm run build`) on any static host (GitHub Pages, Netlify, Cloudflare Pages). Then open it and choose *Install app* / *Add to Home Screen*.

| Platform | Browser |
|---|---|
| Windows, macOS, Linux, ChromeOS | Chrome or Edge |
| Android | Chrome |
| iPhone / iPad | **Bluefy** (Safari has no Web Bluetooth). Demo, history and import work in Safari. |

Tips: wet the strap electrodes, close other apps connected to the H10 (Polar Beat/Flow), and keep the battery above 50 %.

## How it works
| File | Role |
|---|---|
| `src/polar.ts` | Web Bluetooth: Heart Rate service + Polar PMD ECG stream (130 Hz, µV) |
| `src/dsp.ts` | Zero-phase 0.5–40 Hz band-pass + mains notch, Pan–Tompkins QRS detection with search-back, RR/morphology event classification, beat delineation (QRS onset/J by slope, T end by tangent method), HRV, spectrum, training metrics |
| `src/sim.ts` | Synthetic ECG with respiratory HRV, ectopic beats and noise |
| `src/charts.ts` | Canvas plots, live sweep trace, ECG viewer |
| `src/edf.ts` | EDF+ writer/reader |
| `src/store.ts` | IndexedDB sessions; settings (validated on load) |
| `src/ranges.ts` | Reference ranges and their sources |
| `src/util.ts` | Shared helpers |
| `src/sleep.ts` | Sleep analysis (30 s epochs) and the overnight recorder |
| `src/sleepsim.ts` | Simulated night |
| `src/sleepui.ts` | Sleep monitor, sleep history and sleep report |
| `src/ui.ts` | Shared screen helpers and report tiles |
| `src/main.ts` | Entry point: sign-in, then starts the app |
| `src/account.ts`, `src/cloud.ts`, `src/summary.ts` | Supabase account, cloud sync, and what is synced (summaries) |
| `src/app.ts` | ECG screens, users, settings |
| `tests/` | Beat detection, metrics, EDF round trip, reference ranges, users, sleep analysis |

The live tiles re-analyse the last 60 s every second. Reports re-analyse the whole raw recording when opened, so changing settings (QTc formula, mains filter, max HR) updates past reports too.

### Known limits
- Analysis runs on the main thread. A 4 h report takes a few seconds to open.
- Delineation at 130 Hz has ~8 ms resolution. Use QRS/QT as trends, not clinical values.
- Detection is tuned for normal sinus rhythm. Atrial fibrillation or paced rhythms are not classified.

---
© 2026 ECG-Tracking. All rights reserved.
