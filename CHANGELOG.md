# OpenBeat ECG – change history

Newest first; from v1.1.0 each heading shows the version. Live site: https://ecg-tracking.github.io/Polar-H10/ (repository github.com/ecg-tracking/Polar-H10).
Entries marked *(GitHub)* appear under **Commits** in that repository; the oldest ones were published to a previous site that is no longer used.
An exact copy of every upload is kept in the `GitHub uploads` folder (on this Mac only).

## 3 Nov 2026 – v1.7.1 – D2 Link pairs again by itself when the watch refuses the saved pairing *(GitHub)*
Why: the watch keeps one pairing per phone or computer, so pairing it again on the same device (e.g. from another browser) made the saved pairing fail with “refused the login (error -1)”.

| File | Change |
|---|---|
| `src/d2/link.ts` | When the watch refuses the saved pairing, D2 Link says so and pairs again on the same connection (confirm on the watch if it asks); the new pairing is saved. Used by D2 Link and Synchronised tracking |
| `src/synctrack.ts` | The connection log is under the Watch D2 card (it was at the bottom) |
| `tests/d2.test.ts` | Test for pairing again after a refused login |

## 3 Nov 2026 – v1.7.0 – Synchronised tracking *(GitHub)*
Why: compare the Polar H10 and the Watch D2 at the same time, with a blood pressure reading.

| File | Change |
|---|---|
| `index.html`, `src/app.ts`, `src/synctrack.ts` (new), `styles.css` | New tab “Synchronised tracking” between D2 Link and Settings: 1. pair with the Polar H10, 2. pair with the Watch D2 (Chrome Bluetooth or D2 Bridge on a Mac), 3. one-minute tracking with a countdown; the ECG as on ECG live; live heart rate, beat interval, signal and RMSSD from the watch beside the strap’s heart rate and RMSSD; a chart of both heart rates over the minute; a summary (average heart rate, RMSSD, SDNN, beats, and the difference between the two). Blood pressure: measured once on the watch during the minute or within one hour of the start; checked every minute while the watch is connected (and with a button), and shown on the page |
| `src/d2/live.ts` (new), `src/d2/index.ts`, `src/d2/link.ts`, `src/d2/extra.ts` | D2 Link offers the watch live: the watch’s 60-second heartbeat test (ported from Gadgetbridge) and blood pressure readings since a time (also saved with D2 Link’s data). Several parts can now listen to the watch at once |
| `tests/d2extra.test.ts`, `tests/d2fake.ts`, `tests/synctrack.test.ts` (new) | The fake watch streams heartbeats; tests for the beats and the heart rate / HRV numbers |

## 3 Nov 2026 – v1.6.0 – D2 Link: download history; clearer note when D2 Bridge isn’t open *(GitHub)*
Why: D2 Bridge is in the Applications folder inside the home folder, which is easy to miss.

| File | Change |
|---|---|
| `src/d2/serial.ts` | When D2 Bridge isn’t running, the note says how to open it (Cmd + Space, “D2 Bridge”), to keep its window open, and how to have it start with the Mac (Login Items) |
| `src/d2/store.ts`, `src/d2/ui.ts`, `styles.css` | New “Download history” on the D2 Link page: for each download, when, which button (Sleep or All data), how the watch was reached, the dates asked for, what was downloaded (nights, activity days, totals, blood pressure, HRV, emotion, stress, workouts, with counts), what wasn’t and why, and the result. Kept on this device only (the last 300) |

## 3 Nov 2026 – v1.5.0 – D2 Link on a Mac: D2 Bridge *(GitHub)*
Why: Chrome on macOS can’t open the watch’s data channel (its service lookup times out); macOS’s own Bluetooth can.

| File | Change |
|---|---|
| D2 Bridge (separate Mac app, not uploaded) | A small Mac app that opens the watch’s data channel with macOS’s Bluetooth and passes the bytes to D2 Link over a connection on this Mac only (127.0.0.1, port 47820), for the published site or a local copy only. Copyright © 2026 ECG-Tracking, all rights reserved: not open source and not part of D2 Link. Tested: pairing, login and sleep download from a Watch D2 on a MacBook Pro |
| `src/d2/serial.ts`, `src/d2/ui.ts` | New choice “Connect via”: Chrome Bluetooth, D2 Bridge app (Mac), or the computer’s serial port (replaces the “Use the computer’s serial port” button); on a Mac D2 Bridge is chosen first. The help explains D2 Bridge and that the watch talks to one device at a time (switch off the phone’s Bluetooth while downloading) |
| `.gitignore` | D2 Bridge’s source stays on this Mac |

## 3 Nov 2026 – v1.4.2 – D2 Link: download by start and end dates *(GitHub)*
Why: choose exactly which days to download from the watch.

