// The Recovery centre page: everything deleted on this device, kept until it is deleted permanently, as in the other app's
// Recovery centre. Each item can be put back (it then syncs to the other devices again) or deleted for good.

import { current, historyChanged, supabase } from './account';
import { isNap } from './sleep';
import * as store from './store';
import type { BinItem } from './store';
import { deleteButton, frontDeletes, make } from './ui';
import { errorMessage } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js

/** The groups on the page, in the order of the sidebar, with the columns each one's original table has. */
const GROUPS = [
  { name: 'ECG recordings', length: true, detail: 'Details' },
  { name: 'Sleep', length: true, detail: '' },
  { name: 'Watch D2 sleep', length: true, detail: '' },
  { name: 'Watch D2 data', length: false, detail: 'Kind' },
  { name: 'Synchronised ECG tracking', length: true, detail: '' },
  { name: 'D2 Link download history', length: false, detail: 'Result' },
  { name: 'Older report versions', length: false, detail: 'Version' },
] as const;
export type Category = (typeof GROUPS)[number]['name'];

export type SortKey = 'recorded' | 'length' | 'detail' | 'deletedAt' | 'elsewhere' | 'size';
export interface SortOrder { key: SortKey; direction: 1 | -1 }

const PAGE_SIZE = 50;
/** As in the original tables: the newest recording first. */
const DEFAULT_SORT: SortOrder = { key: 'recorded', direction: -1 };
// kept while the page is drawn again after each action, as in the other app
const openGroups = new Set<Category>();
const groupPages = new Map<Category, number>();
const groupSort = new Map<Category, SortOrder>();

export interface RecoveryItem {
  id: string;
  category: Category;
  user: number;
  /** When it was recorded (a download: when it ran), ms since 1970. */
  recorded: number;
  deletedAt: number;
  what: string;
  /** Seconds; null if it has no length. */
  length: number | null;
  detail: string;
  size: number;
  elsewhere: boolean;
  from: 'app' | 'd2';
}

