// The top bar's controls, as in Portfolio Optimizer: sync status and "Sync now", Search (⌘K / Ctrl+K) to jump to a page,
// and the Account menu (who is signed in, layout, theme, log out, reset this account's data).

import { make } from './ui';
import { loadSettings, type UserNumber } from './store';

export type Theme = 'auto' | 'light' | 'dark';
export type Layout = 'desktop' | 'mobile';

const THEME_KEY = 'openbeat-theme', LAYOUT_KEY = 'openbeat-layout';
const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* not kept */ } };

export function loadTheme(): Theme { const v = read(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'auto'; }
export function loadLayout(): Layout { return read(LAYOUT_KEY) === 'mobile' ? 'mobile' : 'desktop'; }

/** Auto follows the device; Light and Dark override it (the styles read data-theme on <html>). */
export function applyTheme(t: Theme): void {
  if (t === 'auto') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = t;
}
/** Mobile: the compact layout (pages in a bar at the top) on any screen. */
export function applyLayout(l: Layout): void { document.body.classList.toggle('view-mobile', l === 'mobile'); }

/** Page matching for Search: every word must appear in the page's name or keywords. */
export function matches(query: string, text: string): boolean {
  const t = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w));
}

const KEYWORDS: Readonly<Record<string, string>> = {
  live: 'record polar h10 strap heart rate hrv', history: 'recordings report edf export trend trending graphs', sleep: 'night record overnight',
  sleepHistory: 'nights report', d2: 'watch pair download blood pressure bridge', d2History: 'watch nights week month graphs all data',
  sync: 'synchronised synchronized tracking polar watch blood pressure', syncHistory: 'synchronised synchronized tracking results',
  syncSleep: 'synchronised synchronized sleep tracking polar watch night', syncSleepHistory: 'synchronised synchronized sleep reports combined comparison nights naps',
  settings: 'settings biodata age height weight users notch alias',
  backups: 'sync backups backup restore export cloud compare overwrite account locate find lost device strap',
  recovery: 'recovery recover restore deleted undelete bin trash',
  about: 'about browsers requirements bluetooth backed up privacy storage memory space size disk usage',
};

export interface TopbarDeps {
  email: string;
  /** The current user's number, shown in the round badge. */
  user: () => number;
  signOut: () => void;
  /** Deletes this account's data on this device and in the cloud. */
  reset: () => Promise<void>;
}

