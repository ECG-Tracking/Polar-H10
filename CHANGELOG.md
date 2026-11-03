# OpenBeat ECG – change history

Newest first. Live site: https://ecg-tracking.github.io/Polar-H10/ (repository github.com/ecg-tracking/Polar-H10).
Entries marked *(GitHub)* appear under **Commits** in that repository; the oldest ones were published to a previous site that is no longer used.
An exact copy of every upload is kept in the `GitHub uploads` folder (on this Mac only).

## 3 Nov 2026 – D2 download and sync error fixes *(GitHub)*
Why: a 5.4 KB sleep download stopped part-way, and the cloud sync reported "isn't set up" for an unrelated error.

| File | Change |
|---|---|
| `src/d2/link.ts` | File pieces are appended in the order they arrive, as Gadgetbridge does (the watch's per-piece offset is only logged); pieces are handled one at a time; a stalled block is asked for again up to 3 times; the log shows block size, the first pieces' offsets and how far it got |
| `src/cloud.ts` | "Cloud storage isn't set up" only for a missing table or column; any other error is shown as it is, so its real cause can be seen |
| `tests/d2fake.ts`, `tests/d2.test.ts` | Fake watch can count offsets per block or skip a block request; new test for both |

## 3 Nov 2026 – Watch maker's name removed *(GitHub)*
Why: avoid naming the watch's maker anywhere in the app.

| File | Change |
|---|---|
| `src/d2/*.ts`, `tests/d2*.ts`, `scripts/build.mjs`, `supabase/setup.sql`, `LICENSE-D2-LINK.txt`, `CHANGELOG.md` | Screen text, connection-log messages, comments and notes now say "the watch", "the watch's phone app" and "Gadgetbridge's watch support"; the watch's own reported name is shown without its brand (e.g. "WATCH D2-8F4"). Two identifiers the watch requires inside its login message are kept as they are (never shown on screen) |

## 3 Nov 2026 – D2 Link: naps, score explanation, Week and Month *(GitHub)*
Why: 50 synced records (30 nights, 20 naps) showed how the watch's results fit together.

| File | Change |
|---|---|
| `src/d2/night.ts` (new) | Night figures moved here; naps (stage 5, no score) recognised and dated by their day |
| `src/d2/score.ts` (new) | Estimate of the watch's sleep score: starting point + duration (hours up to 8; beyond 8 counts against) + sleep efficiency + deep sleep %; fitted to the user's own scored nights once there are 10 (on the 30 nights so far: within 1.1 points on average) |
| `src/d2/trends.ts`, `src/d2/trendsui.ts` (new) | Week and Month views: averages (score, night sleep with bed/wake times, deep %, heart rate, HRV), night sleep per day stacked deep/light/REM (tap a bar to open the night), trend lines for score, deep sleep, heart rate and HRV; Month adds a weekly averages table. Naps are left out |
| `src/d2/ui.ts`, `src/d2/dom.ts` (new) | Nights / Week / Month tabs; naps kept out of the night list and shown as "Naps that day" in the night's report (naps on a day without a night get their own row); new "What made your score" card; durations under an hour shown in minutes; clearer message when sync can't reach the internet |
| `styles.css` | Styles for the above |
| `tests/d2.test.ts` | New tests for naps, the score fit and the week/month calculations |

## 3 Nov 2026 – D2 Link: export all nights *(GitHub)*
| File | Change |
|---|---|
| `src/d2/ui.ts` | "Export all nights" saves every night from the watch (this user, demo nights left out) as one JSON file |

## 3 Nov 2026 – D2 Link nights sync between devices *(GitHub)*
Why: nights downloaded from the watch on the phone should also be seen on the MacBook.

| File | Change |
|---|---|
| `supabase/setup.sql` | New table `d2_nights` (one row per night: stages and the watch's summary, about 2 KB) with the same access rules as the others. **Run setup.sql again in Supabase** |
| `src/d2/cloud.ts` (new) | Syncs D2 nights both ways: uploads new nights, downloads nights from other devices, carries deletions across; checks every downloaded night; demo nights stay on the device |
| `src/d2/store.ts`, `src/d2/ui.ts` | Nights remember whether they are in the cloud; sync when the tab opens, after a download and after a delete, plus a "Sync now" button and status line; deleting a synced night asks to delete it everywhere |
| `src/app.ts` | Passes the signed-in cloud connection to D2 Link (D2 Link's code stays in d2link.js) |
| `tests/d2.test.ts` | New test for reading nights back from the cloud |

## 3 Nov 2026 – D2 Link report matches the watch's phone app *(GitHub)*
Why: the downloaded night (JSON) showed how the watch's phone app builds its sleep page from the watch's record.

| File | Change |
|---|---|
| `src/d2/ui.ts` | "Bed time" is when sleep started (fallAsleepTime) and the stage chart runs from falling asleep to waking up, as in the watch's phone app; durations, percentages and times woke up use that window. "Breathing quality" shows "--" (it isn't in the watch's sleep record; the earlier value was a different field). New "More from the watch" card: time in bed (lying down to getting up), time to fall asleep, sleep efficiency, minutes awake in the night |
| `styles.css` | Style for the new card |
| `tests/d2.test.ts` | New test for the night window |

## 3 Nov 2026 – D2 Link: times woke up from the stages *(GitHub)*
Why: the first real night from the watch (6 h 49 min, 82 points, matching the watch's phone app) arrived without the watch's "times woke up" number.

| File | Change |
|---|---|
| `src/d2/ui.ts` | When the watch doesn't send it, times woke up is counted from the stage chart (awake spells between falling asleep and the last sleep), as the phone app shows it; used in the tile and the 7-night chart; the tile says when it was counted |
| `tests/d2.test.ts` | New test |

## 3 Nov 2026 – D2 Link: last login message number *(GitHub)*
Why: with a saved pairing the watch didn't answer the last login message.

| File | Change |
|---|---|
| `src/d2/link.ts` | When logging in, the last message is numbered 0x13 (step 3's number, since step 3 is skipped), as Gadgetbridge does, instead of 0x14 |
| `tests/d2fake.ts`, `tests/d2.test.ts` | The fake watch now ignores messages with the wrong number, like a real watch; tests check the numbers for pairing (1–4) and logging in (0x11–0x13) |

## 3 Nov 2026 – D2 Link: login step after pairing *(GitHub)*
Why: the watch accepted the pairing, then D2 Link wrongly took the next (classic) login reply for a newer "PAKE" login.

| File | Change |
|---|---|
| `src/d2/link.ts` | A reply numbered 0x8000 + our message (e.g. 32785) with isoSalt/token is the classic login, as it is; only replies with an ephemeral key ("epk"/"challenge") count as PAKE. A new pairing is handed over as soon as the watch accepts it |
| `src/d2/ui.ts` | Saves the pairing at that moment, so a later failure doesn't mean pairing again |
| `tests/d2.test.ts` | New tests for both |

## 3 Nov 2026 – New versions load straight away *(GitHub)*
Why: phones kept using the previous app and D2 Link for up to 10 minutes after publishing (GitHub's browser cache).

| File | Change |
|---|---|
| `sw.js` | The offline helper asks the server whether each file changed before using a saved copy (unchanged files aren't downloaded again); offline cache v11 |

## 3 Nov 2026 – D2 Link: tolerant login reading *(GitHub)*
Why: the watch's first login reply (805 bytes in field 0x01) was not accepted as JSON by the browser.

| File | Change |
|---|---|
| `src/d2/link.ts` | Login replies are read like Java (Gadgetbridge) reads them: the JSON object is taken from the text and anything around it, such as a trailing zero byte, is ignored; if it still can't be read, the log shows how the text starts and ends (no content) |
| `tests/d2.test.ts` | New test for a reply with a trailing zero byte |

## 3 Nov 2026 – D2 Link always loads the latest version *(GitHub)*
Why: the phone kept using the previous D2 Link for up to 10 minutes after publishing (browser cache).

| File | Change |
|---|---|
| `scripts/build.mjs`, `src/app.ts` | The app loads `d2link.js?v=<version>`, with the version taken from the file's content, so each published D2 Link is fetched fresh |

## 3 Nov 2026 – D2 Link: login reply fix *(GitHub)*
Why: on an Android phone the watch connected and sent its pairing code, then D2 Link couldn't read the watch's first login reply.

| File | Change |
|---|---|
| `src/d2/link.ts` | Reads both layouts these watches use for login replies (and a payload sent as text); names the newer "PAKE" login if the watch uses it; when a reply still can't be read, the connection log shows its layout (field sizes and JSON keys, no values) |
| `src/d2/serial.ts` | The port is fully closed after the watch disconnects, and a port left open by an earlier attempt is closed and reopened ("The port is already open") |
| `src/d2/ui.ts` | Instructions now say Chrome on an Android phone (tested) or a computer; a Mac may not get an answer from the watch |
| `tests/d2.test.ts` | New test for the login reply layouts |

## 3 Nov 2026 – D2 Link: second way to connect *(GitHub)*
Why: on a Mac, Chrome found the watch but its own Bluetooth connection timed out ("SDP query timeout").

| File | Change |
|---|---|
| `src/d2/serial.ts`, `src/d2/ui.ts` | New "Use the computer’s serial port" button: choose the port macOS made for the watch (the cu.… port with the watch's name), which skips Chrome's own Bluetooth look-up; the log shows which port was chosen; clearer messages when a port can't be opened or the watch doesn't answer on it |

## 3 Nov 2026 – D2 Link *(GitHub)*
Why: download sleep from a Watch D2 straight into the app, shown like the watch's phone app shows it.

| File | Change |
|---|---|
| `src/d2/` (new) | D2 Link, ported from Gadgetbridge's watch support: packet framing and encryption, the HiChain pairing/login, the watch's sleep file download and reader, local storage of nights and the pairing, and the D2 Link screen with a night report in the style of the watch's phone app (stage chart, score and stars, times woke up, deep/light/REM donut, reference tiles) |
| `d2link.js` (new) | Built from `src/d2` as a separate, readable script that loads when the D2 Link tab is opened |
| `LICENSE-D2-LINK.txt` (new) | D2 Link is open source under the GNU AGPL v3 (required because it is built on Gadgetbridge); the rest of the app stays "All rights reserved" |
| `index.html`, `src/app.ts`, `styles.css` | New "D2 Link" tab between Sleep history and Settings; on that tab the footer says "Open Source" with the licence, Gadgetbridge credit and source link |
| `scripts/build.mjs`, `sw.js` | Builds `d2link.js`; offline cache v10 includes it |
| `tests/d2.test.ts`, `tests/d2fake.ts` (new) | Packet bytes checked against Gadgetbridge's own test vectors; pairing, login and download tested end to end against a fake watch |

Needs Chrome 117+ on a computer, with the watch paired in the computer's Bluetooth settings. Not yet tested with a real Watch D2.

## 2 Nov 2026 – Sleep & ECG recording *(GitHub)*
Why: record a night's sleep and its ECG in one go, and read both in one report.

| File | Change |
|---|---|
| `index.html`, `styles.css` | Sleep monitor: new **Start sleep & ECG recording** button under Start sleep recording; sleep report: new "ECG during the night" section after the sleep results; ECG report: **Open sleep report** button |
| `src/sleepui.ts` | Connecting from Sleep monitor also starts the ECG stream; the combined recording saves the night plus an ECG recording (if at least 10 min) linked to each other; the night's report shows the ECG results after the sleep output; deleting the night asks whether to delete its ECG too (kept ECGs are unlinked) |
| `src/app.ts` | The night's ECG section: values outside the range, Rhythm and HRV, ECG waves, and **Open full ECG report**; ECG history marks these recordings "with sleep"; Open sleep report appears only while the night exists |
| `src/store.ts`, `src/summary.ts`, `src/cloud.ts` | The link between a night and its ECG is stored and synced both ways (no new cloud tables, so setup.sql doesn't need re-running) |
| `tests/summary.test.ts` | New test: the link survives a trip through the cloud |

## 2 Nov 2026 – Private notes excluded *(GitHub)*
| File | Change |
|---|---|
| `.gitignore` | Word documents (`*.docx`) and Word's temporary `~$` files are never uploaded; PUBLISHING-INSTRUCTIONS.md stays on this Mac |

## 2 Nov 2026 – Supabase permissions *(GitHub)*
| File | Change |
|---|---|
| `supabase/setup.sql` | Grants signed-in users access to the ecg_sessions and sleep_nights tables (this project doesn't grant it automatically) and keeps signed-out visitors out; the access rules still limit each account to its own rows |

## 2 Nov 2026 – Sign-in and cloud sync of summaries *(GitHub)*
Why: a login like the Portfolio Optimizer's; ECG and sleep history available on all your devices while keeping cloud storage small.

| File | Change |
|---|---|
| `src/main.ts` | New entry point: sign in or create an account (email + password, Show/Hide), then the app starts for that account; stays signed in until you sign out; opens offline for the account last signed in |
| `src/account.ts` | New: Supabase client (project legllfdwjfttagxmclio), signed-in account, sign out |
| `src/summary.ts` | New: what is synced. ECG: results, heart-rate trend, average beat, first 30 s and up to 50 event strips (10 s each; marked events first). Sleep: the report's numbers and per-30-s stages, heart rate, breathing and movement |
| `src/cloud.ts` | New: syncs ECG summaries and sleep reports both ways and carries deletions across devices; the full ECG and raw sleep data are never uploaded |
| `src/store.ts` | Each account has its own database and settings on the device (the first account to sign in keeps the existing data); summary copies from other devices (database version 3) |
| `src/app.ts` | Summary copies open as labelled reports: stored results and charts, the first 30 s and event strips in the viewer (click an event), EDF/CSV need the full ECG; syncs after saving, importing or deleting |
| `src/sleepui.ts` | Synced nights open from their stored report, labelled as synced copies; syncs after saving or deleting a night |
| `index.html`, `styles.css` | Sign-in and create-account screens; Settings → Account (email, sync status, Sync now, Sign out); summary-copy note |
| `supabase/setup.sql` | New: run once in Supabase to create the ecg_sessions and sleep_nights tables and their access rules (each account only reaches its own data) |
| `package.json`, `scripts/build.mjs` | Supabase JS 2.116.0 bundled into app.js (works offline); app.js is now minified |
| `sw.js` | Offline cache v9 |
| `tests/account.test.ts`, `tests/summary.test.ts` | 8 new tests (29 in total) |

Sizes measured: a 1-hour ECG summary is about 32 KB without events and about 205 KB with all 50 event strips (the full ECG would be about 0.94 MB); an 8-hour night's report is about 13 KB (raw data about 4.7 MB).

## 2 Nov 2026 – Sleep monitor and sleep history *(GitHub)*
Why: overnight sleep tracking with the Polar H10, with a report similar to a sleep-tracker app's.

| File | Change |
|---|---|
| `index.html`, `styles.css` | Top row: ECG live, ECG history, Sleep monitor, Sleep history, Settings (wraps onto two lines on phones); new Sleep monitor, Sleep history and sleep report screens; dim-screen overlay; validated stage colours for light and dark themes |
| `src/polar.ts` | Polar motion sensor (accelerometer, 25 Hz) alongside heart rate; choose which streams to run; reconnect to the same strap without asking again |
| `src/sleep.ts` | New: overnight analysis in 30 s epochs — asleep/awake from movement and heart rate, bed time, fell asleep, woke up, awakenings (≥ 2 min), breathing rate and regularity from chest movement, heart rate and HRV (RMSSD) from beat intervals, estimated deep/light/REM, deep-sleep continuity, efficiency, documented sleep score; live recorder that keeps timing across strap dropouts |
| `src/sleepsim.ts` | New: simulated night for the "Demo night" button and tests |
| `src/sleepui.ts` | New: Sleep monitor (connect, start/stop, live heart rate and movement, dim screen, automatic reconnect), Sleep history per user, and the report: night sleep, hypnogram, bed/asleep/wake times, score, times woke up over the last 7 nights, stage ring, 14 tiles with reference or personal ranges, outliers, heart-rate and breathing charts, exports, sources |
| `src/charts.ts` | Hypnogram, stage ring and bar chart |
| `src/ranges.ts` | Sleep reference ranges with sources; personal ranges from your own last nights (from 3 nights) |
| `src/ui.ts` | New: shared screen helpers and report tiles (moved from `app.ts`), with "Normal" / "Within range" labels |
| `src/store.ts` | Sleep recordings stored per user (database version 2; ECG recordings unchanged) |
| `sw.js` | Offline cache v8 |
| `tests/sleep.test.ts`, `scripts/sleep-probe.mjs` | 7 new tests (21 in total); a script to check the analysis on simulated nights |

## 2 Nov 2026 – Per-user biodata *(GitHub)*
| File | Change |
|---|---|
| `index.html`, `styles.css` | Settings starts with a User selector (kept in step with the one on Live); new "Biodata · User N" section: name or alias, age, sex, height, weight, waist circumference, resting and max HR; "How to measure your waist" guide; settings grouped into Biodata, Training zone alerts, Analysis and Alerts |
| `src/store.ts` | Height, weight and waist saved per user (blank = not given); BMI and waist-to-height ratio |
| `src/app.ts` | Shows BMI and waist-to-height (usual guide: under 0.5) under the biodata; report header lists the user's biodata; empty optional fields stay blank |
| `src/edf.ts` | EDF+ export records sex in the patient field |
| `tests/` | Biodata and EDF sex tests (14 in total) |

## 2 Nov 2026 – T/R ratio warnings *(GitHub)*
| File | Change |
|---|---|
| `src/ranges.ts` | T/R ratio normal between 0.1 and 0.75; ≤ 0.1 flagged "Possibly flattened", ≥ 0.75 flagged "Possibly peaked" (values exactly on a limit are flagged); sources updated |
| `src/app.ts` | Flags can carry their own wording; the outliers summary names the warning, e.g. "T/R ratio (possibly peaked)" |
| `tests/edf-ranges.test.ts` | Checks both warnings and the exact limits |

## 2 Nov 2026 – T-wave amplitude: upright only *(GitHub)*
| File | Change |
|---|---|
| `src/app.ts`, `src/ranges.ts` | The 100–1000 µV range now applies to upright T waves only: a T wave pointing down is below the range and flagged (previously judged on size in either direction) |
| `tests/edf-ranges.test.ts` | A downward T wave (−300 µV) is now expected to be flagged |

## 2 Nov 2026 – T-wave criteria and T/R ratio *(GitHub)*
| File | Change |
|---|---|
| `src/ranges.ts` | T-wave amplitude range 100–1000 µV (under 100 µV = flat, over 1000 µV = tall), judged on size so a downward T isn't called flat; T/R ratio at least 0.1 (1/10 of R); new "T wave" entry in the sources |
| `src/dsp.ts` | New metric: T/R ratio, median of T size ÷ R size per beat |
| `src/app.ts` | T-wave amplitude tile now shows its range and is flagged outside it; new "T/R ratio" tile |
| `tests/` | 1 new test (13 in total); T/R ratio checked on the demo and upside-down signals |

## 2 Nov 2026 – T-wave amplitude *(GitHub)*
| File | Change |
|---|---|
| `src/dsp.ts` | New metric: median T-wave amplitude of clean beats, in µV, from the PR baseline to the T peak (negative when the T wave points down) |
| `src/app.ts` | New report tile "T-wave amplitude" under ECG waves, after "T wave positive"; no reference range, never flagged; included in the JSON export |
| `tests/dsp.test.ts` | Checks the value (about 290 µV on the demo signal) and its sign on an upside-down signal |

## 2 Nov 2026 – Users 1–9 *(GitHub)*
Why: several people can share the app without their recordings being mixed.

| File | Change |
|---|---|
| `index.html`, `styles.css` | "User" selector (User 1–9) at the top of the Live screen; History heading shows the user |
| `src/store.ts` | Recordings carry a user number; History lists only the chosen user's recordings; each user has their own settings (age, sex, heart rates, alias…) |
| `src/app.ts` | Switching user reloads that user's settings and history; locked while recording; new recordings and EDF imports go to the chosen user; report shows the user |
| `tests/users.test.ts` | 3 new tests (12 in total) |

Existing data: recordings made before this change and the existing settings belong to **User 1** — nothing is moved or lost.

## 2 Nov 2026 – Faster publishing *(GitHub)*
Why: checks now run before you're asked to publish, so publishing happens straight away once you agree.

| File | Change |
|---|---|
| `scripts/stamp.mjs` | New: records a fingerprint of the files to be uploaded when the checks pass (docs excluded) |
| `package.json` | `npm run check` saves that fingerprint when everything passes |
| `publish.command` | Skips the checks if they already passed for exactly these files; any code change makes it check again |

## 2 Nov 2026 – About text *(GitHub)*
| File | Change |
|---|---|
| `index.html` | Removed "OpenBeat ECG is free to use. Recordings stay on this device (browser storage); nothing is uploaded." from Settings → About |

## 2 Nov 2026 – Strict TypeScript *(GitHub)*
Why: same strict TypeScript setup as the Portfolio Optimizer project, so mistakes are caught before publishing.

| File | Change |
|---|---|
| `src/*.ts` | All modules converted from `js/*.js` to TypeScript with full types; new `util.ts` |
| `js/` | Removed: `app.js` is now built from `src/` |
| `app.js` | New, generated by `npm run build` (one bundled file); `index.html` loads it |
| `tsconfig.json`, `tests/tsconfig.json` | Strict settings copied from the Portfolio Optimizer, plus Web Bluetooth types |
| `package.json`, `package-lock.json`, `scripts/` | TypeScript 5.4.5, esbuild 0.21.5; `npm run check` = type check + build + tests |
| `tests/*.test.ts` | 9 automated tests: beat detection, ectopics, metrics, upside-down signal, EDF round trip, reference ranges |
| `src/store.ts` | Saved settings are validated on load; damaged values fall back to defaults |
| `publish.command` | Runs `npm run check` first; nothing is uploaded if it fails |
| `sw.js` | Offline cache v7, caches `app.js` |
| `README.md` | Development commands |

## 2 Nov 2026, 10:52 – Pairing hint *(GitHub)*
Why: Chrome's list says "Paired" but still needs Pair clicked, which confuses new users. Chrome's window can't be changed, so the app explains it.

| File | Change |
|---|---|
| `index.html` | Hint under Connect: "Chrome will show a list. Click your Polar H10, then click Pair, even if it already says 'Paired'." |
| `js/app.js` | Hint hidden while connected and in browsers without Bluetooth; log says "No strap chosen" if the list is closed |
| `js/polar.js` | Connection log says "Waiting for you to choose the strap and click Pair…" while Chrome's list is open |
| `sw.js` | Offline cache v6 |

## 2 Nov 2026, 10:45 – R amplitude range removed *(GitHub)*
Why: R amplitude from a chest strap isn't comparable to 12-lead ECG norms, and the 300–3000 µV range had no published source.

| File | Change |
|---|---|
| `js/ranges.js` | Removed the R amplitude range |
| `js/app.js` | R amplitude still shown (signed, as recorded), labelled "no reference range", never flagged |
| `sw.js` | Offline cache v5 |

## 2 Nov 2026 – Reference ranges and copyright *(GitHub)*
| File | Change |
|---|---|
| `js/ranges.js` | New: reference ranges for HR, HRV (age-adjusted), pNN50/200, events, QRS, QTc (by sex), T waves, J point, ST, R amplitude, HR recovery, with published sources |
| `js/app.js` | Each report value shows its range; values outside it get a "▲ Above / ▼ Below range" flag; outliers summary at the top of the report; resting ranges skipped for exercise recordings; ranges and outliers included in the JSON export; copyright year |
| `index.html` | Outliers box, "About the reference ranges" panel with sources; copyright line in the footer of every screen; "free and open" → "free to use" |
| `styles.css` | Styling for range lines, flags, outliers box, sources panel and copyright |
| `js/sim.js` | Demo signal works for long requests (used in testing) |
| `sw.js` | Offline cache v4, includes `js/ranges.js` |
| `README.md` | Copyright line |

## 2 Nov 2026 – Moved to the ecg-tracking account *(GitHub)*
- App uploaded to github.com/ecg-tracking/Polar-H10 through the browser; live at https://ecg-tracking.github.io/Polar-H10/
- `publish.command` now uploads to this new repository (user `ecg-tracking`)

## 2 Nov 2026 – Upload archive *(GitHub)*
| File | Change |
|---|---|
| `CHANGELOG.md` | New: this history |
| `publish.command` | Saves a dated copy of each upload into `GitHub uploads/` (stays on this Mac) |

## 2 Nov 2026, 09:34 – Connection reliability *(previous site)*
Why: in Chrome on macOS, "Connect Polar H10" stayed on "Connecting…" with no reading.

| File | Change |
|---|---|
| `js/polar.js` | Step-by-step connection log; 10 s timeout on each connect attempt with up to 3 retries (macOS can hang silently); stops any ECG stream left running before starting a new one; reads the H10's reply to the start command and reports its error (e.g. "sensor is charging"); checks that ECG data actually arrives; falls back to heart rate only if the ECG stream fails |
| `js/app.js` | Shows the connection log; heart-rate-only mode (status shows why, recording disabled) |
| `index.html` | Grey log box under the Connect buttons |
| `styles.css` | Log box styling |
| `sw.js` | Offline cache version v1 → v3 so installed copies fetch the new files |
| `.gitignore` | New: keeps zips, notes and the publish script off GitHub |
| `.nojekyll` | New: GitHub Pages serves files unchanged |

## 2 Nov 2026, 08:51 – First upload to GitHub *(previous site)*
All 15 app files uploaded through the browser; GitHub Pages turned on

## 2 Nov 2026, ~08:30 – Testing fixes (before GitHub)
| File | Change |
|---|---|
| `js/dsp.js` | Beat-detector refractory period 250 → 200 ms (standard Pan–Tompkins), so beats at high heart rates aren't missed |
| `js/sim.js` | Demo signal: no premature beats above 130 bpm (they were unrealistically close together); narrower, more realistic QRS |
| `styles.css` | Hidden buttons now actually hide (Connect/Demo while streaming); short brand name on small phones; neutral grid colour for report charts |
| `js/charts.js` | Report charts use the neutral grid instead of ECG-paper pink |

## 2 Nov 2026, ~08:00 – First version built
| File | Purpose |
|---|---|
| `index.html` | Page layout: Live, History, Report, Settings |
| `styles.css` | Look and feel, light/dark mode, phone layout, print layout |
| `js/app.js` | App logic: live screen, recording, alerts, reports, exports, settings |
| `js/polar.js` | Polar H10 Bluetooth connection (heart rate + raw ECG) |
| `js/dsp.js` | ECG analysis: filters, beat detection, wave measurements, HRV and training metrics |
| `js/charts.js` | Charts, live trace, zoomable ECG viewer |
| `js/sim.js` | Simulated ECG for the demo modes |
| `js/edf.js` | EDF+ export and import |
| `js/store.js` | Saves recordings and settings on the device |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app and offline support |
| `README.md` | Description and setup notes |

## 2 Nov 2026, ~07:50 – Research
`ECG-Polar-H10-study.md` (stays on this Mac): study of the commercial "ECG Analysis for Polar H10" app from its public documentation, and the plan for this free version.
