# OpenBeat ECG – change history

Newest first; from v1.1.0 each heading shows the version. Live site: https://ecg-tracking.github.io/Polar-H10/ (repository github.com/ecg-tracking/Polar-H10).
Entries marked *(GitHub)* appear under **Commits** in that repository; the oldest ones were published to a previous site that is no longer used.
An exact copy of every upload is kept in the `GitHub uploads` folder (on this Mac only).

## 12 Nov 2026 – v1.44.5 – Combined sleep follows the Watch D2; Polar H10 sleep stages method 5 *(GitHub)*
- Synchronised Sleep Tracking › Combined report (combine rule 5): the Watch D2's stage now stands wherever the watch has one, awake included. The Polar H10 fills in the minutes the watch has no reading for, and names the stage where the watch says only asleep. Earlier combined reports are generated again; "How the two are combined" explains the new rule.
- Polar H10 sleep stages, method 5. The changes come from comparing 8 nights minute by minute with the Watch D2's stages, using the strap's ECG, breathing, movement and heart rate:
  - **ECG fill-in:** where the strap's own beat intervals are unusable for 30 s (poor skin contact), the beats this app finds in the night's ECG take their place. On the poorer recent nights this raised the usable heart data from about 55 % to about 80 % of the night. Time with an unnamed stage ("asleep, stage not known") fell from up to 3 hours a night to 20 minutes or less.
  - **Smoothing:** heart rate, its spread and the breathing are averaged over 3.5 minutes either side before they are compared. A stage lasts minutes: the watch's stages last 13–15 minutes (median), while 30-second values made our stages flicker.
  - **Breathing rate:** faster breathing now counts towards REM. Among the strap's signals, it was the clearest sign of the watch's REM.
  - **Threshold:** a stage other than light now needs slightly stronger evidence (1.4 instead of 1.2), which keeps the share of light sleep close to the watch's.
  - **Result:** agreement with the watch beyond chance (kappa) rose from 0.07 to 0.11. It was at least as good on 7 of the 8 nights; on 12 Nov it dropped from 0.09 to 0.00.
  - **Reports:** Polar H10 sleep reports are generated again with the new method.
- The two devices still agree only a little more than chance, so neither should be taken as exact. The watch is not a sleep study either, so matching it more closely doesn't by itself make the strap's stages more accurate. The changes above were kept only where they also fit how sleep is known to work.

