# OpenBeat ECG – change history

Newest first; from v1.1.0 each heading shows the version. Live site: https://ecg-tracking.github.io/Polar-H10/ (repository github.com/ecg-tracking/Polar-H10).
Entries marked *(GitHub)* appear under **Commits** in that repository; the oldest ones were published to a previous site that is no longer used.
An exact copy of every upload is kept in the `GitHub uploads` folder (on this Mac only).

## 4 Nov 2026 – v1.15.2 – Recovery centre tables with sortable columns; live ECG on Sleep monitor *(GitHub)*
Why: a table is easier to scan than a list, and the order should be yours to choose.
- Each category in the Recovery centre is now a table. Click a column header to sort by it, and click again to reverse; the sorted column shows ▼ or ▲ in the theme colour.
- By default each table is sorted by date of recording, newest first, as in its original table (Download history by when the download ran).
- Restore is at the front of each row. The × deletes permanently, and shows at both ends of the row when the table is wider than the page.
- Sleep monitor now shows the live ECG trace, the same as ECG live, whenever the Polar H10 is connected. It is only drawn while you can see it, not under Dim screen or on other pages, to save the battery overnight; the recording itself is not affected.

## 4 Nov 2026 – v1.15.1 – Recovery centre grouped by category *(GitHub)*
Why: one long list of deleted items is hard to go through; the other app groups them.
- Deleted items are now in collapsible groups, as in the other app: ECG recordings, Sleep nights, Watch D2 nights, Watch D2 data, Synchronised tracking and D2 Link download history. Each shows how many items it holds, newest deleted first, 50 to a page.

## 4 Nov 2026 – v1.15.0 – Recovery centre; a second × on long rows *(GitHub)*
Why: a delete could not be undone, and on wide tables the × was out of sight until you scrolled to the end of the row.
- New **Recovery centre** page in the sidebar, under Account (also found through Search). Everything with a × goes there: ECG recordings with their full signal, sleep nights with their raw data, Watch D2 nights and All data rows, Synchronised Tracking results and D2 Link download history.
- Each item shows what it was and when it was deleted, with **Restore** and **Delete permanently**. Items stay until you delete them permanently; nothing is removed automatically. The page shows the storage they use.
- Restore puts the item back and syncs it to your other devices again. A delete that arrives from another device also leaves a copy here, marked as such.
- Per device and per user. **Backup Account** includes these items with their raw signals, and Restore Account puts them back in the Recovery centre. “Reset my account data” clears them, on this device. If the device’s storage is full, the item is still deleted and the page says how many weren’t kept.
- Tables wider than the page now also show the × at the front of each row, in All data, Synchronised Tracking History and Download history.
- The delete questions now mention the Recovery centre.
- Fixed: a summary copy restored from a backup was deleted at the next sync instead of being uploaded.

## 4 Nov 2026 – v1.14.1 – About in the sidebar *(GitHub)*
Why: About belongs in the sidebar’s Account group.

| File | Change |
|---|---|
| `index.html`, `src/app.ts`, `src/topbar.ts`, `styles.css` | About is its own page in the left sidebar, under Account below Sync & backups; it is no longer in the top-right Account menu. Search finds it |

## 4 Nov 2026 – v1.14.0 – Connections carry across pages; Portfolio Optimizer colours; report matches the phone *(GitHub)*
Why: pair once for all pages; the same colours as Portfolio Optimizer; differences found against the phone’s report for 3–4 Nov.

| File | Change |
|---|---|
| `src/devices.ts` (new), `src/app.ts`, `src/sleepui.ts`, `src/synctrack.ts` | One Polar H10 connection for ECG live, Sleep monitor and Synchronised Tracking: pair it on any of them and the others show it connected and use it; disconnecting anywhere disconnects it everywhere (except during a night’s recording) |
| `src/d2/watch.ts` (new), `src/d2/live.ts`, `src/d2/ui.ts`, `src/d2/index.ts` | One watch connection for D2 Link and Synchronised Tracking; it stays connected after a download (new “Disconnect watch” button) and is set up once per connection |
| `styles.css`, `index.html`, `manifest.webmanifest`, `icons/`, `sw.js` | Portfolio Optimizer’s theme and palette instead of red: teal for buttons, the selected page, charts’ main colour and the logo, and its red, green, amber and blue. The dark red × and the ECG paper grid are unchanged |
| `src/synctrack.ts` | Blood pressure counts from one hour before to one hour after the start of a tracking (it was only after) |
| `src/d2/ui.ts` | Night report as on the phone: deep, light and REM add up to 100%; “Below average” for short nights; “Avg respiratory rate” in brpm |
| `src/app.ts`, `styles.css` | ECG history: the duration follows the number of events |
| `index.html`, `src/topbar.ts` | Logo subheading “Basic Heart rhythm & Sleep tracking”; About moved from Biodata into the Account menu |
| `tests/` | Tests for the shared watch connection and the blood pressure window |

