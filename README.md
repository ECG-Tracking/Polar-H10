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
- **Demo modes** (rest and workout) with a simulated ECG, so everything can be tried without a sensor.

## Run locally
```bash
python3 -m http.server 8130
```
Open http://localhost:8130 in Chrome or Edge. Web Bluetooth works on `localhost` and on `https://` pages.

## Use on a phone
Web Bluetooth needs HTTPS, so host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages). No build step is needed. Then open it and choose *Install app* / *Add to Home Screen*.

| Platform | Browser |
|---|---|
| Windows, macOS, Linux, ChromeOS | Chrome or Edge |
| Android | Chrome |
| iPhone / iPad | **Bluefy** (Safari has no Web Bluetooth). Demo, history and import work in Safari. |

Tips: wet the strap electrodes, close other apps connected to the H10 (Polar Beat/Flow), and keep the battery above 50 %.

## How it works
| File | Role |
|---|---|
| `js/polar.js` | Web Bluetooth: Heart Rate service + Polar PMD ECG stream (130 Hz, µV) |
| `js/dsp.js` | Zero-phase 0.5–40 Hz band-pass + mains notch, Pan–Tompkins QRS detection with search-back, RR/morphology event classification, beat delineation (QRS onset/J by slope, T end by tangent method), HRV, spectrum, training metrics |
| `js/sim.js` | Synthetic ECG with respiratory HRV, ectopic beats and noise |
| `js/charts.js` | Canvas plots, live sweep trace, ECG viewer |
| `js/edf.js` | EDF+ writer/reader |
| `js/store.js` | IndexedDB sessions, settings |
| `js/app.js` | UI |

The live tiles re-analyse the last 60 s every second. Reports re-analyse the whole raw recording when opened, so changing settings (QTc formula, mains filter, max HR) updates past reports too.

### Known limits
- Analysis runs on the main thread. A 4 h report takes a few seconds to open.
- Delineation at 130 Hz has ~8 ms resolution. Use QRS/QT as trends, not clinical values.
- Detection is tuned for normal sinus rhythm. Atrial fibrillation or paced rhythms are not classified.

---
© 2026 ECG-Tracking. All rights reserved.