export function initTopbar(deps: TopbarDeps): void {
  applyTheme(loadTheme());
  applyLayout(loadLayout());
  const bar = document.querySelector<HTMLElement>('.topbar-actions');
  if (!bar) return;

  // ---------- Search ----------
  const searchBtn = make('button', 'small topbar-search');
  searchBtn.type = 'button';
  searchBtn.title = 'Jump to a page (Ctrl+K or ⌘K)';
  searchBtn.setAttribute('aria-haspopup', 'dialog');
  searchBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  searchBtn.append(make('span', 'topbar-search-label', 'Search'), make('kbd', 'kbd', isMac ? '⌘K' : 'Ctrl K'));

  const palette = make('div', 'cmdk');
  palette.hidden = true;
  palette.setAttribute('role', 'dialog');
  palette.setAttribute('aria-label', 'Jump to a page');
  const box = make('div', 'cmdk-box');
  const input = make('input', 'cmdk-input');
  Object.assign(input, { type: 'search', placeholder: 'Jump to a page…', autocomplete: 'off', spellcheck: false });
  const results = make('ul', 'cmdk-list');
  results.setAttribute('role', 'listbox');
  box.append(input, results);
  palette.appendChild(box);
  document.body.appendChild(palette);
  let pick = 0;
  const pages = (): { view: string; label: string; group: string }[] => {
    let group = '';
    const out: { view: string; label: string; group: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.tabs > *')) {
      if (el.classList.contains('nav-group')) { group = el.textContent ?? ''; continue; }
      const view = el.dataset['view'];
      if (view) out.push({ view, label: el.textContent?.trim() ?? view, group });
    }
    return out;
  };
  const found = (): { view: string; label: string; group: string }[] => pages().filter((p) => matches(input.value, `${p.label} ${p.group} ${KEYWORDS[p.view] ?? ''}`));
  const render = (): void => {
    const list = found();
    pick = Math.min(pick, Math.max(0, list.length - 1));
    results.replaceChildren(...(list.length ? list.map((p, i) => {
      const li = make('li', i === pick ? 'cmdk-item on' : 'cmdk-item');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === pick));
      li.append(make('span', '', p.label), make('span', 'muted', p.group));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); go(p.view); });
      return li;
    }) : [make('li', 'cmdk-empty muted', 'No page matches.')]));
  };
  const open = (): void => { palette.hidden = false; input.value = ''; pick = 0; render(); input.focus(); };
  const close = (): void => { palette.hidden = true; searchBtn.focus(); };
  const go = (view: string): void => { close(); document.querySelector<HTMLButtonElement>(`.tabs button[data-view="${view}"]`)?.click(); };
  searchBtn.addEventListener('click', open);
  palette.addEventListener('mousedown', (e) => { if (e.target === palette) close(); });
  input.addEventListener('input', () => { pick = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const list = found();
    if (e.key === 'ArrowDown') { pick = Math.min(list.length - 1, pick + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { pick = Math.max(0, pick - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { const p = list[pick]; if (p) go(p.view); }
    else if (e.key === 'Escape') close();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (palette.hidden) open(); else close(); }
  });

  // ---------- Account menu ----------
  const wrap = make('div', 'acct-menu');
  const btn = make('button', 'acct-menu-btn');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Account, layout, theme and log out';
  /** The user number and alias, as on every row: "1:M". */
  const tag = (): string => { const u = deps.user(); const alias = loadSettings(u as UserNumber).alias; return `${u}${alias ? `:${alias}` : ''}`; };
  const avatar = make('span', 'acct-avatar', tag());
  avatar.setAttribute('aria-hidden', 'true');
  btn.append(avatar, make('span', 'acct-menu-label', 'Account'));
  btn.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>');
  const panel = make('div', 'acct-panel');
  panel.hidden = true;
  const who = make('div', 'acct-who');
  who.append(make('div', 'muted', 'Signed in as'), make('div', 'acct-email', deps.email));
  const seg = <T extends string>(title: string, choices: readonly (readonly [T, string, string])[], now: () => T, set: (v: T) => void): HTMLElement => {
    const g = make('div', 'acct-group');
    const head = make('div', 'acct-heading', title);
    const row = make('div', 'acct-seg');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', title);
    const buttons = choices.map(([v, label, tip]) => {
      const b = make('button', '', label);
      b.type = 'button';
      b.title = tip;
      b.addEventListener('click', () => { set(v); paint(); });
      return { v, b };
    });
    const paint = (): void => { for (const { v, b } of buttons) b.setAttribute('aria-pressed', String(v === now())); };
    paint();
    row.append(...buttons.map((x) => x.b));
    g.append(head, row);
    return g;
  };
  const layout = seg<Layout>('Layout', [['desktop', 'Desktop', 'Sidebar on wide screens; compact on narrow ones'], ['mobile', 'Mobile', 'Compact layout with the pages at the top, on any screen']],
    loadLayout, (v) => { write(LAYOUT_KEY, v); applyLayout(v); });
  const theme = seg<Theme>('Theme', [['auto', 'Auto', 'Follow this device’s light or dark setting'], ['light', 'Light', 'Always light'], ['dark', 'Dark', 'Always dark']],
    loadTheme, (v) => { write(THEME_KEY, v); applyTheme(v); });
  // the user (1–9): the same choice as on ECG live and in Settings, which it drives (and which can block it while recording)
  const userGroup = make('div', 'acct-group');
  const userSel = make('select', 'acct-user');
  userSel.setAttribute('aria-label', 'User');
  userGroup.append(make('div', 'acct-heading', 'User'), userSel);
  const appSelect = (): HTMLSelectElement | null => document.querySelector<HTMLSelectElement>('#userSelect');
  const fillUsers = (): void => {
    const src = appSelect();
    if (!src) { userGroup.hidden = true; return; }
    userSel.replaceChildren(...[...src.options].map((o) => { const c = make('option', '', o.textContent ?? ''); c.value = o.value; return c; }));
    userSel.value = src.value;
    userSel.disabled = src.disabled;
    userSel.title = src.title;
  };
  userSel.addEventListener('change', () => {
    const src = appSelect();
    if (!src) return;
    src.value = userSel.value;
    src.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => { fillUsers(); avatar.textContent = tag(); }, 0); // shows what the app accepted
  });
  const foot = make('div', 'acct-foot');
  const logOut = make('button', 'small acct-logout', 'Log Out');
  logOut.type = 'button';
  logOut.addEventListener('click', () => deps.signOut());
  const reset = make('button', 'acct-reset', 'Reset my account data');
  reset.type = 'button';
  reset.title = 'Deletes all of this account’s recordings, sleep, watch data, histories, settings and Recovery centre items – on this device and in the cloud';
  reset.addEventListener('click', () => void (async () => {
    const typed = window.prompt('This deletes ALL of this account’s data – every ECG recording, sleep recording, D2 Link record, history and setting – on this device AND in the cloud (so on your other devices too). It cannot be undone.\n\nTo confirm, type DELETE:');
    if (typed !== 'DELETE') { if (typed != null) window.alert('Not deleted: the word didn’t match.'); return; }
    reset.disabled = true;
    reset.textContent = 'Deleting…';
    try { await deps.reset(); window.alert('This account’s data was deleted. The app will now reload.'); location.reload(); }
    catch (e) { window.alert(`The reset didn’t finish: ${e instanceof Error ? e.message : String(e)}`); reset.disabled = false; reset.textContent = 'Reset my account data'; }
  })());
  foot.append(logOut, reset);
  panel.append(who, userGroup, layout, theme, foot);
  wrap.append(btn, panel);
  const setOpen = (o: boolean): void => { panel.hidden = !o; btn.setAttribute('aria-expanded', String(o)); if (o) { avatar.textContent = tag(); fillUsers(); } };
  btn.addEventListener('click', () => setOpen(panel.hidden));
  document.addEventListener('mousedown', (e) => { if (!panel.hidden && !wrap.contains(e.target as Node)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); } });
  // the badge follows the user chosen in ECG live or Settings
  document.addEventListener('change', (e) => { const el = e.target as HTMLInputElement; if (el.id?.toLowerCase().includes('userselect') || el.name === 'alias') setTimeout(() => { avatar.textContent = tag(); }, 0); });

  bar.append(searchBtn, wrap);
}