## 4 Nov 2026 – v1.13.2 – Dark rose red *(GitHub)*
Why: a dark rose red instead of the bright red.

| File | Change |
|---|---|
| `styles.css`, `index.html`, `manifest.webmanifest`, `icons/` | The app’s red is now a dark rose red: buttons, the selected page, heart-rate lines and the logo (`#9e2a4e`; a brighter `#c0456f` in dark mode, so it stays visible and white text on buttons stays readable); the phone’s theme colour; and the warning red used for ECG events, Delete and error messages (a matching rose). The dark red × and the ECG paper grid are unchanged |
| `sw.js` | New cache name, so phones and computers pick up the new icons |

## 4 Nov 2026 – v1.13.1 – Amber borders replaced with blue *(GitHub)*
Why: blue instead of amber borders for results outside the reference range and for warnings.

| File | Change |
|---|---|
| `styles.css` | In the ECG report and the Sleep report, the tiles of results outside the reference range, their “▲ / ▼” labels and the “values outside the reference range” box are blue instead of amber; so is the border of D2 Link’s browser warning |

## 4 Nov 2026 – v1.13.0 – ECG live: choice of recording length *(GitHub)*
Why: record for a set time, as in Synchronised Tracking.

| File | Change |
|---|---|
| `index.html`, `src/app.ts`, `src/ui.ts`, `src/synctrack.ts` | New “Record for” choice on ECG live: 1, 3 or 5 minutes, until stopped (the default, as before), or a chosen number of minutes (1–240). With a set length the timer counts down, the recording stops and saves itself at exactly that length, and its report opens if ECG live is showing; Stop still ends it early. The choice is locked while recording |
| `tests/users.test.ts` | Test for the chosen length |

## 3 Nov 2026 – v1.12.3 – Backups bring the tracking history up to date first *(GitHub)*
Why: a backup made straight from Sync & backups missed readings that opening a tracking page would have added.

| File | Change |
|---|---|
| `src/backups.ts` | “Backup Account” first gives every tracking the blood pressure readings already on this device (within one hour of its start), as opening Synchronised Tracking does, then makes the backup |

## 3 Nov 2026 – v1.12.2 – Tracking history: blood pressure from readings already on the device; no watch account ID in backups *(GitHub)*
Why: the backup showed the 16:27 tracking with only its first reading, although the 16:33 and 16:50 readings had been downloaded; and the watch account ID should not be in backup files.

| File | Change |
|---|---|
| `src/synctrack.ts`, `src/d2/backup.ts`, `src/d2/index.ts` | Opening Synchronised Tracking or its history fills every tracking with the blood pressure readings already on this device (downloaded by D2 Link or during tracking) taken within one hour of its start, without connecting the watch. A reading within the hour of two trackings appears in both |
| `tests/synctrack.test.ts` | Test for which readings each tracking gets |
| `src/d2/backup.ts`, `src/backups.ts`, `tests/backups.test.ts` | Backups and comparison files leave out the watch account ID (enter it again in D2 Link after restoring on a new device); restoring an older backup that has it still works |

## 3 Nov 2026 – v1.12.1 – Disclaimer on two lines *(GitHub)*
Why: the second sentence was split in the middle (“Do not / use for diagnosis”).

| File | Change |
|---|---|
| `index.html` | The disclaimer’s second sentence (“Do not use for diagnosis; see a doctor about symptoms.”) starts on its own line |

## 3 Nov 2026 – v1.12.0 – Sync & backups; Settings renamed Biodata *(GitHub)*
Why: back up and restore the whole account, and compare or repair the copies on this device and in the cloud, as in Portfolio Optimizer.

