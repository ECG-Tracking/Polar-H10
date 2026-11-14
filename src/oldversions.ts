// Moves report versions replaced more than a week ago to the Recovery centre, and deletes them from there for good after
// four weeks (see versions.ts). Runs when the app starts and every day while it stays open.

import * as store from './store';
import { VERSION_BIN_MS, dueVersions } from './versions';

const DAY_MS = 24 * 3600 * 1000;

/** One pass over this device's synchronised sleep and tracking histories; returns how many versions moved and were deleted. */
export async function tidyVersions(now = Date.now()): Promise<{ moved: number; purged: number }> {
  let moved = 0, purged = 0;
  for (const r of await store.listAllSleepReports()) {
    const { past = [], retired: _r, kept: _k, ...latest } = r;
    const due = dueVersions([...past, latest], r, now);
    if (!due.length) continue;
    for (const v of due) await store.binVersion('sleep-reports', r.id, r.user, r.start, v, r.nap);
    const gone = new Set(due.map((v) => v.generatedAt));
    const left = past.filter((v) => !gone.has(v.generatedAt));
    const { past: _p, ...rest } = r;
    await store.saveSleepReports({ ...rest, ...(left.length ? { past: left } : {}), retired: [...new Set([...(r.retired ?? []), ...gone])].sort((a, b) => a - b) });
    moved += due.length;
  }
  const entries = new Map(store.loadSyncHistory().map((e) => [e.id, e]));
  for (const t of await store.listSyncTraces()) {
    const due = dueVersions(t.reports ?? [], t, now);
    const e = entries.get(t.id);
    if (!due.length || !e) continue;
    for (const v of due) await store.binVersion('tracking', t.id, e.user, e.start, v);
    const gone = new Set(due.map((v) => v.generatedAt));
    await store.saveSyncTrace({ ...t, reports: (t.reports ?? []).filter((v) => !gone.has(v.generatedAt)), retired: [...new Set([...(t.retired ?? []), ...gone])].sort((a, b) => a - b) });
    store.saveSyncEntry(e); // the cloud copy is updated at the next sync
    moved += due.length;
  }
  for (const i of await store.listBin()) {
    if (i.kind === 'version' && now - i.deletedAt > VERSION_BIN_MS) { await store.purgeBin(i.id); purged++; }
  }
  return { moved, purged };
}

/** Moves one older version of a tracking's or a sleep's reports to the Recovery centre now (its row's ×). The latest stays. */
export async function retireVersion(of: 'tracking' | 'sleep-reports', id: string, generatedAt: number): Promise<void> {
  if (of === 'sleep-reports') {
    const r = await store.loadSleepReports(id);
    const v = r?.past?.find((x) => x.generatedAt === generatedAt);
    if (!r || !v) return;
    await store.binVersion('sleep-reports', r.id, r.user, r.start, v, r.nap);
    const left = (r.past ?? []).filter((x) => x.generatedAt !== generatedAt);
    const { past: _p, ...rest } = r;
    await store.saveSleepReports({ ...rest, ...(left.length ? { past: left } : {}), retired: [...new Set([...(r.retired ?? []), generatedAt])].sort((a, b) => a - b), kept: (r.kept ?? []).filter((x) => x !== generatedAt) });
    return;
  }
  const t = await store.loadSyncTrace(id), e = store.loadSyncHistory().find((x) => x.id === id);
  const reports = t?.reports ?? [];
  const v = reports.find((x) => x.generatedAt === generatedAt);
  if (!t || !e || !v || v === reports[reports.length - 1]) return;
  await store.binVersion('tracking', t.id, e.user, e.start, v);
  await store.saveSyncTrace({ ...t, reports: reports.filter((x) => x !== v), retired: [...new Set([...(t.retired ?? []), generatedAt])].sort((a, b) => a - b), kept: (t.kept ?? []).filter((x) => x !== generatedAt) });
  store.saveSyncEntry(e); // the cloud copy is updated at the next sync
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Tidies now and then every day; `changed` runs when anything moved, so open lists are drawn again. */
export function startVersionTidying(changed: () => void): void {
  const run = (): void => { void tidyVersions().then((n) => { if (n.moved || n.purged) changed(); }).catch(() => { /* tried again tomorrow */ }); };
  if (timer) clearInterval(timer);
  timer = setInterval(run, DAY_MS);
  run();
}