## 12 Nov 2026 – v1.44.4 – Sleep stages above a sleep's ECG *(GitHub)*
- ECG history › an ECG recorded with a sleep (Sleep monitor, and Synchronised Sleep Tracking's Polar H10 part): above the ECG are two strips, each one big square tall, with the sleep stage at the same moments as colour blocks:
  - **Polar H10**: from the night's own sleep analysis.
  - **Watch D2**: from the night's synchronised sleep report.
- Each strip's caption names the stage at the middle of the window, so the colour isn't the only way to tell. "Asleep (stage not known)" is grey. A device with no stages for that night says so.
- The strips move with the ECG and its slider, and dragging them moves everything together.
- The "ECG" heading has moved inside the box, just above the ECG strip, in the same style as the other strips' captions.

## 12 Nov 2026 – v1.44.3 – Combined ECG fixed after a spike in the strap's ECG; ECG strips 4 big squares tall *(GitHub)*
- Fix: a large spike partway through a Polar H10 ECG made the beat detection stop finding beats for the rest of the recording. A spike can come from the strap being knocked or moved. The detector only recovered from a spike at the very start. Now, after 3 s with no beat, it lowers its threshold until it finds beats again. This affected:
  - the Combined ECG, which couldn't line up the watch's strips. This happened for the trackings of 11 Nov 15:52 and 12 Nov 07:03.
  - the Polar H10 report's figures, and any other ECG with such a spike.
- Combined ECG: when the tracking's Polar H10 ECG has been deleted, the page now says it is in the Bin and can be restored from there.
- Every ECG strip on screen (live, ECG history, the Combined ECG and the watch's strips) is now 4 big squares tall: 20 mm, ±1 mV about the middle. The printed event strips are 20 mm tall too.

## 11 Nov 2026 – v1.44.2 – Heart-rate chart removed from Synchronised ECG Tracking *(GitHub)*
- Synchronised ECG Tracking: the "Heart rate: Polar H10 and Watch D2" chart is removed. It was redrawn as a new picture every second during a tracking, which grew with its length. The heart rate is still kept with the tracking for its reports.

## 11 Nov 2026 – v1.44.1 – Synchronised ECG Tracking asks the watch only for its ECG strips, after Stop *(GitHub)*
- Synchronised ECG Tracking: the watch ECG strip display ("ECG from the Watch D2") is removed from the page, and nothing is downloaded from the watch's ECG during the tracking. Take the watch ECGs as usual; they are fetched afterwards.
- Stop downloads every Watch D2 ECG strip from the tracking's period (start to Stop, plus a strip begun up to a minute before the start), then again 45 and 90 s later for one still finishing. A line under Start again says how many strips it found on the watch and how many it saved new in ECG history (the rest were already there).
- Strips from that period saved another way (D2 Link) are marked as the tracking's too.
- The watch is no longer asked for heart rate: its heartbeat test isn't started, and the Watch heart rate, beat interval, RMSSD and signal tiles are removed. The tracking's watch figures come from the ECG strips and D2 Link's downloads.
- The watch is no longer asked for blood pressure readings: the minute-by-minute checks for an hour, the check when the watch connects and the "Check the watch for blood pressure now" button are removed, with the blood pressure tile and card. A reading taken within an hour of the start is still added to the tracking from D2 Link's downloads.
- Watch message capture: the options to pause the strip checks and the heartbeat test are removed, as neither runs during a tracking now. The capture only listens.
- Fix: every Stop repeated part of the page's start-up. It added another listener for the watch connecting and reloaded every earlier tracking's ECG. That work grew with each tracking; it now runs once, when the page opens.

## 11 Nov 2026 – v1.44.0 – Breathing, movement and heart-rate strips under a sleep's ECG *(GitHub)*
- ECG history › an ECG recorded with a sleep (Sleep monitor, and Synchronised Sleep Tracking's Polar H10 part): under the ECG are three more strips from the same moments, all recorded by the Polar H10:
  - **Breathing**: the chest's rise and fall from the strap's accelerometer. In each minute it uses the direction that moves most with the breathing, and it is turned so a breath always goes the same way.
  - **Movement**: how far the chest's acceleration is from its average over the second around it.
  - **Heart rate**: each beat's rate, with missed or extra beats left out.
- One slider moves all four together. Dragging a strip, or scrolling it sideways, moves the ECG as well. The strips have the same width in seconds as the ECG, at its calibrated speed.
- Each strip's scale is set by the minute around it, so it doesn't jump as you move. A moment without a reading from the strap is left empty.
- The strips need the sleep's raw data, so they show on the device that recorded it.

## 10 Nov 2026 – v1.43.9 – Watch ECG prompts removed; watch download errors handled; a more accurate hang record *(GitHub)*
- Synchronised ECG Tracking: the watch ECG prompts (the beep every few minutes, and "ECG prompts X of Y" in the history) are removed. Watch ECGs taken during a tracking are still fetched by themselves.
- Watch: a message to the watch that couldn't be sent now fails at once. Before, its "the watch did not answer" error went off a few seconds later with nothing to catch it (the "Unhandled" lines in About › Problems). A message whose sending never finishes now ends at the time limit instead of holding up every later download.
- About › Problems: time with the page hidden, the print dialog open, or an alert or confirm box waiting is no longer recorded as the page not responding (several earlier entries were these). A real pause now says what the app was working on (for example "saving the tracking" or "watch ECG check").
- Watch message capture: the screen updates at most once a frame, so a burst of messages during a download doesn't slow the page.

## 10 Nov 2026 – v1.43.8 – Combined sleep: a waking the watch saw counts where the strap couldn't tell the stage *(GitHub)*
- Combined sleep report (combine rule 4): where the Polar H10 read a minute as asleep but couldn't tell its stage, the Watch D2's awake now stands. It isn't joined into the sleep block around it, and it counts as a time woke up even if it lasts one minute, as the watch counts it.
- Example, night of 9–10 Nov: the watch's 1-minute waking at 03:02 was lost; the combined report now shows 2 times woke up, like the watch, instead of 1.
- Saved reports are generated again, and the earlier version is kept.

## 9 Nov 2026 – v1.43.7 – Problems is its own section on About *(GitHub)*
- About: "Problems recorded on this device" is now a separate section with its own heading, like Storage, instead of looking like part of Storage.

## 9 Nov 2026 – v1.43.6 – Fixes that can stop the app hanging, and a record of hangs *(GitHub)*

- Fixed a loop that could freeze the app. ECG history works out a watch strip's heart rate again if it came out blank. For a strip with no clear beats it stayed blank, and every redraw tried again and started more redraws. Each strip is now tried once per visit, and closely spaced redraws are combined into one.
- Sleep monitor: the strap reconnect loop always waits between attempts, so it can never spin.
- About › **Problems recorded on this device**: when the app stops without closing normally (for example Chrome had to be quit), pauses for over 5 seconds, or hits an error, it records when, on which page, the version and the error message. There's a Copy and a Clear button. No recordings or health data, and it stays on this device.

## 9 Nov 2026 – v1.43.5 – Recorded ECGs at the calibrated scale; the mouse wheel no longer stretches them *(GitHub)*

- The ECG viewer in ECG reports and in the Combined ECG now uses the same scale as the live trace: 25 mm/s and 10 mm/mV, with your screen calibration and ECG size setting. The QRS and every other wave keep their true width and height, whatever the window width.
- The mouse wheel no longer zooms the ECG: it scrolls the page as anywhere else. To move through a recording, drag it, scroll sideways (trackpad or Shift + wheel), or use the slider. Pinch-to-zoom and the − / + buttons are removed.
- The waves change size only when you change the ECG size (Actual, Double or Triple size) or recalibrate the screen. The ECG report now has that control under its viewer too, and the viewer grows taller for the larger sizes.

## 9 Nov 2026 – v1.43.4 – Start again waits for the last tracking to be saved *(GitHub)*

- **Start again** stays unavailable for the few seconds a stopped tracking takes to save its ECG and beats, so a new tracking can't mix with the one being saved. The prompts of the stopped tracking end the moment you press Stop. If saving fails, Start again still becomes available.
- The prompt results saved after Stop read the tracking's entry only just before saving, so a blood pressure reading added a moment earlier is kept. Thanks to ChatGPT's review.

## 9 Nov 2026 – v1.43.3 – Each tracking keeps its own ECG prompt results *(GitHub)*

- The checks after Stop keep to their own tracking. If you start a new tracking within 90 seconds, a late check no longer stops the new tracking's prompts or writes their results into the previous tracking. A late check now counts its tracking's prompts from the strips saved in ECG history, however they arrived.
- The prompts' cut-off is now the moment you press Stop. Before, it was set only after the strap's ECG had been saved, so a strip started a few seconds after Stop could still count. Thanks to ChatGPT's review.
- Watch message capture: next to **Add mark**, a count shows how many ECGs you have marked as finished, for example "ECG finished 3 times". Each "ECG finished" mark in the saved file carries its number. The count starts again with each capture.

## 9 Nov 2026 – v1.43.2 – Watch strips: more checks around each ECG and after Stop *(GitHub)*

- The watch's ECG message (`23/0d`, code 103) now starts four checks for a new strip: at once, after 6 seconds, and after 40 and 50 seconds. Two captures disagree on whether it comes just before an ECG or after one, so the checks cover both. The 20-second backup check stays.
- After Stop, the watch is checked again 45 and 90 seconds later. A strip still being recorded at Stop is collected without a separate Download ECG. A strip started after Stop goes into ECG history but doesn't count for the tracking's prompts.
- Watch message capture no longer pauses the strip checks unless you tick **Also pause the checks for new watch ECG strips**, so a capture during a tracking shows the downloads as they normally happen.
- Saving a tracking's prompt results no longer risks overwriting a blood pressure reading added in the meantime.

## 9 Nov 2026 – v1.43.1 – Watch ECG prompts no longer freeze the page *(GitHub)*

- Fixed: starting a tracking with Watch ECG prompts on could freeze the page. To find the next prompt, the page built a list of every future prompt, billions of them. It now works out only the next one. Thanks to ChatGPT's review.
- Only the watch's ECG message with code 103 starts a check for a new strip. Any other code is noted in the connection log.

## 9 Nov 2026 – v1.43.0 – Watch ECG prompts, and strips fetched as soon as the watch finishes *(GitHub)*

- Synchronised ECG Tracking: new **Watch ECG prompts** choice (Off, or every 2, 3, 5 or 10 minutes) above the timer. During a tracking, the page beeps and asks you to take a 30-second ECG on the watch: first 30 seconds after the start, then at each interval. No prompt comes too late to finish before a set end.
  - Each prompt shows as done, with the time of the ECG that answered it, or as missed. A strip counts for the prompt it was recorded after, even if it downloads later.
  - The result is saved with the tracking, and its history row shows "ECG prompts 2 of 3".
  - The watch can't be started from the app, so you start each ECG on the watch.
- The watch sends a message on its ECG service when an ECG ends (`23/0d`, code 103). That message now starts the strip download straight away, with a second check 6 seconds later in case the watch was still saving it. The regular check now runs every 20 seconds instead of every 5, as a backup. An ECG counts only once its strip is actually downloaded.

## 9 Nov 2026 – v1.42.9 – Watch ECG downloads no longer get mixed up; strips labelled correctly *(GitHub)*

- Two downloads from the watch at once, for example Download ECG while the strip checks run during a tracking, mixed up each other's pieces. Both then stalled ("No more data from the watch … asking again"). Downloads from the watch now take turns.
- The strip checks during a tracking now ask only for ECGs newer than the last one received. Before, each check downloaded every strip since Start again (117 KB each time).
- Watch strips saved on the Synchronised ECG Tracking page are now marked as part of a tracking only when a tracking covers them. Before, every strip saved there was marked, including the ones from the watch message captures. Those are corrected when the page opens, so ECG history shows them as "From the Watch D2 ECG app".

## 9 Nov 2026 – v1.42.8 – Watch message capture shows only what the watch sends by itself *(GitHub)*

- Watch message capture now also pauses the checks for new watch ECG strips while it runs. Their replies (`2c/06` about every 6 seconds) were filling the first capture.
- When the capture stops, the checks resume and fetch any strip taken during it.
- For the messages the watch sends during an ECG, the capture now also shows their protocol numbers: package names, the configuration ID and action, and small state bytes. Never measurements. The second capture showed the watch announcing a finished ECG on its own (`37/01` and `34/01`, repeated because nobody replied), a status message about every 20 seconds while the ECG app is open (`1f/01`), and an ECG-service message when the screen closes (`23/0d`). These numbers show which commands to try next.

## 9 Nov 2026 – v1.42.7 – Watch message capture, for working out how the watch starts its ECG *(GitHub)*

- Synchronised ECG Tracking: a new expandable **Watch message capture (testing)** section at the bottom of the page. It records every message the watch sends while it runs, whatever else is running, with no limit. For each it records the time, service/command and the layout of its fields (tags and lengths), never their values.
- **Add mark** puts your own steps in the record: idle, ECG screen opened, finger on the button, ECG finished, ECG screen closed.
- The live heartbeat test can be paused during the capture so the ECG is seen on its own. It resumes when you stop.
- **Save as text** keeps the record as a file to share.

## 9 Nov 2026 – v1.42.6 – D2 Link: a fuller check of the watch's ECG support *(GitHub)*

- When D2 Link sets up the watch, it now also asks about the watch's configuration messages (where its ECG settings live) and reads four ECG capability flags. As before, it only asks and changes nothing on the watch. The connection log shows everything on one line starting "Watch ECG:".

## 9 Nov 2026 – v1.42.5 – D2 Link checks whether the watch has an ECG command *(GitHub)*

- When D2 Link sets up the watch, it now also asks whether the watch supports its ECG service and the ECG on/off command. It only asks and sends nothing that changes the watch. The connection log shows the answer, for example "Watch ECG: service yes, ECG on/off command yes". This is a first step towards starting the watch's ECG from the app during a Synchronised ECG Tracking. You still touch the button for each 30-second strip.

## 9 Nov 2026 – v1.42.4 – Version line stays at the bottom of the menu *(GitHub)*

- Desktop: only the menu in the left sidebar scrolls now. The logo at the top and the version line at the bottom (for example "Version 1.42.4 (9 Nov 2026)") stay in place.

## 9 Nov 2026 – v1.42.3 – Storage: the browser's allowance, named as such *(GitHub)*

- About › Storage: "Space still available" is now called **Space this browser allows the app**. A note under the tiles explains that it is the browser's allowance for this website, not the computer's free space, since a web page can't see how full the disk is.

## 9 Nov 2026 – v1.42.2 – Download ECG, and watch strips from a tracking saved by themselves *(GitHub)*

- Synchronised ECG Tracking: the watch's 30-second ECGs used to be fetched only after pressing **Start watch ECG**, so strips taken during a tracking without it never reached ECG history. Now:
  - starting a tracking with the watch connected, or connecting the watch during one, starts fetching them;
  - stopping the tracking checks the watch once more for any strip from the tracking not yet saved.
- D2 Link: a new **Download ECG** button, between Download sleep and Download all data, downloads only the watch's 30-second ECG recordings for the chosen period and saves them in ECG history. **Download all data** now includes them too. Strips that fall within a synchronised ECG tracking are saved as part of it, so its Combined ECG can use them. A strip already saved isn't saved again.
- D2 Link: the three download buttons now share the same colour and design as Download sleep.
- The connection log and the download history show how many strips were saved and how many had no change.

## 9 Nov 2026 – v1.42.1 – Combined ECG says why it is empty *(GitHub)*

- When a Combined ECG can't be shown, the report now says why instead of always "No ECG strips were taken":
  - the strips (or the Polar H10's full ECG) are only on the computer or browser that recorded them, because other devices have summaries only;
  - no watch strips were saved during the tracking, with how to take them;
  - the strap's ECG isn't on this device;
  - an error while putting the two together, which was hidden before.

## 9 Nov 2026 – v1.42.0 – Tidier sleep stages, old versions to the Recovery centre, Synchronised ECG Tracking *(GitHub)*

- **Synchronised ECG Tracking**: Synchronised Tracking is now called Synchronised ECG Tracking everywhere in the app.
- Combined sleep:
  - Being awake before falling asleep no longer counts as waking up. Times woke up are now counted from the combined stages after falling asleep, not taken halfway between the two devices.
  - A block of 1–2 minutes (missing minutes included) that breaks up a longer block, with at least 2 minutes of it on each side, is now part of that block.
  - Existing combined reports are generated again with these rules, as a new version.
- Sleep History and Synchronised Sleep Tracking History: "Nap", "Night" and "Version … of … (latest)" now look like the line below. Only the date stays bold.
- Older versions of synchronised ECG tracking and synchronised sleep reports move to the Recovery centre a week after a newer version replaced them, and are deleted from it for good after four more weeks. This runs when the app starts and every day while it stays open. Restoring a version puts it back in its history to stay. Other devices don't bring back a version that was moved.
- About › Storage is now an expandable section. It is measured again every day while the app is open, shows when it was measured, and has a **Refresh** button.
- Live ECG: the trace keeps its calibrated size. It can no longer be stretched by the page's width or by zooming or moving to another screen.
- Polar H10: when it doesn't appear in Chrome's list or won't connect, the connection log now says to switch it off for 30 seconds (unclip the sensor), clip it back on, wet the electrodes and try again.

## 8 Nov 2026 – v1.41.18 – "Combined ECG", without repeats *(GitHub)*

- Synchronised Tracking: the ECG button and report are now called **Combined ECG**.
- At the bottom of the Combined ECG report, the section repeating the top (combined duration, values outside the range, and every box) is removed. What's left there is only what the top doesn't show: the heartbeats both devices found and the list of events, with which were counted.

## 8 Nov 2026 – v1.41.17 – Combined ECG shows its combined duration *(GitHub)*

- A synchronised tracking's box in ECG history, and its two-ECG report, now give the combined duration of the spliced watch strips (for example "Duration 4:30") instead of the Polar H10's whole recording (7:01). Synchronised Tracking History keeps the tracking's own duration.

## 8 Nov 2026 – v1.41.16 – "From …" styled as the line below *(GitHub)*

- "· From Synchronised Tracking" and the like now have the same font weight, size and colour as the second line of each row.

## 8 Nov 2026 – v1.41.15 – Account button shows "1:M" *(GitHub)*

- The account button at the top shows the user number and alias, for example "1:M", instead of just "1". It updates when you change user or alias.

## 8 Nov 2026 – v1.41.14 – "From …" in normal weight *(GitHub)*

- In ECG history and Synchronised Tracking History, only the date and time are bold. "From Synchronised Tracking", "From ECG live" and the like are in normal weight.

## 8 Nov 2026 – v1.41.13 – User and alias as "1:M" *(GitHub)*

- Every box shows the user number and alias on the right as "1:M" (user 1, alias M), or just the number when there is no alias: each recording and synchronised tracking box in ECG history, and each row in Synchronised Tracking History.

## 8 Nov 2026 – v1.41.12 – Every ECG history row in the same two lines *(GitHub)*

- Every recording in ECG history and trending uses the format of the synchronised tracking boxes:
  - **First line:** the date and time, then where it came from: From ECG live, From Synchronised Tracking, From Sleep monitor, From the Watch D2 ECG app, Imported EDF file, Demo, or Saved ignoring irregular shape.
  - **Second line:** what was recorded and how long, for example "Polar H10 · With sleep · Duration 5:08:48".
- Heart rate, HRV and the event count are no longer in the list: they are in each report. The alias a recording was made under stays on the right.

## 8 Nov 2026 – v1.41.11 – Watch heart rate only from fresh beats *(GitHub)*

- **Fix:** Synchronised Tracking kept showing, and saving, the watch's last heart rate after the watch stopped sending beats. In the 10:21 tracking on 8 Nov the watch sent none (its ECG measurements interrupt the heartbeat test), yet 125 bpm was recorded for 7 minutes. The watch's heart rate now counts only beats from the last 10 seconds and shows "--" otherwise. A tracking where the watch sent no beats saves no watch heart rate.
- History lines say "Watch D2" when the watch sent beats or when its ECG strips were taken during the tracking, but not for an old stale heart rate on its own.
- Checked: the blood pressure readings at 16:11–16:54 belong to the 3 Nov 16:43 tracking (within an hour of its start), so they were right. The 10:21 tracking has none.

## 8 Nov 2026 – v1.41.10 – One simple line for each tracking *(GitHub)*

- Synchronised Tracking History, and each tracking's box in ECG history and trending, now use the same short format. The first line is the date and time, then "From Synchronised Tracking". The second says what was recorded and how long: "Polar H10 · Watch D2 · BP recorded · Duration 7:01".
- The heart rates, RMSSD, blood pressure values and the "Generated…" note are no longer in the list: they are in the reports. A version number still shows where a tracking has more than one.

## 8 Nov 2026 – v1.41.9 – No more repair of old watch strips at Start *(GitHub)*

- Start watch ECG no longer fetches strips saved before v1.41.0 from the watch to repair them. All that could be repaired have been. The five left (08:17–08:21 on 8 Nov) are no longer on the watch: they stay labelled "may be damaged" and are left out of the two-ECG analysis.

## 8 Nov 2026 – v1.41.8 – 6 and 7 minutes; damaged watch strips left out *(GitHub)*

- "Track for" on ECG live and Synchronised Tracking adds **6 minutes** and **7 minutes**.
- Watch strips cut off by v1.39.0's scale error that the watch no longer holds (so they couldn't be repaired) are left out of the two-ECG report's analysis, which says how many. In ECG history they're labelled "saved before v1.41.0, may be damaged".

## 8 Nov 2026 – v1.41.7 – Synchronised Tracking History: Polar H10 report and ECG only *(GitHub)*

- Synchronised Tracking History and its reports no longer offer the D2, Combined and Comparison reports. Each tracking has its **Polar H10 report** and its **ECG**: with the watch's strips, both ECGs together with the comparison and combined figures.
- The **Download today's watch ECGs again** button is removed. Watch strips saved before v1.41.0 are now repaired automatically: the first time you press Start watch ECG, the app fetches them again from the watch and replaces them. Nothing new is added that way.

## 8 Nov 2026 – v1.41.6 – Watch D2 ECG strips in their own section *(GitHub)*

- ECG history and trending: the watch's 30-second ECG strips are now listed in their own section, **Watch D2 ECG strips**, below the other recordings, with how many there are. They open, delete and sync as before.
- The trend charts use the other recordings only, so 30-second strips don't skew them. A synchronised tracking's box above still shows both ECGs together.

## 8 Nov 2026 – v1.41.5 – Two-ECG view: each event once in Previous / Next *(GitHub)*

- The two-ECG view's event navigation listed the same premature beat twice, once from each device (their marks fall a few tens of ms apart on the two leads), so 6 events showed as 13.
- It now follows the same rule as the counts: only events both devices saw at the same heartbeat are listed, stepped through with Previous and Next, and marked with red triangles, one entry per heartbeat (a premature beat with the pause right after it is one event). An event seen by only one device is left out.

## 8 Nov 2026 – v1.41.4 – Combined boxes laid out as the H10 ECG report; no Training section *(GitHub)*

- The two-reading boxes (Combined report and the two-ECG report) now follow the Polar H10 ECG report:
  - **Summary first:** the values outside the reference range are listed at the top, each naming the device.
  - **Groups:** then "Rhythm and HRV" and "ECG waves".
  - **Highlighting:** a box with a reading outside its range is highlighted, with ▲ or ▼ for each device that is out.
  - **Events:** the count and % of beats, with the ≤ 1 % range.
- The Training section (effort, HR recovery, highest HR and heart-rate zones) is removed from the Polar H10 ECG report and from the combined boxes.

## 8 Nov 2026 – v1.41.3 – Two readings in every box, with normal ranges; watch events only where the strap agrees *(GitHub)*

- **Boxes:** the Combined report (in "ECG where both recorded") and the two-ECG report now show every box of the Polar H10 ECG report, each with two readings: the strap's and the watch's for the same moments. The boxes are mean heart rate, HRV score, RMSSD, SDNN, pNN50, pNN200, Poincaré SD1/SD2, events, QRS, QT, QTc, T wave positive, T-wave amplitude, T/R ratio, J point, ST at J+60 ms, R and S amplitude, 2–8 Hz energy and effort.
- **Normal ranges:** each box has the same range as the H10 report (by age and sex; resting ranges not applied during exercise). A reading outside it is marked ▲ or ▼.
- **Events:** a watch event where the strap shows a normal beat no longer counts. In both reports, events count for either device only where both saw one at the same heartbeat. The Combined report lists how many were left out on each side.

## 8 Nov 2026 – v1.41.2 – Combined report: each premature beat counted once *(GitHub)*

- The Combined report counted events twice when there were watch strips: once in "ECG waves (Polar H10 only)" (every strap event of the tracking) and again in "ECG where both recorded" (those both devices saw). Events are now counted once, in "ECG where both recorded": only those the watch's strips confirm.
- Safeguards: the same watch ECG saved twice (its start a second apart) is used once, and a premature beat with the pause or odd shape right after it (within 1.2 s) counts as one event.

## 8 Nov 2026 – v1.41.1 – Two-ECG box laid out properly, combined duration, and heartbeats found after a burst *(GitHub)*

- The box for a synchronised tracking's two ECGs now shows its two readings in full width under the date, instead of squeezed into a narrow column.
- The combined duration of the spliced strips is shown: in the ECG history box (the strips' time within the tracking), at the top of the two-ECG report (with any strips left out), in the comparison and combined reports' strip sections, and in the D2 report.
- Heartbeats are found after a burst at the start or end of a recording (up to 3 s, over 8 times the size of the rest, such as a finger meeting the watch's button). The burst is now treated as no signal. Before, it set the beat detection's threshold so high that a strip could show no heart rate at all (two strips on 8 Nov: now 33 and 34 beats). Strips already saved with a blank heart rate are worked out again when ECG history opens.
- The Watch D2 line averages only the strips with heartbeats, so one strip without them no longer turns the watch's heart rate and HRV into "--".

## 8 Nov 2026 – v1.41.0 – Watch and strap ECGs lined up beat for beat; both in ECG history *(GitHub)*

- **Events now line up.** Three things caused events a few beats apart:
  - Some watch strips run 2.5 % fast (512 samples a second, not 500).
  - With a steady rhythm, a shift of one whole beat also "matched".
  - Analysed as one joined recording, some strips lost all their beats.
- **How each strip is now matched:**
  - Its stretch and shift are fitted together, by how closely each beat lands and by pattern recognition of the rhythm: each beat's interval against the strap's at that heartbeat.
  - A lone event (no other event within 5 s) on each device, of the same kind, is taken as the same heartbeat and anchors the fit.
  - Each strip is analysed on its own before the pieces are joined.
  - Strips without clear heartbeats are left out.
- **Result on 8 Nov:** all six premature beats the strap marked fall on the same heartbeat in the watch's strips, and intervals agree within 3 ms on average.
- **Watch strips from now on:** each strip's rate (500 or 512) is chosen by which gives the heart rate the watch itself reported. **Download today's watch ECGs again** also replaces strips saved before this version.
- **ECG history and trending:** each synchronised tracking with watch strips gets its own box, with both readings (Polar H10, and Watch D2 with the number of strips). It opens both ECGs together.
- **The two-ECG report:** each box holds both readings (heart rate, RMSSD, SDNN, QRS, QT, QTc, R and T waves, events), above the two ECGs on one slider. ← returns to where it was opened from.

## 8 Nov 2026 – v1.40.0 – Watch ECG strips in the tracking reports, and a scale fix *(GitHub)*

- **Fix:** the watch's ECG values were read in the wrong unit, so v1.39.0 strips were cut off at the 16-bit limit (a sixth to two fifths of each strip). The unit is now worked out from the size of the waves (mV, µV or nV). **Download today's watch ECGs again** (on the Watch ECG card) fetches the day's recordings from the watch and replaces the cut-off strips.
- Events %: beats that are likely connection errors no longer count towards "% of beats".
- **D2 report:** every watch ECG strip taken during the tracking, analysed together as one recording (heart rate, HRV, QRS, QT, QTc, wave sizes and events; the joins are left out), with a list of the strips.
- **Comparison report:** each strip is lined up with the Polar H10 beat for beat (the watch's clock only gives whole seconds, so each strip is shifted to fit). The strap's ECG is cut to the same moments and pieced together. Shows how many beats match, the interval difference, and every ECG figure side by side.
- **Combined report:** the same moments only. Heart rate and HRV come from the heartbeats both found; the waves are the strap's. An event the strap marks counts only if the watch's strip shows one at the same heartbeat.
- **ECG** (in Synchronised Tracking History and on each report) now opens both ECGs one above the other: the watch's strips joined, and the strap's ECG of exactly the same moments. They move and zoom together, with Previous and Next event, and the comparison and combined figures underneath. Without watch strips it offers the Polar H10 ECG as before.

## 8 Nov 2026 – v1.39.0 – ECG from the Watch D2, 30 seconds at a time *(GitHub)*

- ECG live and Synchronised Tracking have a new **ECG from the Watch D2** card. ECG live also gets its own Watch D2 connection (optional), with the watch account ID box.
- How it works: connect the watch and press **Start watch ECG**. Then take an ECG on the watch: open its ECG app and keep a fingertip of the other hand on the watch's lower button for 30 seconds. Within seconds of it finishing, the app downloads the recording, plays it on screen like a Polar strip, analyses it (heart rate, RMSSD, QRS, QT, QTc and events) and saves it in ECG history as "Watch D2 ECG". Take the next ECG on the watch straight away, again and again, until you press **Stop**.
- The watch can't stream its ECG or record continuously, because it needs your fingertip on the button, so it is always one 30-second strip at a time. The app checks the watch for new recordings every 5 seconds.
- Strips are converted to the same scale and rate as the Polar H10 (µV, 130 samples a second), so reports, prints, exports and trends work the same. Each strip has an Open report button. Strips from Synchronised Tracking are marked as such.
- In the cloud, watch ECG rows are stored as imported recordings with a marker, so your other devices still show them as Watch D2 ECG.

## 8 Nov 2026 – v1.38.1 – Ignore Irregular Shape for one recording at a time *(GitHub)*

- Ignore Irregular Shape now applies only to the recording it was turned on for. Opening another saved ECG recording shows its original version. Rows saved ignoring irregular shape are still always shown that way.

## 8 Nov 2026 – v1.38.0 – Ignore Irregular Shape, and save ignoring it *(GitHub)*

- ECG report: a new **Ignore Irregular Shape** button at the top, next to ← Recordings. When it's on, beats flagged only for their shape count as ordinary beats in every figure (heart rate, HRV, QTc, the charts) and on the ECG strip, and aren't events. Premature beats and pauses are still events.
- The report title says "Irregular Shape ignored", also when printed. Click again to go back.
- The recordings list and trends keep the standard figures.
- Every recording's summary in the cloud (and in uploads and backups) now also carries a version worked out ignoring Irregular Shape: its figures, average beat, events and strips. It stays hidden and is shown only while Ignore Irregular Shape is on, so summary copies on your other devices can show it too. Recordings already in the cloud get it from the device that recorded them, a few at each sync, and the other devices then fetch it once.
- **Save ignoring irregular shape** appears next to it while Irregular Shape is ignored. It saves the recording as a new row in ECG history, marked "ignoring irregular shape", which is always analysed that way (also on your other devices). The original is unchanged. If the same recording is already saved like this, exactly the same, it says so and doesn't save it again.

## 8 Nov 2026 – v1.37.0 – Step through ECG events; connection errors aren't events *(GitHub)*

- ECG history and trending: **← Previous event** and **Next event →** under the ECG strip, with which event is shown (for example "Event 3 of 12 · Premature beat at 1:23"). Clicking an event in the list moves there too.
- A beat that would have been flagged next to lost signal, a flat line, clipping or a spike far bigger than any heartbeat is now treated as a likely connection error. It isn't listed, counted or marked as an event (or used for HRV), and the Events heading says how many were left out.
- When Bluetooth packets from the Polar H10 are lost, the gap is now kept as a flat line of the right length (up to 2 minutes), using the strap's own clock. The ECG keeps its true timing, and the gap can't look like a premature beat.
- Event counts in the recordings list are updated when each recording is opened.

## 8 Nov 2026 – v1.36.0 – One look for the device pages; the strap decides combined sleep stages *(GitHub)*

- ECG live, Sleep monitor, D2 Link, Synchronised Tracking and Synchronised Sleep Tracking now share the same parts: a device card with its status, **Forget pairing** for each device that can connect, and the connection log shown as on ECG live.
- The live ECG shows on every page that monitors the Polar H10 (now also Synchronised Sleep Tracking). D2 Link has none.
- **Track for** choices on every page that tracks: 1, 3, 5 or 10 minutes, until you stop, or a chosen number of minutes; on the sleep pages 6, 7, 8 or 9 hours, until you stop, or a chosen number of hours. The recording then stops by itself.
- **Watch account ID (optional)** is on D2 Link, Synchronised Tracking and Synchronised Sleep Tracking, and is the same on all three. It is hidden like a password, and **View** shows it. It is used only to link with the watch: it stays on this device and isn't in any report, PDF, backup or cloud copy.
- Combined sleep reports take each minute's stage from the Polar H10, and the watch fills only the minutes the strap has no reading or no stage for. Earlier reports are made again with a new version.
- A cleaner look throughout: page titles with a short introduction, softer cards, a marked device card, clearer status lights and the same field and button style everywhere.

## 7 Nov 2026 – v1.35.1 – Sleep recordings saved every hour *(GitHub)*
Why: saving once an hour is enough for this use.
- A running sleep recording is now saved every hour instead of every 2 minutes, and when the page closes if the browser allows it.

## 7 Nov 2026 – v1.35.0 – Sleep recordings can't be lost *(GitHub)*
Why: a recording was held in memory until Stop, so a closed page or crash lost the whole night.
- A running sleep recording, with its ECG, is saved on the device every 2 minutes.
- If the page closes, the browser stops or the device restarts, the recording is restored when the app next opens, and a message says so. It is saved up to the last 2 minutes or so.
- The browser warns before you close or reload the page during a recording.
- A sign-in that lapses overnight no longer reloads the page during a recording. It reloads after you press Stop.
- Locate connected devices explains what to do if Chrome can't measure the signal, and reminds you to set its experimental setting back to Default afterwards.
- This needs a small storage update: close any other open tabs of the app after updating.

## 6 Nov 2026 – v1.34.1 – Reports follow new stages from other devices *(GitHub)*
Why: a report sent from another device can change the stages while its totals stay the same.
- A device with a cloud copy now makes new Synchronised Sleep Tracking reports whenever the stages themselves change.
- Reports made from an older cloud copy keep that copy's rule version, so the device with the raw recording still redoes them.

## 6 Nov 2026 – v1.34.0 – Reports stay consistent with your choices *(GitHub)*
Why: a review found places where reports and devices could disagree.
- Changing night or nap, or a late start, now generates new Synchronised Sleep Tracking reports.
- A late start is now used in the report sent to the cloud, and a report redone on the device with the raw recording replaces the copy on other devices.
- Sleep with an uncertain stage still counts as sleep when the devices are compared, and the Combined report no longer calls it light sleep.
- Saved versions of a sleep report can no longer change the recording.
- Scores are no longer scaled up when a measure is missing, so less evidence can't make a stage look more certain.
- Agreement shows N/A when the watch gave no stages, as for naps. Sleep stages are labelled experimental.

## 6 Nov 2026 – v1.33.0 – More honest sleep stages *(GitHub)*
Why: a report should show what it knows, and not guess when a signal is missing.
- Coverage now counts only time with both usable heart and movement data, and the report shows heart rate, HRV, movement and breathing separately.
- A missing measure is no longer read as an average one. With too little signal, sleep is kept but the stage is marked uncertain and appears as a gap.
- Breathing from the heartbeats now joins across bad beats, so it is available far more often.
- The local comparison resists artefacts and needs at least 10 minutes of sleep around it.
- REM is no longer blocked for the first 50 minutes: it is only less likely, and strong evidence can overrule that. The stronger of deep and REM now decides.
- On a sleep report, choose whether it counts as a night or nap, and mark a recording that started after you fell asleep. These sync to your other devices.
- The report notes possible quiet waking, when heart rate rises without movement. This doesn't change the stages or score.
- Synchronised Sleep Tracking reports are generated again, and earlier versions stay.

## 5 Nov 2026 – v1.32.1 – Walking copes with sparse signals *(GitHub)*
Why: a phone may hear the device only every few seconds, and gentle steps weren't counted.
- Each reading now uses the signal heard in the last 10 seconds, not only the last 3.
- Gentle steps are counted.
- The page says if the device has no step sensor or compass, or if nothing has been heard.

## 5 Nov 2026 – v1.32.0 – Map the signal automatically while walking *(GitHub)*
Why: pressing a button at every spot is slow.
- Locate connected devices has a Start walking button. It listens to the device continuously and saves a reading about every 3 seconds once you have moved 1 m, so the map and the + update by themselves.
- Your position comes from counting steps and the phone's compass after you tap your start point. GPS is used only when accurate to 6 m, which is rare indoors. A tap corrects any drift.
- A Mac has no step sensors or GPS, so tap your position as you move.

## 5 Nov 2026 – v1.31.0 – Measure the signal on the device you hold *(GitHub)*
Why: one device is easier than reading a second one while walking around.
- Locate connected devices has a Calculate ave dBm button. It averages the signal for 10 seconds on the phone or laptop you are holding, where the browser allows it. Tap the plan to save the average. The slider stays for a reading from a scanner app.

## 5 Nov 2026 – v1.30.0 – Locate connected devices *(GitHub)*
Why: to help find a lost Polar H10 or Watch D2 at home.
- New page Locate connected devices, opened from Sync & backups. Enter the signal strength from a phone scanner app at different places on a plan of your home, and the map shades where the device most likely is, marks the best spot and suggests where to take the next reading. A photo of a floor plan can go behind the plan.
- A web page can't read signal strength itself, so the readings are typed in. They stay on the device.

## 5 Nov 2026 – v1.29.0 – Better sleep stages from the Polar H10 *(GitHub)*
Why: comparing with the whole night only found the lowest heart rate hours, and stages flickered.
- Each 30 seconds is now compared with the surrounding 90 minutes, not the whole night, so the night's drift in heart rate no longer decides the stage.
- Deep and REM runs last at least 5 minutes.
- Over a night of 3 hours or more, deep sleep is favoured early and REM late.
- Breathing regularity now also comes from the heartbeats, combined with the chest movement.
- Synchronised Sleep Tracking reports are generated again with these rules, and the earlier versions stay. Reports on Sleep history use them when opened.
- The Comparison report adds Same main stage in 5-minute blocks.
- Times woke up in the Combined report is now halfway between the two devices. Before, it could show fewer than either.

## 5 Nov 2026 – v1.28.2 – Fell asleep compared in seconds *(GitHub)*
Why: a difference in whole minutes can disagree with the times beside it.
- In the sleep Comparison report, Fell asleep now shows both times with seconds, and the difference in seconds.

## 4 Nov 2026 – v1.28.1 – Failed connections aren't recorded *(GitHub)*
Why: the download history should list downloads, not failed attempts.
- A download that got nothing, such as a failed connection or refused login, no longer goes in the history. The reason still shows on the page and in the connection log. A download that stopped part way, after getting something, is still recorded.
- Earlier lines of this kind move to the Recovery centre, on all your devices.

## 4 Nov 2026 – v1.28.0 – Identical downloads are left alone *(GitHub)*
Why: downloading the same data again shouldn't replace it, sync it again or make new report versions.
- A sleep record or other watch record identical to the stored one is no longer replaced. The download history says "nil change", for example "2 sleep records (nil change)" or "3 sleep records (1 nil change)".

## 4 Nov 2026 – v1.27.1 – Downloads count sleep records *(GitHub)*
Why: a download can hold naps as well as nights.
- D2 Link now says "sleep records" instead of "nights" when counting a download, in the download history and its messages, including earlier entries.

## 4 Nov 2026 – v1.27.0 – Computers keep everything *(GitHub)*
Why: a computer should hold every tracking and every download, not just the latest ones.
- Computers now keep every synchronised tracking and the whole D2 Link download history, and fetch what was left out. Phones and tablets keep the latest 500 trackings and 300 downloads, and the rest stay in the cloud.
- The Storage section on the About page has a Keep everything on this device tick box to change this for a device.
- When keeping everything, the app asks the browser not to clear its data if the disk runs low.
- If the browser's space for these lists fills up, the oldest entries already in the cloud make room, so a new entry is never lost.
- Fixed: a device at its limit no longer fetches older trackings again at every sync.

## 4 Nov 2026 – v1.26.0 – D2 Link download history syncs *(GitHub)*
Why: the history of downloads should be the same on every device.
- D2 Link's download history now syncs to the cloud and your other devices. Removing a download from the history removes it from your other devices too, and it stays in the Recovery centre. Each device keeps the latest 300.

## 4 Nov 2026 – v1.25.0 – Text syncs to the cloud too *(GitHub)*
Why: numbers and text can now go to the cloud and to other devices.
- Text the watch sends, stored with its measurements, now syncs with the numbers. Text already downloaded goes up at the next sync.
- Saved sleep reports keep the watch's name in the cloud.
- The watch pairing and watch account ID still stay on each device, and the D2 Link download history is unchanged.

## 4 Nov 2026 – v1.24.0 – ECG history and trending; sleep report versions in the cloud *(GitHub)*
Why: to follow each figure over time, and to keep every report version safe in the cloud.
- ECG history is now ECG history and trending. At the top, choose a period from 1 day to 3 years, All or Custom, tick the figures you want, or Select all. Each ticked figure gets its own graph, one point per recording. The choices are kept on that device.
- Every figure of the ECG report can be trended. Demo recordings are left out. Earlier recordings get their figures the first time the page opens.
- Synchronised Sleep Tracking reports and all their versions now sync to the cloud and go into backups, like trackings. The watch's name stays on the device.

## 4 Nov 2026 – v1.23.0 – Saved versions and cloud copies of tracking reports *(GitHub)*
Why: earlier results should stay readable, and a tracking's numbers should be safe in the cloud like everything else.
- When a tracking's blood pressure or the watch's data changes, new reports are generated and the earlier ones stay. Each version has its own row with its own four reports, newest first, and an older row opens the reports as they were.
- Versions are generated after a tracking, after a watch download, after a sync from another device, and when the app opens.
- Synchronised trackings, their beats and their report versions now sync to the cloud as numbers, so another device gets the full reports. The most recently saved copy wins, and versions from both devices are kept. Deleting a tracking removes it from your other devices, and it stays in the Recovery centre.
- Fixed: restoring a tracking from the Recovery centre lost its beats.

## 4 Nov 2026 – v1.22.0 – Four reports for every synchronised tracking *(GitHub)*
Why: one tracking from two devices should be read the same way as one sleep from two devices.
- Synchronised Tracking History now lists each tracking with four reports: Polar H10, D2, Combined and Comparison, plus its ECG.
- Figures from the beats: heart rate (average, lowest, highest, range), beat intervals, RMSSD, average, lowest and highest HRV per minute, HRV score, SDNN, CVNN, pNN50, pNN20, SD1, SD2, SD1/SD2, LF, HF, LF/HF, and how many beats were used.
- The Polar H10 report adds the ECG waves from the saved ECG. The D2 report adds blood pressure and what the watch's downloads hold for that time: minute heart rate, SpO₂, steps, HRV readings, stress, emotion and workouts.
- Combined: the strap's beats stand, and the watch fills gaps of over 2.5 s.
- Comparison: every figure side by side with the difference, how closely the heart rates agree, stored watch readings against the strap, and how to improve accuracy.
- Each tracking's beats are now kept for its reports. Earlier trackings show their saved summary, with the strap's figures from their ECG. Beats stay on the device and go into backups, not the cloud. This needs a small storage update: close any other open tabs of the app after updating.

## 4 Nov 2026 – v1.21.0 – Double and triple size for the live ECG; white patches in PDFs fixed *(GitHub)*
Why: at actual size the trace is small on a laptop.
- Below each live trace you can choose Actual size, Double size or Triple size. The trace gets taller to fit, the squares and calibration mark grow with it, and fewer seconds fit across the screen. The choice is kept on that device.
- It is still 25 mm/s and 10 mm/mV when you count squares. Printed strips stay at actual size.
- Printing: parts of a printed report could be blanked out by white patches when the PDF was opened on a Mac. Charts are now printed as finished pictures, which stops this. Charts have a solid background.

## 4 Nov 2026 – v1.20.0 – Screen calibration for the live ECG *(GitHub)*
Why: a web page can't know a screen's real size, so a small square was not a true 1 mm on screen.
- Below each live trace, Calibrate screen shows a bar to match against a ruler or the short side of a bank card. After saving, a small square on that device is 1 mm × 1 mm, and the note says so.
- It is saved on that device only, and browser zoom is allowed for. Calibrate again after changing the display setting or using another screen.
- Printed strips don't need it: they are always true size at 100 %.

## 4 Nov 2026 – v1.19.1 – Calibration mark on the ECG tracings *(GitHub)*
Why: a standard ECG shows its scale on the tracing itself, so a resized printout can be recognised.
- The live traces and the printed event tracings start with the standard calibration mark, 1 mV tall and 0.2 s wide. It is drawn by the app, not a signal from the strap.

## 4 Nov 2026 – v1.19.0 – Live ECG at the standard clinical scale; event tracings in printed reports *(GitHub)*
Why: the live trace kept changing size because the app rescaled it to the signal, and a printed report only showed the list of events.
- ECG live, Sleep monitor and Synchronised Tracking now always draw the ECG at the scale used in hospitals and clinics, 25 mm/s and 10 mm/mV, stated below the trace. The trace no longer changes size, and a wider screen shows more seconds. The trace is taller so that the fixed scale fits.
- Printed and PDF ECG reports now include the tracings of the first 5 events, 6 s each at 25 mm/s and 10 mm/mV.
- A summary copy from another device prints the event strips it holds.

## 4 Nov 2026 – v1.18.2 – S amplitude shown as a positive number *(GitHub)*
Why: medical literature usually gives the S wave as a depth, a positive size.
- S amplitude is now its depth below the baseline, as a positive number, in the report and the CSV.

## 4 Nov 2026 – v1.18.1 – T/R ratio uses the R wave only *(GitHub)*
Why: the ratio should compare the T wave with the R wave, never the S wave.
- The T/R ratio now always divides by the R amplitude. A beat with no upward R wave has no ratio.

## 4 Nov 2026 – v1.18.0 – Corrected QRS and QT, true R and S waves, clearer printed charts *(GitHub)*
Why: on a recording whose main wave points down, QRS was overestimated, "R amplitude" was really the S wave, and printed charts could not be read.
- QRS: in such a lead the app stepped past a wave that isn't there and put the J point too late. J is now where the trace returns to the baseline, so QRS is shorter and J point and ST move with it.
- QRS, QT and QTc now come from the median beat, the same one shown in the Median beat chart, so the numbers and the chart agree.
- R amplitude is now the tallest upward wave, and there is a new S amplitude (also in the CSV). The T/R ratio still uses the main wave, whichever way it points.
- Printing and PDF: charts are drawn in light colours, with a black ECG trace, even when the app is in dark mode. The chart grids are a lighter tone in the light theme and on paper.
- Reports open from the full ECG use the new measurements. Summary copies on other devices keep their earlier figures.

## 4 Nov 2026 – v1.17.1 – Storage moved to the About page *(GitHub)*
Why: it belongs with the other information about the app.
- Storage is now a section of the About page instead of its own item in the menu. Search finds it under the same words.

## 4 Nov 2026 – v1.17.0 – Storage page *(GitHub)*
Why: to see how much space the app takes on a device, and what each recording needs.
- New Storage page in the Account section. It shows this app's data, what the browser reports as used, and the space it still allows, with about how many hours of ECG would fit.
- What takes the space: ECG recordings, sleep, each kind of Watch D2 data, synchronised sleep reports, the Recovery centre, settings and the app itself, largest first, with the number of items, size and share.
- Storage needed per recording: a minute and an hour of ECG, 8 hours of sleep with and without ECG, one Watch D2 sleep, and the reports for one sleep. It is measured when the page opens, on that device only.

## 4 Nov 2026 – v1.16.2 – Every version of the combined and comparison reports is kept *(GitHub)*
Why: an earlier result should stay readable after a recording changes.
- When either recording changes, the new reports no longer replace the old ones. Each version has its own row in the history, newest first, with its own four reports: Polar H10, D2, Combined and Comparison. Older rows open the reports as they were at that version.
- Deleting a recording no longer removes its reports: they wait until it is restored from the Recovery centre. They go only when a recording is deleted permanently.

## 4 Nov 2026 – v1.16.1 – Combined and comparison reports are generated automatically *(GitHub)*
Why: the reports should be ready as soon as both recordings are there, and stay right when either changes.
- The combined and comparison reports are generated and saved as soon as a Polar H10 recording and the watch's sleep match: after a recording stops, after a watch download, after a sync from another device, and when the app opens.
- If either recording changes they are generated again, and the report says when and which recording changed. If either is deleted, the saved reports go too; restoring it generates them again.
- Nothing is generated while a sleep recording is running, so the recording isn't held up; that happens when it stops.
- The saved reports stay on each device and aren't in backups, because each device can make them from the synced recordings. This needs a small storage update: close any other open tabs of the app after updating.
- The D2 Link download choice "Last night" is now "Last 1 day".

## 4 Nov 2026 – v1.16.0 – Synchronised Sleep Tracking and four sleep reports *(GitHub)*
Why: one sleep measured by two devices can show where they differ, and what to do about it.
- New pages Synchronised Sleep Tracking and Synchronised Sleep Tracking History, at the end of Polar H10 + Watch D2.
- Recordings from the Polar H10 and the Watch D2 that overlap for at least half of the shorter one count as one sleep, including sleep recorded earlier.
- Each sleep has four reports: Polar H10, D2, Combined (the two merged minute by minute) and Comparison (agreement, differences side by side, where the stages differ, and how to improve accuracy).
- Every report links to the ECG saved with that sleep. The Polar H10 and D2 reports now also show any ECG saved during the sleep when opened from their own history pages.
- Watch naps now open as a D2 report from this history.

## 4 Nov 2026 – v1.15.8 – Sleep reports use the same reference ranges *(GitHub)*
Why: one night should get the same verdict whichever report shows it.
- The Sleep history report now uses D2 Link's references: times woke up 0–1, night sleep 6–10 h, light sleep under 55 %, deep sleep 20–60 %, REM 10–30 %. "About these numbers" says where they come from.
- The sleep score is calculated as before.

## 4 Nov 2026 – v1.15.7 – Sleep report laid out like the D2 Link report *(GitHub)*
Why: the same kind of report should read the same way, whichever device recorded the sleep.
- The Sleep history report now follows the D2 Link report: date with ‹ and › to step through your sleep, sleep time with the stage chart, a score card with stars, times woke up and the stage ring, tiles in the same order and style, then a "More from the strap" card.
- A night's report lists any naps that day. Naps still have no score.
- Tile names now match: Breathing quality and Avg respiratory rate. The heart rate and breathing graphs, ECG results and reference ranges stay as they were.

## 4 Nov 2026 – v1.15.6 – Every sleep recording saves its ECG *(GitHub)*
Why: Sleep monitor shows the ECG live, but "Start sleep recording" threw it away, so the ECG of those sessions was lost.
- Sleep monitor now has one button, Start sleep & ECG recording. Each recording of 10 minutes or more saves its ECG in ECG history, linked both ways to its sleep report ("Open sleep report" and "Open full ECG report").
- If the ECG stream isn't running on the connection, sleep is still recorded, without ECG.

## 4 Nov 2026 – v1.15.5 – Same labels across tables and histories; naps are not scored *(GitHub)*
Why: the same thing should have the same name everywhere, with ECG history as the reference.
- Naps have no score at all: none in Sleep history, no score card in the report and none in the JSON export. This replaces the nap score of v1.15.4.
- Tables now use "Date and time" and "Duration" (the Recovery centre, D2 Link and Synchronised Tracking History), with dates written as in ECG history. Activity keeps "Day", as each row is a whole day.
- Sleep history and the D2 Link nights list start with the date and time, as ECG history does, followed by a Night or Nap tag, with the duration at the end of the line.
- Recovery centre categories are now ECG recordings, Sleep, Watch D2 sleep, Watch D2 data, Synchronised tracking and D2 Link download history.
- Anything that includes naps says "sleep" instead of "nights": the D2 Link history tab, its heading and export, and the backup counts. Night-only views, such as Week and Month, still say nights.
- A deleted watch nap is now called a nap in the Recovery centre, and deleting one says it can be restored there.

## 4 Nov 2026 – v1.15.4 – Naps have their own score *(GitHub)*
Why: the sleep score expects 7–9 hours, so it marks every nap down for being short.
- A nap is now scored only on sleep efficiency and awakenings. Its length doesn't count, and neither do deep sleep and REM, which a short nap rarely reaches.
- The nap's report says "Good nap" and so on, and "How the score works" explains the nap score. Nights are scored as before.

## 4 Nov 2026 – v1.15.3 – Day-time sleep is labelled as a nap *(GitHub)*
Why: a recording made in the day is not a night's sleep.
- Sleep history now says "Nap of 4 Nov 2026" when the middle of the recording falls between 08:00 and 20:00. The sleep report, delete messages and Recovery centre use the same word.
- A nap's report has no 7–9 h reference, shows "Scored as a full night" instead of a verdict like "Poor night", and is compared only with earlier naps. Nights are compared only with nights, so naps no longer shift their personal ranges or the "times woke up" chart.

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