| File | Change |
|---|---|
| `src/backups.ts` (new), `src/app.ts`, `index.html`, `styles.css` | New page “Sync & backups” below Biodata. “Backup Account” saves one file with everything this account has on this device (ECG recordings with their full signal, sleep nights with their raw data, summary copies from other devices, the Watch D2 nights and data, each user’s biodata and settings, the Synchronised Tracking and download histories, the watch account ID; not the password, sign-in or watch pairing). “Restore Account” puts such a file back on this device (same items replaced) and uploads it at the next sync. “Export local and cloud copies for comparison” saves both copies side by side (raw signals left out, watch account ID hidden). “Overwrite cloud with local” makes the cloud copy match this device; “Restore previous cloud copy from comparison file” puts back an earlier cloud copy, which this device then follows. Both ask for the account password; other devices follow the cloud at their next sync |
| `src/d2/backup.ts` (new), `src/d2/index.ts`, `src/d2/store.ts` | D2 Link’s part of the backup, restore and sync |
| `index.html`, `src/topbar.ts` | “Settings” is now “Biodata” in the sidebar (its page: “Biodata and settings”); Search finds Sync & backups |
| `tests/backups.test.ts` (new) | Signals survive the backup file; only OpenBeat files are accepted |

## 3 Nov 2026 – v1.11.4 – Settings: account card removed *(GitHub)*
Why: the email, sync status, version, Sync now and sign-out are already at the top right and in the sidebar.

| File | Change |
|---|---|
| `index.html`, `src/main.ts`, `src/app.ts` | Settings no longer has the Account card. Its note on what is backed up moved to “About” and now also lists the Watch D2 data and the biodata and settings. The top bar’s sync status shows the full message (e.g. why a sync failed) on hover |

## 3 Nov 2026 – v1.11.3 – Account menu: choose the user *(GitHub)*
Why: switch between users 1–9 from the top bar.

| File | Change |
|---|---|
| `src/topbar.ts`, `styles.css` | The Account menu has a “User” list (User 1–9, with each user’s alias). It switches the user as ECG live and Settings do (not while recording), and the round badge shows the user’s number |

## 3 Nov 2026 – v1.11.2 – Sidebar: version only at the bottom *(GitHub)*
Why: the email and sync status are already in the top bar (Account menu and sync status).

| File | Change |
|---|---|
| `index.html`, `src/main.ts`, `styles.css` | The bottom of the sidebar shows only the version; the signed-in email and the sync status were removed there |

## 3 Nov 2026 – v1.11.1 – Disclaimer wording *(GitHub)*
Why: the app now uses more than a chest strap (the Watch D2 too).

| File | Change |
|---|---|
| `index.html`, `README.md` | The disclaimer reads: “Not a medical device. Results are statistical estimates obtained from non-medical monitoring devices and can be wrong. Do not use for diagnosis; see a doctor about symptoms.” |

## 3 Nov 2026 – v1.11.0 – Top bar like Portfolio Optimizer: Search and Account menu *(GitHub)*
Why: the same top-right controls as the Portfolio Optimizer app.

| File | Change |
|---|---|
| `src/topbar.ts` (new), `src/main.ts`, `index.html`, `styles.css` | Top right: the sync status with its dot and “Sync now”; “Search” (⌘K / Ctrl+K) to jump to any page by its name or what is on it; and the “Account” menu with the user’s number in a round badge: who is signed in, Layout (Desktop or Mobile – the compact layout on any screen), Theme (Auto, Light or Dark), “Log Out”, and “Reset my account data”, which deletes all of this account’s data in the cloud and on this device after you type DELETE (the sign-in itself is kept). Theme and layout are remembered on this device |
| `src/store.ts` | Deleting this account’s data on this device (its databases and stored settings; other accounts’ data stays) |
| `src/app.ts` | The D2 Link History page has the plain copyright line; the licence lines stay on the D2 Link page |
| `tests/topbar.test.ts` (new) | Test for Search’s matching |

## 3 Nov 2026 – v1.10.0 – Desktop look like Portfolio Optimizer: left sidebar and top bar *(GitHub)*
Why: a clearer desktop layout, in the same style as the Portfolio Optimizer app.

| File | Change |
|---|---|
| `index.html`, `styles.css` | Desktop: a left sidebar with the logo, name and subtitle, the pages with line icons in groups (ECG · Sleep · Watch D2 · Polar H10 + Watch D2 · Account), the selected page marked in red, and the signed-in email, sync status and version at the bottom; a top bar with the page’s title, the sync status and “Sync now”. Colours and typeface (Plus Jakarta Sans) as in Portfolio Optimizer, keeping OpenBeat’s red; cards with a soft shadow. Narrower screens and phones: a compact bar at the top with the pages wrapping under the logo |
| `src/app.ts`, `src/main.ts` | The top bar shows the page’s name; the sidebar and top bar show the sync status; “Sync now” in the top bar |