| File | Change |
|---|---|
| `src/d2/period.ts` (new), `src/d2/ui.ts`, `styles.css` | The “Download” list has a new choice “Choose dates…”, which shows “From” and “to” dates: the download covers the start of the first day to the end of the last (not after now). Both download buttons use it; a start after the end, or in the future, is refused with a note |
| `tests/d2extra.test.ts` | Tests for the period |

## 3 Nov 2026 – v1.4.1 – D2 Link: no ECG recordings *(GitHub)*
Why: ECG recordings from the watch are not wanted.

| File | Change |
|---|---|
| `src/d2/ui.ts`, `src/d2/extra.ts`, `src/d2/setup.ts` | “Download all data” no longer downloads ECG recordings, and the set-up no longer sends the ECG switch |
| `src/d2/dataui.ts`, `src/d2/graphsui.ts`, `styles.css` | ECG recordings no longer shown in All data or Graphs |
| `src/d2/store.ts`, `src/d2/cloud.ts` | ECG recordings already downloaded are deleted on each device at its next sync, and once from the cloud; one arriving from the cloud is not taken |
| `tests/d2extra.test.ts`, `tests/d2fake.ts` | ECG tests replaced by a test that ECG recordings are not kept |

## 3 Nov 2026 – v1.4.0 – D2 Link: Graphs, blood pressure named *(GitHub)*
Why: see all the watch’s data over time; name the blood pressure values; stop reading kinds that aren’t needed.

| File | Change |
|---|---|
| `src/d2/graphsui.ts` (new), `src/d2/ui.ts`, `styles.css` | New “Graphs” tab after “All data”, with a choice of 1 day, 7 days, 1, 3, 6 or 9 months, 1, 3 or 5 years, or all. Graphs: sleep (deep, light, REM), sleep score, steps, distance, calories, heart rate (with its range), resting heart rate, SpO₂, blood pressure (systolic and diastolic), pulse, HRV, stress, emotion, ECG recordings and workouts. Up to 2 days shows each reading, up to 13 months one value per day, longer one per week. The choice is remembered |
| `src/d2/extra.ts`, `src/d2/dataui.ts` | Blood pressure fields named: systolic (2006), diastolic (2007) and pulse (10002537). Altitude, skin temperature, sleep apnoea, arterial stiffness and altitude sickness are no longer requested or shown |
| `src/d2/cloud.ts`, `src/d2/store.ts` | Records already downloaded of those five kinds are deleted on each device at its next sync, and once from the cloud |
| `tests/d2extra.test.ts` | Tests for the periods, per-day and per-week values, and the measurement kinds |

## 3 Nov 2026 – v1.3.4 – D2 Link: watch account ID *(GitHub)*
Why: the watch held back stress, ECG, workouts and measurements (code 100004), and after the set-up sent an empty account it also held back totals and data sync: it shares health data with its own account.

| File | Change |
|---|---|
| `src/d2/ui.ts`, `styles.css` | New optional field “Watch account ID” on the D2 Link page (digits only, usually 17), with how to find it |
| `src/d2/store.ts` | The ID is kept on this device only (never synced) |
| `src/d2/setup.ts` | The account step sends that ID; without one it is skipped (no more empty account) |
| `tests/d2extra.test.ts` | The account is sent only when an ID was entered |

## 3 Nov 2026 – v1.3.3 – D2 Link: set up the watch before downloading all data *(GitHub)*
Why: the watch refused stress, ECG and workouts (code 100004) and didn’t answer the measurement requests, probably because the phone app’s set-up messages after login were missing.

| File | Change |
|---|---|
| `src/d2/setup.ts` (new) | Before “Download all data”, the set-up Gadgetbridge sends after login: supported services, commands and capabilities; time and time zone; settings; acceptance of the watch’s agreements; account; country; main device; profile (from Settings → Biodata, only when height and weight are given); the ECG switch. Each step is optional; the connection log lists what the watch supports (workouts, stress, data sync, ECG, HRV) |
| `src/d2/ui.ts`, `src/app.ts` | The set-up runs after sleep and before the other data; the app passes the user’s biodata |
| `tests/d2fake.ts`, `tests/d2extra.test.ts` | The fake watch answers the set-up and can refuse workouts until the agreements were sent; tests for the messages |

## 3 Nov 2026 – v1.3.2 – D2 Link: activity fixes from the first real download *(GitHub)*
Why: the first “all data” export from the watch showed calories 1000× too high, a stray day from 2020 and empty totals.

| File | Change |
|---|---|
| `src/d2/dataui.ts` | Calories per day shown in kcal (the watch sends them per minute in calories, 1/1000 kcal) |
| `src/d2/extra.ts` | Minutes outside the period asked for are left out (the watch also sent two from 2020, before its clock was set). An answer without totals is not saved; the layout of the watch’s answer (no values) goes to the connection log |
| `src/d2/ui.ts` | Totals are saved only when the watch sends some |
| `tests/d2extra.test.ts` | Tests for both |

