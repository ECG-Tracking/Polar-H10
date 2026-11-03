// The Recovery centre page: everything deleted on this device, kept until it is deleted permanently, as in the other app's
// Recovery centre. Each item can be put back (it then syncs to the other devices again) or deleted for good.

import { current, historyChanged, supabase } from './account';
import * as store from './store';
import type { BinItem } from './store';
import { make } from './ui';
import { errorMessage } from './util';
import type { D2Api } from './d2/index'; // type only: D2 Link's code stays in d2link.js

/** The groups on the page, in the order of the sidebar. */
export const CATEGORIES = ['ECG recordings', 'Sleep nights', 'Watch D2 nights', 'Watch D2 data', 'Synchronised tracking', 'D2 Link download history'] as const;
export type Category = (typeof CATEGORIES)[number];

const PAGE_SIZE = 50;
// kept while the page is drawn again after each action, as in the other app
const openGroups = new Set<Category>();
const groupPages = new Map<Category, number>();

export interface RecoveryItem {
  id: string;
  category: Category;
  user: number;
  deletedAt: number;
  what: string;
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

export function describe(item: BinItem): RecoveryItem {
  const base = { id: item.id, user: item.user, deletedAt: item.deletedAt, size: item.size, elsewhere: item.elsewhere === true, from: 'app' as const };
  if (item.kind === 'ecg') {
    return { ...base, category: 'ECG recordings', what: 'ECG recording', detail: [dateTime(item.session.start), `${Math.round(item.session.durationS / 60)} min`, item.session.alias, item.session.cloudOnly ? 'summary copy' : ''].filter(Boolean).join(' · ') };
  }
  if (item.kind === 'sleep') return { ...base, category: 'Sleep nights', what: 'Sleep night', detail: `${dateTime(item.session.start)} · ${(item.session.durationS / 3600).toFixed(1)} h` };
  return { ...base, category: 'Synchronised tracking', what: 'Synchronised tracking', detail: `${dateTime(item.entry.start)} · ${Math.round(item.entry.durationS / 60)} min` };
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
  const items = all.filter((i) => i.user === deps.user()).sort((a, b) => b.deletedAt - a.deletedAt);
  const used = all.reduce((s, i) => s + i.size, 0);

  const card = make('div', 'card backup-card');
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

  const row = (i: RecoveryItem): HTMLLIElement => {
    const li = make('li');
    const text = make('div', 'recovery-text');
    text.append(make('strong', '', i.what), make('span', 'recovery-detail', i.detail),
      make('span', 'recovery-when', `Deleted ${dateTime(i.deletedAt)}${i.elsewhere ? ' on another device' : ''} · ${formatSize(i.size)}`));
    const restore = make('button', 'primary', 'Restore');
    restore.type = 'button';
    restore.addEventListener('click', () => void act('Restoring', async () => {
      if (i.from === 'd2') { await d2?.recovery.restore(account, i.id); syncD2(); }
      else { await store.restoreBin(i.id); historyChanged(); }
    }));
    const purge = make('button', 'recovery-purge', 'Delete permanently');
    purge.type = 'button';
    purge.addEventListener('click', () => {
      if (!window.confirm(`Delete “${i.what}” permanently? This cannot be undone.`)) return;
      void act('Deleting', async () => {
        if (i.from === 'd2') await d2?.recovery.purge(account, i.id);
        else await store.purgeBin(i.id);
      });
    });
    const buttons = make('div', 'recovery-actions');
    buttons.append(restore, purge);
    li.append(text, buttons);
    return li;
  };

  // one collapsible group per category, as in the other app, 50 rows to a page
  for (const category of CATEGORIES) {
    const inGroup = items.filter((i) => i.category === category);
    const group = make('details', 'recovery-group');
    group.open = openGroups.has(category);
    group.addEventListener('toggle', () => { if (group.open) openGroups.add(category); else openGroups.delete(category); });
    group.appendChild(make('summary', '', `${category} · ${inGroup.length} item${inGroup.length === 1 ? '' : 's'}`));
    const pages = Math.max(1, Math.ceil(inGroup.length / PAGE_SIZE));
    const page = Math.min(groupPages.get(category) ?? 0, pages - 1);
    if (!inGroup.length) group.appendChild(make('p', 'muted', 'Nothing deleted here.'));
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
    if (inGroup.length) {
      const list = make('ul', 'recovery-list');
      for (const i of inGroup.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) list.appendChild(row(i));
      group.appendChild(list);
    }
    card.appendChild(group);
  }
  root.replaceChildren(card);
}