## 3 Nov 2026 – v1.9.1 – Tracking ECGs summarised in ECG history; tab bar on wide screens *(GitHub)*
Why: a recording from Synchronised Tracking showed “Open to analyse” instead of HR, HRV and events; on wide screens the last tabs were cut off.

| File | Change |
|---|---|
| `src/app.ts`, `src/synctrack.ts` | The ECG from Synchronised Tracking gets its HR, HRV and events for the ECG history list when it is saved (as recordings from ECG live do when their report opens); earlier ones get them when Synchronised Tracking is opened |
| `styles.css` | On wide screens the tabs wrap within the space beside the logo instead of running off the edge |

## 3 Nov 2026 – v1.9.0 – History pages, delete ×, every blood pressure reading, tab bar *(GitHub)*
Why: blood pressure taken after the tracking ended was missing from the history; separate pages for the histories; delete rows; all tabs visible.

| File | Change |
|---|---|
| `src/synctrack.ts`, `src/store.ts` | Every blood pressure reading taken on the watch within one hour of the start is kept with its tracking (checked every minute for the whole hour); when the watch connects, recent trackings (last two days) get readings they are missing. RMSSD and SDNN leave out beats more than 20% away from the previous one (extra or missed beats), for both devices; “Beats used” counts the beats that were used |
| `index.html`, `src/app.ts`, `src/synctrack.ts` | New tab “Synchronised Tracking History” (the history table moved there) next to “Synchronised Tracking” |
| `src/d2/ui.ts`, `index.html`, `src/app.ts` | New tab “D2 Link History”: the nights, Week, Month, All data, Graphs and a night’s report; “D2 Link” keeps pairing, downloading and the download history. After a download the history opens |
| `src/store.ts`, `src/summary.ts`, `src/cloud.ts`, `src/app.ts` | ECG history notes “from synchronised tracking” on recordings made there (also on earlier ones, and on other devices’ copies) |
| `src/ui.ts`, `src/d2/dom.ts`, `src/app.ts`, `src/sleepui.ts`, `src/d2/ui.ts`, `src/d2/dataui.ts`, `src/synctrack.ts`, `styles.css` | A dark red × on each row of ECG history, Sleep history, D2 Link’s nights, every All data table, the download history and the tracking history: it asks, then deletes (from the other devices too, where the data syncs) |
| `src/d2/store.ts`, `src/d2/cloud.ts` | Deleted D2 records are removed from the cloud and from the other devices. The cloud’s record list is read in pages of 1000 (it has more than 3000 records) |
| `styles.css`, `index.html` | Tab bar: all eleven tabs visible, wrapped in groups (ECG · Sleep · D2 Link · Synchronised Tracking · Settings) with dividers; under the logo on narrower screens; the header scrolls away on phones |

## 3 Nov 2026 – v1.8.1 – History of Synchronised Tracking *(GitHub)*
Why: see every synchronised tracking and its results together.

| File | Change |
|---|---|
| `src/synctrack.ts`, `src/store.ts`, `styles.css` | New table “History of Synchronised Tracking” below the summary, newest first: date and time, duration, average heart rate from the Polar H10 and the watch and their difference (watch minus Polar), RMSSD and SDNN from each, beats counted by each, the blood pressure taken on the watch within one hour (systolic/diastolic, pulse, time; added when it arrives) and a button to open the saved ECG. Kept on this device, per user (the last 500) |

## 3 Nov 2026 – v1.8.0 – Synchronised tracking: live from connection, choice of duration, ECG saved *(GitHub)*
Why: see the ECG and the watch’s values straight away, track for longer than a minute, and keep the ECG.

| File | Change |
|---|---|
| `src/synctrack.ts`, `styles.css` | The ECG is drawn live as soon as the Polar H10 is connected (as on ECG live), and its heart rate and RMSSD show straight away. The watch’s heartbeat test starts as soon as the watch is connected, so its heart rate, beat interval, signal and RMSSD show before tracking starts; the test is started again every 55 s while the watch is connected. New “Track for” choice: 1, 3 or 5 minutes, until stopped, or a chosen number of minutes (1–240); the timer counts down (or up, until stopped) and the chart’s time axis follows. Only the tracked period counts in the summary |
| `src/synctrack.ts`, `src/app.ts` | The Polar H10’s ECG from the tracking is saved to ECG history (10 s or longer), like a recording on ECG live, with a button to open it there |
| `tests/synctrack.test.ts` | Test for the times shown |

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