## 3 Nov 2026 – v1.3.1 – D2 Link: export all data *(GitHub)*
Why: save everything downloaded from the watch in one file.

| File | Change |
|---|---|
| `src/d2/ui.ts` | New button “Export all data” next to “Export all nights”: one JSON file with this user’s nights, activity days, totals, measurements, stress, ECG recordings and workouts (demo nights left out) |

## 3 Nov 2026 – v1.3.0 – D2 Link: download all data *(GitHub)*
Why: read everything the watch keeps, not only sleep; numbers sync to the other devices.

| File | Change |
|---|---|
| `src/d2/ui.ts`, `styles.css` | New blue button “Pair & download all data” under “Pair & download sleep”, same size (“Download all data” once paired). It downloads sleep and then, each on its own (one the watch refuses doesn’t stop the others): activity per minute (steps, distance, calories, heart rate, resting heart rate, SpO₂), today’s totals, the watch’s measurements (blood pressure, HRV, skin temperature, emotion, sleep apnoea, arterial stiffness, altitude), stress, ECG recordings and workouts |
| `src/d2/extra.ts` (new) | The requests and readers for those kinds of data, ported from Gadgetbridge. Blood pressure fields are not described there yet, so they are shown by field number |
| `src/d2/link.ts` | The file download works for any file (sleep, stress, ECG); messages the watch sends on its own reach the data sync |
| `src/d2/records.ts` (new), `src/d2/store.ts` | Stored per record on the device; activity is kept per day and merged with earlier downloads. Numbers in one part, text the watch sends (e.g. the ECG app version, workout notes) in a part that stays on this device |
| `src/d2/cloud.ts` | The numbers sync through the general table `user_data` (kinds `d2-…`); the newest download of a record wins. No new SQL needed |
| `src/d2/dataui.ts` (new) | New “All data” tab: activity per day, each kind of measurement, stress, ECG recordings with a trace, workouts |
| `tests/d2extra.test.ts` (new), `tests/d2fake.ts` | The fake watch answers all of the above; tests for reading, storing and syncing each kind |

## 3 Nov 2026 – v1.2.0 – Biodata and settings sync across devices *(GitHub)*
Why: biodata entered on one device didn't appear on the others; and one general cloud table, so later kinds of data need no further SQL.

| File | Change |
|---|---|
| `supabase/setup.sql` | New general table `user_data` (kind, id, data as JSON, time saved), each account seeing only its own rows. Run it once more in Supabase |
| `src/cloud.ts` | Each user's biodata and settings sync as kind `settings`; the most recently saved copy wins. Settings saved before this version count as oldest, but fill in anything the cloud copy left empty |
| `src/store.ts` | Settings remember when they were saved |
| `src/app.ts` | A change in Settings syncs a couple of seconds later; settings arriving from another device show straight away |
| `tests/users.test.ts` | Which copy wins, and the fill-in for older settings |

## 3 Nov 2026 – v1.1.2 – Licences file explained *(GitHub)*
Why: make clear the third-party licences cover only those libraries, not the app.

| File | Change |
|---|---|
| `THIRD-PARTY-LICENSES.txt` | New opening note: the licences apply only to the open-source libraries included in the app (Supabase client for sign-in and cloud sync, tslib); OpenBeat ECG itself is Copyright © 2026 ECG-Tracking, all rights reserved, and these licences grant no rights to it; D2 Link has its own licence |

## 3 Nov 2026 – v1.1.1 – Copyright note on the D2 Link page *(GitHub)*
Why: make clear that the app is copyrighted and only D2 Link is open source.

| File | Change |
|---|---|
| `index.html`, `src/app.ts` | Every other page says "Copyright © 2026 ECG-Tracking. All rights reserved."; the D2 Link page says "Copyright © 2026 ECG-Tracking.", then "D2 Link: GNU AGPL v3 · Gadgetbridge © contributors · Source code" (links) and "The rest of OpenBeat ECG: all rights reserved." |
| `THIRD-PARTY-LICENSES.txt` (new) | Licence texts of the open-source libraries included in app.js (Supabase client: MIT; tslib: 0BSD), which their licences require to be kept with the app |

## 3 Nov 2026 – v1.1.0 – Version number in the app *(GitHub)*
Why: to see which version a phone or computer has loaded.

| File | Change |
|---|---|
| `scripts/bump.mjs` (new) | Raises the version (and sets the release date) in `package.json` before each publish |
| `src/version.ts` (new), `src/main.ts`, `src/app.ts`, `index.html`, `scripts/build.mjs` | The footer shows "Version 1.1.0 (3 Nov 2026)", also on the sign-in screen, and Settings → Account shows the app version |
| `package.json`, `package-lock.json` | Version 1.1.0; new `releaseDate` field. From now on every changelog heading carries the version it was published in |

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
