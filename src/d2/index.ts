// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — entry point of d2link.js, a separate script that OpenBeat ECG loads when the D2 Link tab is opened.
// D2 Link is open source (GNU AGPL v3 or later) because it is built on Gadgetbridge's watch protocol work
// (https://codeberg.org/Freeyourgadget/Gadgetbridge), © Gadgetbridge contributors. Port © 2026 ECG-Tracking.
// Full licence: LICENSE-D2-LINK.txt. Source: the src/d2 folder of https://github.com/ECG-Tracking/Polar-H10

import { exportD2, importD2, localD2Ids, markD2Unsynced, storedBloodPressure, syncD2 } from './backup';
import { connectLive, type LiveOptions, type LiveWatch } from './live';
import { mount, type D2Deps } from './ui';
import { onWatch, type OpenWatch } from './watch';

/** What d2link.js offers the app: the D2 Link page, and the watch live for synchronised tracking. */
export interface D2Api {
  mount: (root: HTMLElement, deps: D2Deps) => { refresh: () => void };
  connectLive: (o: LiveOptions) => Promise<LiveWatch>;
  /** `fn` runs now and whenever the shared watch connection connects or ends. */
  onWatch: (fn: (w: OpenWatch | null) => void) => void;
  /** Backup, restore and sync on request (the app's Sync & backups page). */
  backup: { exportD2: typeof exportD2; importD2: typeof importD2; localD2Ids: typeof localD2Ids; markD2Unsynced: typeof markD2Unsynced; syncD2: typeof syncD2; storedBloodPressure: typeof storedBloodPressure };
}

declare global {
  interface Window { OpenBeatD2?: D2Api }
}

window.OpenBeatD2 = { mount, connectLive, onWatch, backup: { exportD2, importD2, localD2Ids, markD2Unsynced, syncD2, storedBloodPressure } };