const dateTime = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const formatLength = (s: number | null): string => (s == null ? '--' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function describe(item: BinItem): RecoveryItem {
  const base = { id: item.id, user: item.user, deletedAt: item.deletedAt, size: item.size, elsewhere: item.elsewhere === true, from: 'app' as const };
  if (item.kind === 'ecg') {
    return { ...base, category: 'ECG recordings', what: 'ECG recording', recorded: item.session.start, length: item.session.durationS, detail: [item.session.alias, item.session.cloudOnly ? 'summary copy' : ''].filter(Boolean).join(' · ') };
  }
  if (item.kind === 'sleep') return { ...base, category: 'Sleep', what: isNap(item.session.start, item.session.durationS) ? 'Nap' : 'Sleep night', recorded: item.session.start, length: item.session.durationS, detail: '' };
  if (item.kind === 'version') {
    const what = item.of === 'tracking' ? 'Synchronised ECG tracking reports' : `Synchronised sleep reports · ${item.nap ? 'Nap' : 'Night'}`;
    return { ...base, category: 'Older report versions', what, recorded: item.start, length: null, detail: `Made ${dateTime(item.version.generatedAt)}` };
  }
  return { ...base, category: 'Synchronised ECG tracking', what: 'Synchronised ECG tracking', recorded: item.entry.start, length: item.entry.durationS, detail: '' };
}

/** Sorts by one column (items without a length go last); equal rows keep the most recently deleted first. */
export function sortItems(items: readonly RecoveryItem[], { key, direction }: SortOrder): RecoveryItem[] {
  const value = (i: RecoveryItem): number | string => (key === 'elsewhere' ? Number(i.elsewhere) : i[key] ?? -1);
  return [...items].sort((a, b) => {
    const x = value(a), y = value(b);
    const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y;
    return c * direction || b.deletedAt - a.deletedAt;
  });
}

export interface RecoveryDeps { loadD2: () => Promise<D2Api>; user: () => number }

/** Shows the page; called each time it is opened, as items are added from everywhere in the app. */
export async function renderRecovery(root: HTMLElement, deps: RecoveryDeps): Promise<void> {
  const account = current.account?.id ?? 'local';
  const d2 = await deps.loadD2().catch(() => null);
  const redo = (): Promise<void> => renderRecovery(root, deps);

  const syncD2 = (): void => {
    const a = current.account;
    if (d2 && a && !a.offline) void d2.backup.syncD2(a.id, supabase() as unknown as Parameters<D2Api['backup']['syncD2']>[1]).catch(() => { /* it syncs next time */ });
  };

  const all: RecoveryItem[] = [
    ...(await store.listBin()).map(describe),
    ...(d2 ? (await d2.recovery.list(account)).map((r) => ({ ...r, from: 'd2' as const })) : []),
  ];
  const items = all.filter((i) => i.user === deps.user());
  const used = all.reduce((s, i) => s + i.size, 0);

  const card = make('div', 'card backup-card');
  card.appendChild(make('p', 'note', 'Older versions of synchronised ECG tracking and synchronised sleep reports move here a week after a newer version replaced them, and are deleted for good after four more weeks here. Restore puts a version back in its history to stay.'));
  card.appendChild(make('p', '', 'Everything you delete stays here, on this device, until you delete it permanently. Restore puts it back where it was and syncs it to your other devices again. Backup Account includes them, so a large Recovery centre makes a larger backup file.'));
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const device = estimate?.usage && estimate.quota ? ` The app uses ${formatSize(estimate.usage)} of the ${formatSize(estimate.quota)} this browser allows.` : '';
  card.appendChild(make('p', 'note', `Storage used by deleted items: ${formatSize(used)} on this device (all users).${device}`));
  const skipped = store.binSkipped();
  if (skipped) card.appendChild(make('p', 'note', `${skipped} deleted item${skipped === 1 ? ' was' : 's were'} not kept because this device’s storage was full.`));
  const status = make('p', 'note backup-status');
  card.appendChild(status);

  const act = async (doing: string, fn: () => Promise<void>): Promise<void> => {
    status.textContent = `${doing}…`;
    try { await fn(); await redo(); } catch (e) { status.textContent = `${doing} didn’t finish: ${errorMessage(e)}.`; }
  };

  const restoreButton = (i: RecoveryItem): HTMLButtonElement => {
    const b = make('button', 'primary recovery-restore', 'Restore');
    b.type = 'button';
    b.addEventListener('click', () => void act('Restoring', async () => {
      if (i.from === 'd2') { await d2?.recovery.restore(account, i.id); syncD2(); }
      else { await store.restoreBin(i.id); historyChanged(); }
    }));
    return b;
  };
  const purgeButton = (i: RecoveryItem): HTMLButtonElement => deleteButton('this item permanently', () => act('Deleting', async () => {
    if (i.from === 'd2') await d2?.recovery.purge(account, i.id);
    else await store.purgeBin(i.id);
  }), `Delete “${i.what}” permanently? This cannot be undone.`);

  // one collapsible table per category, as in the other app, 50 rows to a page; the headers sort, as in both other apps
  for (const g of GROUPS) {
    const category = g.name;
    const sort = groupSort.get(category) ?? DEFAULT_SORT;
    const inGroup = sortItems(items.filter((i) => i.category === category), sort);
    const group = make('details', 'recovery-group');
    group.open = openGroups.has(category);
    group.addEventListener('toggle', () => { if (group.open) openGroups.add(category); else openGroups.delete(category); });
    group.appendChild(make('summary', '', `${category} · ${inGroup.length} item${inGroup.length === 1 ? '' : 's'}`));
    card.appendChild(group);
    if (!inGroup.length) { group.appendChild(make('p', 'muted', 'Nothing deleted here.')); continue; }

    const pages = Math.ceil(inGroup.length / PAGE_SIZE);
    const page = Math.min(groupPages.get(category) ?? 0, pages - 1);
    if (pages > 1) {
      const pager = make('div', 'row recovery-pager');
      for (const [label, step] of [['Previous', -1], ['Next', 1]] as const) {
        const b = make('button', '', label);
        b.type = 'button';
        b.disabled = page + step < 0 || page + step >= pages;
        b.addEventListener('click', () => { groupPages.set(category, page + step); void redo(); });
        pager.appendChild(b);
      }
      pager.appendChild(make('span', 'note', `Page ${page + 1} of ${pages}`));
      group.appendChild(pager);
    }

    const columns: { key: SortKey; label: string; text: (i: RecoveryItem) => string }[] = [
      { key: 'recorded', label: 'Date and time', text: (i) => dateTime(i.recorded) },
      ...(g.length ? [{ key: 'length' as const, label: 'Duration', text: (i: RecoveryItem) => formatLength(i.length) }] : []),
      ...(g.detail ? [{ key: 'detail' as const, label: g.detail, text: (i: RecoveryItem) => i.detail }] : []),
      { key: 'deletedAt', label: 'Deleted', text: (i) => dateTime(i.deletedAt) },
      { key: 'elsewhere', label: 'Deleted on', text: (i) => (i.elsewhere ? 'Another device' : 'This device') },
      { key: 'size', label: 'Size', text: (i) => formatSize(i.size) },
    ];
    const wrap = make('div', 'd2-table-wrap');
    const table = make('table', 'd2-table recovery-table');
    const hr = make('tr');
    hr.append(make('th', 'del-col del-front'), make('th'));
    for (const c of columns) {
      const th = make('th');
      th.scope = 'col';
      const sorted = sort.key === c.key;
      th.setAttribute('aria-sort', sorted ? (sort.direction < 0 ? 'descending' : 'ascending') : 'none');
      const b = make('button', sorted ? 'sort-head sorted' : 'sort-head', `${c.label} ${sorted ? (sort.direction < 0 ? '▼' : '▲') : '↕'}`);
      b.type = 'button';
      b.title = `Sort by ${c.label.toLowerCase()}`;
      b.addEventListener('click', () => {
        groupSort.set(category, { key: c.key, direction: sorted ? (sort.direction < 0 ? 1 : -1) : -1 });
        groupPages.set(category, 0);
        void redo();
      });
      th.appendChild(b);
      hr.appendChild(th);
    }
    hr.appendChild(make('th', 'del-col'));
    table.appendChild(make('thead')).appendChild(hr);
    const body = make('tbody');
    for (const i of inGroup.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const tr = make('tr');
      const front = make('td', 'del-col del-front');
      front.appendChild(purgeButton(i));
      const restore = make('td');
      restore.appendChild(restoreButton(i));
      tr.append(front, restore);
      for (const c of columns) tr.appendChild(make('td', '', c.text(i)));
      const end = make('td', 'del-col');
      end.appendChild(purgeButton(i));
      tr.appendChild(end);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    frontDeletes(wrap);
    group.appendChild(wrap);
  }
  root.replaceChildren(card);
}
